// Unload XML: what `<table>.do?UNL` writes (the UI's Export > XML) and `sys_upload.do` loads.
import { SaxesParser } from 'saxes';
import { AppError, errAPI, errUsage } from './errors.js';
import { getStringField } from './helpers.js';
import { parseUploadFormCSRF } from './sdk.js';

export const DEFAULT_XML_EXPORT_LIMIT = 10000;
// The 30-second request default covers the whole response; writing or loading an unload near the cap takes minutes.
const UNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const TABLE_NAME = /^[a-z][a-z0-9_]*$/i;
// An export carries these for each exported record; they are not matches of the query.
const RELATED = new Set(['sys_journal_field', 'sys_attachment', 'sys_attachment_doc']);
const ID = /^[a-f0-9]{32}$/i;
// An update set moves as a whole through jsn updatesets export and import, never as these rows.
export const UPDATE_SET_TABLES = new Set(['sys_remote_update_set', 'sys_update_xml']);
// Kept from each record so an import can be checked against what the instance holds afterwards.
const KEPT = new Set(['sys_id', 'sys_updated_on', 'sys_mod_count']);
const ACTIONS = new Set(['INSERT_OR_UPDATE', 'DELETE']);
export const MAX_UNLOAD_BYTES = 50 * 1024 * 1024;

/** Each top-level record in an unload document, in file order. */
export function inspectUnloadXML(xml) {
  const parser = new SaxesParser();
  const records = [];
  let depth = 0, record, field = '';
  parser.on('doctype', () => { throw errUsage('DOCTYPE and external entities are not allowed in unload XML'); });
  parser.on('opentag', tag => {
    depth++;
    if (depth === 1 && tag.name !== 'unload') throw errUsage('Expected unload XML with an <unload> root');
    if (depth === 2) record = { table: tag.name, action: tag.attributes.action || '', sys_id: '' };
    if (depth === 3) field = tag.name;
  });
  const text = value => { if (depth === 3 && KEPT.has(field)) record[field] = (record[field] ?? '') + value; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    if (depth === 2) records.push(record);
    depth--;
  });
  try { parser.write(xml).close(); } catch (error) { throw error instanceof AppError ? error : errUsage(`Invalid unload XML: ${error.message}`); }
  return records;
}

/** Record counts by table name, in first-seen order. */
export function countByTable(records) {
  const counts = {};
  for (const { table } of records) counts[table] = (counts[table] || 0) + 1;
  return counts;
}

/**
 * The instance's cap on one XML export. It truncates past it without saying so.
 * glide.xml.export.limit, then glide.ui.export.limit, then 10,000 (Export limits, product docs).
 * Returns the cap and the property it came from.
 */
export async function xmlExportCap(sdk) {
  const rows = await sdk.listStrict('sys_properties', new URLSearchParams({
    sysparm_query: 'nameINglide.xml.export.limit,glide.ui.export.limit', sysparm_fields: 'name,value', sysparm_display_value: 'false',
  }));
  const value = name => {
    const raw = getStringField(rows.find(row => getStringField(row, 'name') === name), 'value').trim();
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  };
  for (const source of ['glide.xml.export.limit', 'glide.ui.export.limit']) if (value(source)) return { cap: value(source), source };
  return { cap: DEFAULT_XML_EXPORT_LIMIT, source: 'the platform default; neither export limit property is set' };
}

/** GET the unload document and count the query's records in it (rows of child classes included). */
export async function exportRecordsXML(sdk, { table, query, limit }) {
  if (!TABLE_NAME.test(table)) throw errUsage(`Invalid table name: ${table}`);
  const params = new URLSearchParams({ UNL: '', sysparm_query: query });
  if (limit) params.set('sysparm_record_count', String(limit));
  const xml = await sdk.rawRequest(`${sdk.baseURL}/${table}.do?${params}`, { method: 'GET', timeout: UNLOAD_TIMEOUT_MS });
  if (!/^\s*(<\?xml|<unload)/i.test(xml)) {
    throw errAPI(200, `Export returned a non-XML response (${xml.trimStart().slice(0, 60) || 'empty body'}); the instance may need an authenticated admin session.`);
  }
  let records;
  try { records = inspectUnloadXML(xml); } catch (error) { throw errAPI(200, `Export returned unreadable XML: ${error.message}`); }
  const matches = records.filter(record => RELATED.has(table) ? record.table === table : !RELATED.has(record.table));
  if (matches.some(record => !ID.test(record.sys_id))) throw errAPI(200, 'Export returned a record without a sys_id; refusing to write it.');
  return { xml, records: matches.length, tables: countByTable(records) };
}

