import { assertSafeExactMatch } from '../helpers.js';
import { errUsage, errAuth } from '../errors.js';

const namePattern = /^[a-zA-Z0-9_]+$/;
const raw = value => String(value && typeof value === 'object' ? value.value ?? '' : value ?? '');
const field = (record, name) => raw(record?.[name]);
const position = row => Number(field(row, 'position')) || 0;
const ordered = rows => [...rows].sort((a, b) => position(a) - position(b));
const reference = value => {
  const text = raw(value);
  assertSafeExactMatch(text);
  return text;
};
const isName = value => typeof value === 'string' && namePattern.test(value);
const chunks = values => Array.from({ length: Math.ceil(values.length / 100) }, (_, index) => values.slice(index * 100, (index + 1) * 100));

function request(table, query, fields, limit = 1000) {
  return { table, params: new URLSearchParams({
    sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit),
    sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true',
  }) };
}

/** Invocation-scoped, SDK-bound metadata reader. No persistence across users. */
export function createRecordMetadataReader(sdk, { limit = 1000, maxDepth = 32 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw errUsage('Metadata limit must be an integer from 1 to 10000');
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) throw errUsage('Metadata inheritance depth must be an integer from 1 to 100');
  const cache = new Map();
  const reports = new Map();

  async function reads(specs, warnings) {
    const missing = specs.filter(spec => !cache.has(`${spec.table}?${spec.params}`));
    // Reserve promises before transport so concurrent metadata requests share
    // both successful reads and observed failures within this reader only.
    const unique = [...new Map(missing.map(spec => [`${spec.table}?${spec.params}`, spec])).values()];
    if (unique.length) {
      const pending = (async () => {
        if (unique.length > 1 && typeof sdk.batch === 'function') {
          try {
            const batch = await sdk.batch(unique.map((spec, index) => ({
              id: `metadata-${index}`, method: 'GET', url: `/api/now/table/${spec.table}?${spec.params}`,
            })), { fallback: true });
            return unique.map((spec, index) => {
              const item = batch.results?.find(result => result.id === `metadata-${index}`);
              if (item?.status === 401) throw errAuth('Authentication failed while reading metadata');
              if (!item?.ok) return { rows: [], error: item?.error?.message || `Metadata read failed (${item?.status || 'unknown status'})` };
              return normalize(item.data?.result, spec);
            });
          } catch (error) {
            if (error.code === 'auth_error' || error.status === 401) throw error;
            // The batch provider owns unsupported-endpoint fallback. Never
            // replay authentication/ACL/server failures through another path.
            return unique.map(() => ({ rows: [], error: error.message || 'Metadata batch failed' }));
          }
        }
        return Promise.all(unique.map(async spec => {
          try { return normalize(await sdk.list(spec.table, spec.params), spec); }
          catch (error) {
            if (error.code === 'auth_error' || error.status === 401) throw error;
            return { rows: [], error: error.message || 'Metadata read failed' };
          }
        }));
      })();
      unique.forEach((spec, index) => cache.set(`${spec.table}?${spec.params}`, pending.then(results => results[index])));
    }
    return Promise.all(specs.map(async spec => {
      const result = await cache.get(`${spec.table}?${spec.params}`);
      if (result.error) warnings.push({ source: spec.table, reason: result.error });
      if (result.truncated) warnings.push({ source: spec.table, reason: `Metadata limit ${spec.params.get('sysparm_limit')} reached; results may be incomplete` });
      return result.rows;
    }));
  }

  function normalize(rows, spec) {
    if (!Array.isArray(rows)) return { rows: [], error: 'Metadata response was not an array' };
    return { rows, truncated: rows.length >= Number(spec.params.get('sysparm_limit')) };
  }

  async function read({ table, view = 'Default view' }) {
    if (!isName(table)) throw errUsage('Metadata table must be a table name containing letters, numbers or underscores');
    if (typeof view !== 'string' || !view) throw errUsage('Metadata view must be a nonempty name, title or sys_id');
    assertSafeExactMatch(view);
    const key = `${table}\0${view}`;
    if (!reports.has(key)) reports.set(key, load(table, view));
    // Protect cached objects from a consumer attaching record-specific hints.
    return structuredClone(await reports.get(key));
  }

  async function load(table, view) {
    const warnings = [];
    const hierarchy = [];
    const visited = new Set();
    let next = request('sys_db_object', `name=${table}`, 'sys_id,name,super_class', 2);
    for (let depth = 0; next && depth < maxDepth; depth++) {
      const [rows] = await reads([next], warnings);
      if (rows.length !== 1) {
        warnings.push({ source: 'sys_db_object', reason: `Expected one visible table definition, found ${rows.length}; inheritance coverage is incomplete` });
        break;
      }
      const row = rows[0];
      const name = field(row, 'name');
      const id = field(row, 'sys_id');
      if (!isName(name) || visited.has(name)) {
        warnings.push({ source: 'sys_db_object', reason: 'Invalid or cyclic table inheritance metadata' });
        break;
      }
      visited.add(name);
      hierarchy.push({ name, sys_id: id });
      if (!Object.hasOwn(row, 'super_class')) warnings.push({ source: 'sys_db_object', reason: 'Parent metadata is not visible; inheritance coverage is incomplete' });
      const parent = reference(row.super_class);
      next = parent ? request('sys_db_object', `sys_id=${parent}`, 'sys_id,name,super_class', 2) : null;
    }
    if (next && hierarchy.length === maxDepth) warnings.push({ source: 'sys_db_object', reason: `Inheritance depth limit ${maxDepth} reached` });
    if (!hierarchy.length) hierarchy.push({ name: table, sys_id: '' });
    const names = hierarchy.map(item => item.name);
    const defaultView = view === 'Default view' || view === 'default';
    const viewQuery = defaultView ? 'name=^ORname=default^ORtitle=Default view' : `name=${view}^ORtitle=${view}^ORsys_id=${view}`;
    const [views] = await reads([request('sys_ui_view', `${viewQuery}^userISEMPTY`, 'sys_id,name,title', limit)], warnings);
    const byId = views.filter(row => field(row, 'sys_id') === view);
    const byName = views.filter(row => field(row, 'name') === (defaultView ? '' : view));
    const byTitle = views.filter(row => field(row, 'title') === view);
    const byAlias = defaultView ? views.filter(row => field(row, 'name') === 'default') : [];
    const candidates = byId.length ? byId : byName.length ? byName : byTitle.length ? byTitle : byAlias;
    let viewId = '';
    const viewCapped = views.length >= limit;
    if (candidates.length === 1 && !viewCapped) {
      viewId = reference(candidates[0].sys_id);
      if (!viewId) warnings.push({ source: 'sys_ui_view', reason: 'View id is absent or not visible' });
    } else if (candidates.length > 1 || viewCapped) warnings.push({ source: 'sys_ui_view', reason: 'View lookup is ambiguous or capped; no layout was selected' });
    else if (!defaultView) warnings.push({ source: 'sys_ui_view', reason: 'Requested view is absent or not visible; no layout was selected' });
    const canReadLayout = !viewCapped && candidates.length <= 1 && (defaultView || !!viewId);
    const viewFilter = viewId ? `view=${viewId}${defaultView ? '^ORviewISEMPTY' : ''}` : 'viewISEMPTY';
    const specs = [
      request('sys_dictionary', `referenceIN${names.join(',')}^elementISNOTEMPTY`, 'sys_id,name,element,reference,column_label', limit),
      request('sys_relationship', `basic_apply_toIN${names.join(',')}`, 'sys_id,name,basic_apply_to,basic_query_from,reference_field,simple_reference,advanced,query_with', limit),
      ...(canReadLayout ? [
        request('sys_ui_form', `nameIN${names.join(',')}^${viewFilter}^sys_userISEMPTY`, 'sys_id,name,view', limit),
        request('sys_ui_related_list', `nameIN${names.join(',')}^${viewFilter}^sys_userISEMPTY`, 'sys_id,name,view', limit),
      ] : []),
    ];
    const [dictionary, relationships, forms = [], containers = []] = await reads(specs, warnings);
    const nearest = rows => {
      for (const name of names) {
        const candidates = rows.filter(row => field(row, 'name') === name);
        const exact = viewId ? candidates.filter(row => field(row, 'view') === viewId) : [];
        const preferred = exact.length ? exact : candidates;
        if (preferred.length > 1) warnings.push({ source: 'layout', reason: `Ambiguous layout for ${name}; no layout was selected` });
        if (preferred.length) {
          if (!field(preferred[0], 'sys_id')) {
            warnings.push({ source: 'layout', reason: `Layout id is absent or not visible for ${name}` });
            return null;
          }
          return preferred.length === 1 ? preferred[0] : null;
        }
      }
      return null;
    };
    const form = nearest(forms);
    const container = nearest(containers);
    const detailSpecs = [
      ...(form ? [request('sys_ui_form_section', `sys_ui_form=${reference(form.sys_id)}^ORDERBYposition`, 'sys_id,sys_ui_form,sys_ui_section,position', limit)] : []),
      ...(container ? [request('sys_ui_related_list_entry', `list_id=${reference(container.sys_id)}^ORDERBYposition`, 'sys_id,related_list,position,filter,order_by', limit)] : []),
    ];
    const details = await reads(detailSpecs, warnings);
    const links = form ? details.shift() : [];
    const entries = container ? details.shift() : [];
    const sectionIds = [...new Set(links.map(link => reference(link.sys_ui_section)).filter(Boolean))];
    const relationshipIds = entries.map(entry => field(entry, 'related_list')).filter(value => /^REL:[a-f0-9]{32}$/i.test(value)).map(value => value.slice(4));
    const missingRelationships = relationshipIds.filter(id => !relationships.some(row => field(row, 'sys_id') === id));
    const tailSpecs = [
      ...chunks(sectionIds).flatMap(ids => [
        { ...request('sys_ui_section', `sys_idIN${ids.join(',')}^sys_userISEMPTY`, 'sys_id,name,caption,header,title,view', limit), group: 'sections' },
        { ...request('sys_ui_element', `sys_ui_sectionIN${ids.join(',')}^sys_userISEMPTY^ORDERBYposition`, 'sys_id,sys_ui_section,element,type,position', limit), group: 'elements' },
      ]),
      ...chunks([...new Set(missingRelationships)]).map(ids => ({
        ...request('sys_relationship', `sys_idIN${ids.join(',')}`, 'sys_id,name,basic_apply_to,basic_query_from,reference_field,simple_reference,advanced,query_with', limit), group: 'relationships',
      })),
    ];
    const tail = await reads(tailSpecs, warnings);
    const group = name => tail.flatMap((rows, index) => tailSpecs[index].group === name ? rows : []);
    const sections = group('sections');
    const elements = group('elements');
    relationships.push(...group('relationships'));
    const sectionsOut = ordered(links).map(link => {
      const id = field(link, 'sys_ui_section');
      const section = sections.find(row => field(row, 'sys_id') === id);
      if (!section) warnings.push({ source: 'sys_ui_section', reason: `A linked section is absent or not visible` });
      return { sys_id: id, caption: field(section, 'caption'), position: position(link),
        elements: ordered(elements.filter(row => field(row, 'sys_ui_section') === id)).map(row => ({
          element: field(row, 'element'), type: field(row, 'type'), label: field(row, 'label'), position: position(row),
        })) };
    });
    const relatedLists = buildRelationships({ entries, dictionary, relationships, sourceTable: container ? field(container, 'name') : '', names, warnings });
    return {
      table, requested_view: view, view_sys_id: viewId, hierarchy,
      form: form ? { sys_id: field(form, 'sys_id'), table: field(form, 'name'), inherited: field(form, 'name') !== table, sections: sectionsOut } : null,
      related_lists: relatedLists,
      coverage: { state: warnings.length ? 'partial' : 'observed', scope: 'Visible shared layout metadata only; ACLs, personalization and advanced relationships may hide or change runtime results', warnings },
    };
  }

  return { read, clear() { cache.clear(); reports.clear(); } };
}

