// Event reprocessing — the one mutating surface in the `events` family.
//
// The platform already owns this operation: the sysevent form's "Reprocess
// Event" UI action sets the copy's state back to ready, clears its processing
// fields and inserts a copy, leaving the original untouched. jsn reads that
// action's own script from the instance and runs exactly that script per
// selected event through the background-script path (the same transport
// `flows publish` uses), rather than reimplementing the mutation here.
//
// Reprocessing re-runs the event's script actions and can re-send notification
// emails, so callers preview the consumers and confirm before the write.

import { errNotFound, errUsage } from './errors.js';
import { EVENT_FIELDS, getEvent, isQueryableEventName, isSysId, projectEvent, raw } from './events.js';

export const REPROCESS_ACTION_NAME = 'Reprocess Event';
export const REPROCESS_LIMIT_DEFAULT = 10;
export const REPROCESS_LIMIT_MAX = 50;
export const REPROCESS_RESULT_MARKER = 'JSN_EVENTS_REPROCESS_RESULT:';

function boundedLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return REPROCESS_LIMIT_DEFAULT;
  return Math.max(1, Math.min(REPROCESS_LIMIT_MAX, Math.trunc(parsed)));
}

/** Read the live UI action so the mutation is the platform's, not a copy of it. */
export async function loadReprocessAction(sdk) {
  const rows = await sdk.list('sys_ui_action', {
    sysparm_query: `name=${REPROCESS_ACTION_NAME}^table=sysevent^active=true`,
    sysparm_fields: 'sys_id,name,table,script,condition,active',
    sysparm_limit: '5',
    sysparm_display_value: 'false',
  });
  const actions = Array.isArray(rows) ? rows : [];
  if (actions.length === 0) {
    throw errNotFound('Reprocess Event UI action', `sysevent/${REPROCESS_ACTION_NAME}`);
  }
  if (actions.length > 1) {
    throw errUsage(`Found ${actions.length} active "${REPROCESS_ACTION_NAME}" UI actions on sysevent; refusing to guess which script to run.`);
  }
  const script = raw(actions[0].script);
  if (!script.trim()) {
    throw errUsage(`The "${REPROCESS_ACTION_NAME}" UI action on sysevent has no script; there is nothing safe to run.`);
  }
  return {
    sys_id: raw(actions[0].sys_id),
    name: raw(actions[0].name) || REPROCESS_ACTION_NAME,
    table: raw(actions[0].table),
    condition: raw(actions[0].condition),
    script,
  };
}

/** Strip the trailing ^EQ and append a stable order so --limit is deterministic. */
export function normalizeBatchQuery(query) {
  const text = String(query || '').trim();
  if (!text) {
    throw errUsage('--query needs an encoded query selecting the events to reprocess, for example "state=error".');
  }
  const parts = text.split('^').map(part => part.trim()).filter(part => part && part !== 'EQ');
  if (!parts.some(part => /^ORDERBY/i.test(part))) parts.push('ORDERBYsys_created_on');
  return parts.join('^');
}

async function selectEvents(sdk, argv = {}) {
  const sysId = argv['sys-id'];
  const encoded = argv.query;
  if (sysId && encoded) throw errUsage('Pass either an event sys_id or --query, not both.');
  const limit = boundedLimit(argv.limit);

  if (sysId) {
    if (!isSysId(sysId)) throw errUsage('The event sys_id must be a literal 32-hex value.');
    const record = await getEvent(sdk, sysId);
    return {
      source: 'sys_id',
      query: `sys_id=${String(sysId).toLowerCase()}`,
      limit: 1,
      total_matching: 1,
      events: [projectEvent(record)],
    };
  }

  if (!encoded) {
    throw errUsage('Select events with an event sys_id or --query, for example: jsn events reprocess --query "state=error" --limit 5');
  }
  const filter = normalizeBatchQuery(encoded);
  const [rows, total] = await Promise.all([
    sdk.list('sysevent', {
      sysparm_query: filter,
      sysparm_fields: EVENT_FIELDS,
      sysparm_limit: String(limit),
      sysparm_display_value: 'all',
    }),
    sdk.aggregateCount('sysevent', filter),
  ]);
  const events = (Array.isArray(rows) ? rows : []).map(projectEvent);
  if (!events.length) throw errUsage(`The query matched no events: ${filter}`);
  return {
    source: 'query',
    query: filter,
    limit,
    total_matching: total,
    events,
  };
}