/** Check an unload file before any request: every record must be one the import can re-read afterwards. */
export function planUnloadImport(xml) {
  const records = inspectUnloadXML(xml);
  if (!records.length) throw errUsage('The file holds no records; nothing to import.');
  const seen = new Set();
  for (const record of records) {
    const where = `<${record.table}> ${record.sys_id || '(no sys_id)'}`;
    if (UPDATE_SET_TABLES.has(record.table)) {
      throw errUsage('This is an update set export. Load it with jsn updatesets import, which refuses to overwrite existing updates.');
    }
    if (!TABLE_NAME.test(record.table)) throw errUsage(`Invalid table name in the file: ${record.table}`);
    if (!ID.test(record.sys_id)) throw errUsage(`${where}: every record needs a 32-character sys_id so the import can be verified.`);
    if (!ACTIONS.has(record.action)) throw errUsage(`${where}: action "${record.action}" is not INSERT_OR_UPDATE or DELETE.`);
    if (seen.has(`${record.table}:${record.sys_id}`)) throw errUsage(`${where} appears twice; the file must name each record once.`);
    seen.add(`${record.table}:${record.sys_id}`);
  }
  return records;
}

/**
 * Upload through the UI's Import XML (sys_upload.do), then re-read every record the file names.
 * sys_upload.do answers 200 for a load, a bad file, an unknown table and a non-admin caller alike,
 * so the re-read is the only evidence of what landed. Throws before sending anything if the form is unavailable.
 */
export async function importUnloadXML(sdk, xml, records) {
  const cookies = await sdk._warmSession();
  // Any non-empty sysparm_target works; the file names its own tables.
  const target = records[0].table;
  const formURL = `${sdk.baseURL}/upload.do?sysparm_target=${target}`;
  const html = await sdk.rawRequest(formURL, { method: 'GET', headers: cookies ? { Cookie: cookies } : {} });
  const csrf = parseUploadFormCSRF(html);
  if (!csrf) {
    throw errUsage('The XML upload form is unavailable; nothing was uploaded. Importing XML needs the admin role and a UI session.');
  }
  const form = new FormData();
  form.set('sysparm_ck', csrf);
  form.set('sysparm_target', target);
  form.set('sysparm_upload_prefix', '');
  // No sysparm_referring_url and no Referer: a successful upload then answers 200; with either it redirects.
  form.set('attachFile', new Blob([xml], { type: 'application/xml' }), 'unload.xml');
  let uploadError = null;
  try {
    await sdk.rawRequest(`${sdk.baseURL}/sys_upload.do`, { method: 'POST', body: form, timeout: UNLOAD_TIMEOUT_MS,
      headers: { ...(cookies ? { Cookie: cookies } : {}), 'X-UserToken': csrf } });
  } catch (error) { uploadError = error.message || String(error); }
  return { ...(uploadError ? { upload_error: uploadError } : {}), ...await verifyUnloadImport(sdk, records) };
}

/** What the instance holds now for each record: present and unchanged from the file, or absent for a DELETE. */
export async function verifyUnloadImport(sdk, records) {
  const byTable = new Map();
  for (const record of records) byTable.set(record.table, [...(byTable.get(record.table) || []), record]);
  const problems = [];
  let landed = 0;
  for (const [table, rows] of byTable) {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const chunk = rows.slice(offset, offset + 100);
      let found;
      try {
        found = new Map((await sdk.listStrict(table, new URLSearchParams({
          sysparm_query: `sys_idIN${chunk.map(row => row.sys_id).join(',')}`, sysparm_fields: [...KEPT].join(','),
          sysparm_display_value: 'false', sysparm_limit: String(chunk.length),
        }))).map(row => [getStringField(row, 'sys_id'), row]));
      } catch (error) {
        for (const { sys_id, action } of chunk) problems.push({ table, sys_id, action, status: 'unreadable', error: error.message || String(error) });
        continue;
      }
      for (const record of chunk) {
        const row = found.get(record.sys_id);
        const status = record.action === 'DELETE' ? (row ? 'still_present' : 'landed')
          : !row ? 'missing'
            : ['sys_updated_on', 'sys_mod_count'].some(field => record[field] !== undefined && getStringField(row, field) !== record[field]) ? 'differs' : 'landed';
        if (status === 'landed') landed++;
        else problems.push({ table, sys_id: record.sys_id, action: record.action, status });
      }
    }
  }
  return { landed, problems };
}