function buildRelationships({ entries, dictionary, relationships, sourceTable, names, warnings }) {
  const result = new Map();
  for (const row of dictionary) {
    const table = field(row, 'name');
    const referenceField = field(row, 'element');
    if (!isName(table) || !isName(referenceField)) {
      warnings.push({ source: 'sys_dictionary', reason: 'Ignored an invalid reference definition' });
      continue;
    }
    if (!names.includes(field(row, 'reference'))) warnings.push({ source: 'sys_dictionary', reason: 'A reference target is absent, unrelated, or not visible' });
    const id = `${table}.${referenceField}`;
    result.set(id, { id, kind: 'reference', table, reference_field: referenceField,
      references: field(row, 'reference'), label: field(row, 'column_label'), configured: false,
      query_status: names.includes(field(row, 'reference')) ? 'reference' : 'unavailable' });
  }
  for (const row of relationships) {
    const id = `REL:${field(row, 'sys_id')}`;
    if (!/^REL:[a-f0-9]{32}$/i.test(id)) continue;
    const table = field(row, 'basic_query_from');
    const referenceField = field(row, 'reference_field');
    const queryable = field(row, 'advanced') !== 'true' && field(row, 'advanced') !== '1'
      && names.includes(field(row, 'basic_apply_to'))
      && ['true', '1'].includes(field(row, 'simple_reference')) && !field(row, 'query_with').trim()
      && isName(table) && isName(referenceField);
    result.set(id, { id, kind: 'relationship', relationship_sys_id: field(row, 'sys_id'),
      table: isName(table) ? table : '', reference_field: queryable ? referenceField : '',
      label: field(row, 'name'), configured: false, query_status: queryable ? 'reference' : 'platform_required',
      ...(queryable ? {} : { reason: 'Custom/advanced relationship requires platform query logic; scripts are never executed by metadata discovery' }),
    });
  }
  for (const entry of ordered(entries)) {
    const id = field(entry, 'related_list');
    const existing = result.get(id);
    const descriptor = existing || { id, kind: 'unresolved', table: '', reference_field: '', query_status: 'unavailable',
      reason: 'Configured related list metadata is absent, unsupported, or not visible' };
    result.set(id, { ...descriptor, configured: true, source_table: sourceTable, position: position(entry),
      filter: field(entry, 'filter'), order_by: field(entry, 'order_by') });
    if (!existing) warnings.push({ source: 'sys_ui_related_list_entry', reason: descriptor.reason });
  }
  return [...result.values()].sort((a, b) => Number(b.configured) - Number(a.configured) || (a.position || 0) - (b.position || 0));
}