async function loadConsumers(sdk, events) {
  const allNames = [...new Set(events.map(event => event.name).filter(Boolean))];
  const names = allNames.filter(name => isQueryableEventName(name));
  const skippedNames = allNames.filter(name => !isQueryableEventName(name));
  if (!names.length) {
    return { names: [], skipped_names: skippedNames, script_actions: [], notifications: [] };
  }
  const nameClause = `event_nameIN${names.join(',')}`;
  const [actions, notifications] = await Promise.all([
    sdk.list('sysevent_script_action', {
      sysparm_query: nameClause,
      sysparm_fields: 'sys_id,event_name,active,condition_script',
      sysparm_limit: '200',
      sysparm_display_value: 'false',
    }),
    sdk.list('sysevent_email_action', {
      sysparm_query: `${nameClause}^generation_type=event`,
      sysparm_fields: 'sys_id,name,event_name,active,collection',
      sysparm_limit: '200',
      sysparm_display_value: 'false',
    }),
  ]);
  return {
    names,
    skipped_names: skippedNames,
    script_actions: (Array.isArray(actions) ? actions : []).map(row => ({
      sys_id: raw(row.sys_id),
      event_name: raw(row.event_name),
      active: raw(row.active),
      condition_script: raw(row.condition_script),
    })),
    notifications: (Array.isArray(notifications) ? notifications : []).map(row => ({
      sys_id: raw(row.sys_id),
      name: raw(row.name),
      event_name: raw(row.event_name),
      active: raw(row.active),
      collection: raw(row.collection),
    })),
  };
}

/**
 * Build the read-only plan: the exact events, the ones the platform's own
 * condition refuses, and every consumer that runs again.
 */
export async function planReprocess(sdk, argv = {}) {
  const [action, selection] = await Promise.all([loadReprocessAction(sdk), selectEvents(sdk, argv)]);
  const skipped = [];
  const queueable = [];
  for (const event of selection.events) {
    if (String(event.parm1 || '').startsWith('orig_event:')) {
      skipped.push({
        sys_id: event.sys_id,
        name: event.name,
        state: event.state,
        reason: 'parm1 starts with "orig_event:", so the platform\'s Reprocess Event condition refuses it',
      });
    } else {
      queueable.push(event);
    }
  }
  if (!queueable.length) {
    throw errUsage('Every selected event is a derived copy (parm1 starts with "orig_event:"); the platform\'s Reprocess Event action refuses those.');
  }
  const consumers = await loadConsumers(sdk, queueable);
  return { action, selection, queueable, skipped, consumers };
}

function normalizeLineEndings(script) {
  // The script is inserted as code, not data; only its line endings are
  // normalized so the wrapper stays readable in an execution history.
  return String(script).replace(/\r\n/g, '\n');
}

/** Wrap the UI action's own script in a bounded batch runner. */
export function buildReprocessScript(actionScript, sysIds) {
  const targets = sysIds.map(id => `'${String(id).toLowerCase()}'`).join(', ');
  return [
    `var jsnTargets = [${targets}];`,
    'var jsnResults = [];',
    'function jsnReprocessEvent(current) {',
    normalizeLineEndings(actionScript),
    '}',
    'for (var jsnIndex = 0; jsnIndex < jsnTargets.length; jsnIndex++) {',
    '  var jsnId = jsnTargets[jsnIndex];',
    '  var current = new GlideRecord("sysevent");',
    '  if (!current.get(jsnId)) { jsnResults.push({ sys_id: jsnId, status: "not_found" }); continue; }',
    '  var jsnParm1 = String(current.getValue("parm1") || "");',
    '  if (jsnParm1.indexOf("orig_event:") === 0) { jsnResults.push({ sys_id: jsnId, status: "skipped_derived_event" }); continue; }',
    '  if (typeof current.canWrite === "function" && !current.canWrite()) { jsnResults.push({ sys_id: jsnId, status: "not_writable" }); continue; }',
    '  var jsnBefore = current.getUniqueValue();',
    '  try {',
    '    jsnReprocessEvent(current);',
    '    var jsnCopy = current.getUniqueValue();',
    '    jsnResults.push({ sys_id: jsnBefore, status: (jsnCopy && jsnCopy !== jsnBefore) ? "queued" : "no_copy_recorded", copy_sys_id: jsnCopy || "" });',
    '  } catch (jsnError) {',
    '    jsnResults.push({ sys_id: jsnBefore, status: "script_error", error: String(jsnError && jsnError.message ? jsnError.message : jsnError) });',
    '  }',
    '}',
    `gs.print("${REPROCESS_RESULT_MARKER}" + JSON.stringify(jsnResults));`,
  ].join('\n');
}

export function parseReprocessOutput(output) {
  const text = String(output ?? '');
  const line = text.split(/\r?\n/).find(item => item.includes(REPROCESS_RESULT_MARKER));
  if (!line) {
    throw new Error(`The background script ran but returned no ${REPROCESS_RESULT_MARKER} line; the outcome is unknown, so jsn will not claim the events were queued.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line.slice(line.indexOf(REPROCESS_RESULT_MARKER) + REPROCESS_RESULT_MARKER.length));
  } catch {
    throw new Error('The background script returned a malformed reprocess result; the outcome is unknown.');
  }
  if (!Array.isArray(parsed)) throw new Error('The background script returned a non-array reprocess result; the outcome is unknown.');
  return parsed;
}

async function readBackCopies(sdk, results, sources) {
  const byId = new Map(sources.map(event => [String(event.sys_id).toLowerCase(), event]));
  const checked = [];
  for (const result of results) {
    const source = byId.get(String(result.sys_id || '').toLowerCase());
    const base = {
      sys_id: result.sys_id,
      source_name: source?.name || '',
      source_state: source?.state || '',
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.status !== 'queued' || !result.copy_sys_id) {
      checked.push({ ...base, verified: false, copy: null });
      continue;
    }
    const copy = await sdk.get('sysevent', result.copy_sys_id);
    const name = raw(copy?.name);
    const expected = String(source?.name || '');
    checked.push({
      ...base,
      copy: copy
        ? {
          sys_id: raw(copy.sys_id),
          name,
          state: raw(copy.state),
          queue: raw(copy.queue),
          process_on: raw(copy.process_on),
        }
        : null,
      verified: Boolean(copy) && name === expected,
    });
  }
  return checked;
}

export async function executeReprocess(sdk, plan) {
  const script = buildReprocessScript(plan.action.script, plan.queueable.map(event => event.sys_id));
  const output = await sdk.executeScript(script, 'global');
  const results = parseReprocessOutput(output);
  const readback = await readBackCopies(sdk, results, plan.queueable);
  const success = readback.filter(row => row.verified).length;
  return {
    ui_action: { sys_id: plan.action.sys_id, name: plan.action.name },
    results: readback,
    success_count: success,
    failure_count: readback.length - success,
    partial: success > 0 && success < readback.length,
    writes_performed: true,
  };
}

export function formatReprocessPreview(plan) {
  const { selection, action, queueable, skipped, consumers } = plan;
  const lines = [
    `Reprocess preview for ${selection.source === 'query' ? `query "${selection.query}"` : `event ${selection.query.replace('sys_id=', '')}`}`,
    `Matched: ${selection.total_matching}; selected: ${selection.events.length}; to queue again: ${queueable.length}`,
    '',
    'EVENTS TO QUEUE AGAIN',
  ];
  for (const event of queueable) {
    lines.push(`  ${event.sys_id}  ${event.name}  state=${event.state}  queue=${event.queue || '(default)'}  process_on=${event.process_on || '-'}`);
  }
  if (skipped.length) {
    lines.push('', `SKIPPED ${skipped.length}`);
    for (const event of skipped) lines.push(`  ${event.sys_id}  ${event.name}: ${event.reason}`);
  }
  lines.push('', `SCRIPT ACTIONS THAT WILL RUN AGAIN: ${consumers.script_actions.length}`);
  if (!consumers.script_actions.length) lines.push('  (none)');
  for (const row of consumers.script_actions) {
    lines.push(`  ${row.event_name}  ${row.sys_id}  active=${row.active}${row.condition_script ? `  condition=${row.condition_script}` : ''}`);
  }
  lines.push('', `NOTIFICATIONS THAT WILL RUN AGAIN (re-sends email): ${consumers.notifications.length}`);
  if (!consumers.notifications.length) lines.push('  (none)');
  for (const row of consumers.notifications) {
    lines.push(`  ${row.event_name}  ${row.name}  active=${row.active}  collection=${row.collection || '-'}`);
  }
  if (consumers.skipped_names.length) {
    lines.push('', `Names not queryable for consumers (skipped in the consumer lookup, still reprocessed): ${consumers.skipped_names.join(', ')}`);
  }
  lines.push('', `UI action: ${action.name} ${action.sys_id} (${action.script.length} script characters, read live from the instance)`);
  lines.push('Nothing has been written.');
  return `${lines.join('\n')}\n`;
}

export function formatReprocessResult(data) {
  const lines = [];
  for (const row of data.results) {
    const copy = row.copy ? ` -> ${row.copy.sys_id} state=${row.copy.state || '?'} process_on=${row.copy.process_on || '-'}` : '';
    const status = row.verified ? 'queued and read back' : row.status;
    lines.push(`${row.sys_id}  ${row.source_name || ''}  ${status}${copy}${row.error ? `  error=${row.error}` : ''}`);
  }
  lines.push('', `${data.success_count} queued and verified; ${data.failure_count} failed${data.partial ? '; partial batch' : ''}.`);
  return `${lines.join('\n')}\n`;
}
