// Read-only readers for the ServiceNow event log (sysevent).
//
// The platform keeps the event, its queue and its timing, but not why an event
// failed: sysevent has no error/message column and syslog has no row at the
// event's processing second. This module reports that absence instead of
// inventing a cause.
//
// `process_on` and `sys_created_on` are instance-local wall-clock values. Every
// comparison against "now" is therefore left to the platform
// (javascript:gs.nowDateTime()) so a client clock or timezone cannot turn a
// scheduled event into a false backlog.

import { errNotFound, errUsage } from './errors.js';

export const EVENT_TABLE = 'sysevent';
export const EVENT_REGISTRY_TABLE = 'sysevent_register';
export const EVENT_SCRIPT_ACTION_TABLE = 'sysevent_script_action';
export const EVENT_NOTIFICATION_TABLE = 'sysevent_email_action';
export const EVENT_EMAIL_LOG_TABLE = 'sys_email_log';
export const EVENT_STATES = ['ready', 'processed', 'error', 'transferred'];
export const BACKLOG_DEFAULT_SINCE = '7d';
export const EVENT_FIELDS = [
  'sys_id', 'name', 'queue', 'state', 'table', 'instance', 'parm1', 'parm2',
  'user_name', 'user_id', 'uri', 'process_on', 'processed', 'processing_duration',
  'claimed_by', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'partition',
  'derived_priority',
].join(',');

export const NO_ERROR_REASON = 'The platform does not record why an event ended in error. sysevent has no error or message column, and syslog has no row at the event\'s processing time, so jsn cannot name a cause.';
export const TRANSFERRED_NOTE = 'transferred means the platform rotated this event to another shard of the sysevent table. The copy in the active shard is the one that gets processed, so this row may never be updated again.';
export const DEFAULT_QUEUE_NOTE = 'sysevent leaves queue blank for the default queue. The job named "events process 0" is matched by its job name, not by a stored reference on the event.';

/** Unwrap a Table API value ({display_value,value}) to its raw string form. */
export function raw(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.value != null) return String(value.value);
    if (value.display_value != null) return String(value.display_value);
    return '';
  }
  return String(value);
}

/** The display label of a Table API value, falling back to the raw value. */
export function display(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.display_value != null) return String(value.display_value);
    if (value.value != null) return String(value.value);
    return '';
  }
  return String(value);
}

export function isSysId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value || ''));
}

function assertQueryValue(value, label) {
  const text = String(value);
  if (text.includes('^') || text.includes('\n') || text.includes('\r')) {
    throw errUsage(`${label} cannot contain "^" or a newline: it would change the encoded query.`);
  }
  return text;
}

/**
 * Turn --since into an encoded-query term. A relative value (24h, 7d) is
 * delegated to the platform's own clock; an absolute value is passed through
 * unchanged so it keeps the instance's timezone semantics.
 */
export function sinceClause(since, { field = 'sys_created_on' } = {}) {
  const value = String(since ?? '').trim();
  if (!value) return '';
  const relative = value.match(/^(\d+)([hd])$/i);
  if (relative) {
    const amount = Math.max(1, Number(relative[1]));
    const unit = relative[2].toLowerCase() === 'h' ? 'hours' : 'days';
    return `${field}>=javascript:gs.${unit}AgoStart(${amount})`;
  }
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(value)) {
    throw errUsage('--since must be a date/time (2026-11-26 or "2026-11-26 10:00:00") or a relative span such as 24h or 7d.');
  }
  return `${field}>=${value.replace('T', ' ')}`;
}

function tableName(value) {
  const table = String(value || '').trim();
  if (!/^[a-z][a-z0-9_]{0,79}$/i.test(table)) throw errUsage('--table must be a lower-case table name.');
  return table;
}

/** Build the encoded query for `events list` filters. */
export function buildEventQuery(filters = {}) {
  const parts = [];
  const since = sinceClause(filters.since);
  if (since) parts.push(since);
  if (filters.name) parts.push(`name=${assertQueryValue(filters.name, '--name')}`);
  if (filters.state) {
    const state = String(filters.state).toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(state)) throw errUsage(`--state must be one of ${EVENT_STATES.join(', ')} (or another stored value).`);
    parts.push(`state=${state}`);
  }
  if (filters.queue !== undefined && filters.queue !== null) {
    // An explicitly blank --queue selects the platform's default queue, the
    // one sysevent stores as an empty value.
    parts.push(String(filters.queue) === ''
      ? 'queueISEMPTY'
      : `queue=${assertQueryValue(filters.queue, '--queue')}`);
  }
  if (filters.table) parts.push(`table=${tableName(filters.table)}`);
  if (filters.record) {
    if (!filters.table) throw errUsage('--record needs --table: sysevent.instance is the sys_id of a record on that table.');
    if (!isSysId(filters.record)) throw errUsage('--record must be a literal 32-hex sys_id.');
    parts.push(`instance=${String(filters.record).toLowerCase()}`);
  }
  return parts.join('^');
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

/** Project one sysevent row onto the fields jsn presents. */
export function projectEvent(record = {}) {
  return {
    sys_id: raw(record.sys_id),
    name: raw(record.name),
    queue: raw(record.queue),
    state: raw(record.state),
    table: raw(record.table),
    record: raw(record.instance),
    parm1: raw(record.parm1),
    parm2: raw(record.parm2),
    user_name: raw(record.user_name),
    user_id: raw(record.user_id),
    uri: raw(record.uri),
    process_on: display(record.process_on),
    processed: display(record.processed),
    processing_duration: numeric(raw(record.processing_duration)),
    claimed_by: raw(record.claimed_by),
    created: display(record.sys_created_on),
    created_by: raw(record.sys_created_by),
    updated: display(record.sys_updated_on),
    partition: raw(record.partition),
    derived_priority: raw(record.derived_priority),
  };
}

/**
 * Seconds between two instance-local wall-clock strings. Both values come from
 * the same instance clock, so the difference is timezone-independent.
 */
export function secondsBetween(from, to) {
  if (!from || !to) return null;
  const start = Date.parse(String(from).replace(' ', 'T'));
  const end = Date.parse(String(to).replace(' ', 'T'));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 1000);
}

export async function listEvents(sdk, options = {}) {
  const limit = boundedLimit(options.limit, 20, 500);
  const filter = buildEventQuery(options);
  const query = [filter, 'ORDERBYDESCsys_created_on'].filter(Boolean).join('^');
  const [records, total] = await Promise.all([
    sdk.list(EVENT_TABLE, {
      sysparm_query: query,
      sysparm_fields: EVENT_FIELDS,
      sysparm_limit: String(limit),
      sysparm_display_value: 'all',
    }),
    sdk.aggregateCount(EVENT_TABLE, filter),
  ]);
  const rows = Array.isArray(records) ? records.map(projectEvent) : [];
  return {
    query,
    limit,
    total_matching: total,
    has_more: total > rows.length,
    records: rows,
  };
}

export async function getEvent(sdk, sysId) {
  if (!isSysId(sysId)) throw errUsage('events show needs a literal 32-hex event sys_id.');
  const rows = await sdk.list(EVENT_TABLE, {
    sysparm_query: `sys_id=${String(sysId).toLowerCase()}`,
    sysparm_fields: EVENT_FIELDS,
    sysparm_limit: '1',
    // Display values carry the instance/user timezone the form shows; raw
    // values are UTC for date fields, and mixing the two misreads by hours.
    sysparm_display_value: 'all',
  });
  const record = Array.isArray(rows) ? rows[0] : null;
  if (!record) throw errNotFound('Event', sysId);
  if (raw(record.sys_id).toLowerCase() !== String(sysId).toLowerCase()) {
    throw errUsage('Provider event identity does not match the requested sys_id.');
  }
  return record;
}

const CONSUMER_LIMIT = 100;
const EMAIL_LIMIT = 50;

async function listConsumerRows(sdk, table, query, fields, limit = CONSUMER_LIMIT) {
  const records = await sdk.list(table, {
    sysparm_query: query,
    sysparm_fields: fields,
    sysparm_limit: String(limit),
    sysparm_display_value: 'false',
  });
  return Array.isArray(records) ? records : [];
}

/**
 * Everything the event log can tell us about one event: the row itself, its
 * timing/node, the registry entry, and the consumers registered for its name.
 * Joins use raw sys_ids; display labels are presentation only.
 */
export async function describeEvent(sdk, sysId) {
  const record = await getEvent(sdk, sysId);
  const event = projectEvent(record);
  const name = event.name;
  // A name carrying a query operator would rewrite the consumer lookup; skip
  // the join and say so rather than reading the wrong rows.
  const queryableName = name && !/[\^,]/.test(name);

  const [registry, scriptActions, notifications, emailLogs] = await Promise.all([
    queryableName ? listConsumerRows(sdk, EVENT_REGISTRY_TABLE, `event_name=${name}`, 'sys_id,event_name,table,description') : [],
    queryableName ? listConsumerRows(sdk, EVENT_SCRIPT_ACTION_TABLE, `event_name=${name}`, 'sys_id,event_name,active,condition_script') : [],
    queryableName
      ? listConsumerRows(sdk, EVENT_NOTIFICATION_TABLE, `event_name=${name}^generation_type=event`, 'sys_id,name,active,collection,event_name')
      : [],
    sdk.list(EVENT_EMAIL_LOG_TABLE, {
      sysparm_query: `event=${event.sys_id}^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'sys_id,event,notification,email,sys_created_on',
      sysparm_limit: String(EMAIL_LIMIT),
      sysparm_display_value: 'all',
    }).then(rows => (Array.isArray(rows) ? rows : [])),
  ]);

  const stateNotes = [];
  if (name && !queryableName) stateNotes.push('The event name carries a query operator, so consumer and registry lookups were skipped rather than risk reading unrelated rows.');
  if (event.state === 'error') stateNotes.push(NO_ERROR_REASON);
  if (event.state === 'transferred') stateNotes.push(TRANSFERRED_NOTE);

  return {
    event,
    timing: {
      created: event.created,
      scheduled_for: event.process_on,
      processed: event.processed,
      queued_seconds: secondsBetween(event.created, event.process_on),
      processing_duration: event.processing_duration,
      node: event.claimed_by,
      processing_user: event.user_name,
      partition: event.partition,
    },
    registry: registry.map(row => ({
      sys_id: raw(row.sys_id),
      event_name: raw(row.event_name),
      table: raw(row.table),
      description: raw(row.description),
    })),
    script_actions: scriptActions.map(row => ({
      sys_id: raw(row.sys_id),
      event_name: raw(row.event_name),
      active: raw(row.active),
      condition_script: raw(row.condition_script),
    })),
    notifications: notifications.map(row => ({
      sys_id: raw(row.sys_id),
      name: raw(row.name),
      active: raw(row.active),
      collection: raw(row.collection),
      event_name: raw(row.event_name),
    })),
    emails: emailLogs.map(row => ({
      sys_email_log: raw(row.sys_id),
      notification: raw(row.notification),
      notification_name: display(row.notification),
      email: raw(row.email),
      subject: display(row.email),
      created: display(row.sys_created_on),
    })),
    truncated: {
      registry: registry.length >= CONSUMER_LIMIT,
      script_actions: scriptActions.length >= CONSUMER_LIMIT,
      notifications: notifications.length >= CONSUMER_LIMIT,
      emails: emailLogs.length >= EMAIL_LIMIT,
    },
    error_reason: event.state === 'error'
      ? { available: false, explanation: NO_ERROR_REASON }
      : null,
    notes: stateNotes,
  };
}

/** The three "has process_on passed?" questions, asked on the instance clock. */
export function backlogQueries(since = BACKLOG_DEFAULT_SINCE) {
  const window = sinceClause(since || BACKLOG_DEFAULT_SINCE) || sinceClause(BACKLOG_DEFAULT_SINCE);
  return {
    window,
    ready: `${window}^state=ready`,
    overdue: `${window}^state=ready^process_on<=javascript:gs.nowDateTime()`,
    scheduled: `${window}^state=ready^process_on>javascript:gs.nowDateTime()`,
    unscheduled: `${window}^state=ready^process_onISEMPTY`,
  };
}

function groupValue(group, field) {
  const found = group?.groupby_fields?.find(item => item?.field === field);
  return found ? String(found.value ?? '') : '';
}

export function normalizeCounts(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map(group => ({
      queue: groupValue(group, 'queue'),
      state: groupValue(group, 'state'),
      count: numeric(group?.stats?.count) ?? 0,
    }))
    .sort((a, b) => b.count - a.count
      || a.queue.localeCompare(b.queue)
      || a.state.localeCompare(b.state));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Queue names a processor job proves it handles (script literal, or job name). */
export function processorQueueNames(job = {}) {
  const names = new Set();
  const jobName = raw(job.name);
  const fromName = /^events process (.+)$/i.exec(jobName);
  if (fromName) names.add(fromName[1].trim());
  const script = raw(job.script);
  const literal = /GlideEventManager\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*process(?:DelegatedEvents)?\s*\(/g;
  let match;
  while ((match = literal.exec(script)) !== null) names.add(match[2]);
  return [...names];
}

/**
 * How a sys_trigger job matches a queue. Job names are truncated to 40
 * characters, so a long queue can only match by prefix; the returned reason
 * records which evidence was used.
 */
export function jobMatch(job = {}, queue) {
  const wanted = String(queue ?? '');
  const jobName = raw(job.name);
  if (wanted === '') return /^events process 0$/i.test(jobName) ? 'default queue job name' : null;
  const script = raw(job.script);
  if (new RegExp(`GlideEventManager\\(\\s*['"]${escapeRegExp(wanted)}['"]\\s*\\)`).test(script)) return 'script';
  const fromName = /^events process (.+)$/i.exec(jobName)?.[1]?.trim();
  if (fromName === wanted) return 'job name';
  if (fromName && fromName.length >= 20 && wanted.startsWith(fromName)) return 'truncated job name';
  // Weakest evidence, kept only when nothing stronger names the queue: a job
  // whose name spells the queue out in words. It is labelled as such so an
  // operator never mistakes it for a stored association.
  const lowerName = jobName.toLowerCase();
  const wantedLower = wanted.toLowerCase();
  const words = wantedLower.replace(/_/g, ' ');
  if (/event/i.test(jobName) && (lowerName.includes(wantedLower) || lowerName.includes(words))) return 'job name mentions the queue';
  return null;
}

export const PROCESSOR_JOB_FIELDS = 'sys_id,name,next_action,state,trigger_type,script';
export const PROCESSOR_JOB_QUERY = 'scriptLIKEGlideEventManager^ORnameLIKEEvent';

export async function getBacklog(sdk, options = {}) {
  const since = options.since || BACKLOG_DEFAULT_SINCE;
  const queries = backlogQueries(since);
  const eventPage = (query, limit = 1) => sdk.list(EVENT_TABLE, {
    sysparm_query: `${query}^ORDERBYprocess_on`,
    sysparm_fields: EVENT_FIELDS,
    sysparm_limit: String(limit),
    sysparm_display_value: 'all',
  }).then(rows => (Array.isArray(rows) ? rows : []));

  const [grouped, overdueCount, scheduledCount, unscheduledCount, oldestOverdue, nextScheduled, processorJobs] = await Promise.all([
    sdk.aggregate(EVENT_TABLE, { query: queries.window, groupBy: ['queue', 'state'] }),
    sdk.aggregateCount(EVENT_TABLE, queries.overdue),
    sdk.aggregateCount(EVENT_TABLE, queries.scheduled),
    sdk.aggregateCount(EVENT_TABLE, queries.unscheduled),
    eventPage(queries.overdue),
    eventPage(queries.scheduled),
    sdk.list('sys_trigger', {
      sysparm_query: PROCESSOR_JOB_QUERY,
      sysparm_fields: PROCESSOR_JOB_FIELDS,
      sysparm_limit: '200',
      sysparm_display_value: 'all',
    }).then(rows => (Array.isArray(rows) ? rows : [])),
  ]);

  const counts = normalizeCounts(grouped?.groups);
  const byState = {};
  const byQueue = new Map();
  for (const row of counts) {
    byState[row.state] = (byState[row.state] || 0) + row.count;
    byQueue.set(row.queue, (byQueue.get(row.queue) || 0) + row.count);
  }

  const processors = [...byQueue.keys()].sort().map(queue => {
    const matches = (processorJobs || [])
      .map(job => ({ job, matchedBy: jobMatch(job, queue) }))
      .filter(({ matchedBy }) => matchedBy);
    const strong = matches.filter(({ matchedBy }) => matchedBy !== 'job name mentions the queue');
    const chosen = strong.length ? strong : matches;
    const seen = new Set();
    const jobs = chosen
      .filter(({ job }) => {
        const id = raw(job.sys_id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map(({ job, matchedBy }) => ({
        sys_id: raw(job.sys_id),
        name: raw(job.name),
        next_action: display(job.next_action),
        state: display(job.state),
        trigger_type: display(job.trigger_type),
        matched_by: matchedBy,
      }));
    return {
      queue,
      processors: jobs,
      note: queue === '' && jobs.length
        ? DEFAULT_QUEUE_NOTE
        : (jobs.length ? null : 'No sys_trigger job names this queue in its script or job name; jsn does not infer one.'),
    };
  });

  const matchedIds = new Set(processors.flatMap(entry => entry.processors.map(job => job.sys_id)));
  const unmatched = (processorJobs || [])
    .filter(job => !matchedIds.has(raw(job.sys_id)))
    .map(job => ({
      sys_id: raw(job.sys_id),
      name: raw(job.name),
      next_action: display(job.next_action),
      state: display(job.state),
      trigger_type: display(job.trigger_type),
      queues: processorQueueNames(job),
    }))
    // Only jobs that actually name a queue are worth reporting as unmatched;
    // a scheduled job with "Event" in its name is not evidence about a queue.
    .filter(job => job.queues.length > 0);

  return {
    window: { since, query: queries.window },
    counts,
    totals: {
      by_state: byState,
      by_queue: [...byQueue.entries()]
        .map(([queue, count]) => ({ queue, count }))
        .sort((a, b) => b.count - a.count || a.queue.localeCompare(b.queue)),
    },
    ready: {
      overdue: {
        count: overdueCount,
        oldest: oldestOverdue.map(projectEvent)[0] || null,
        query: queries.overdue,
      },
      scheduled: {
        count: scheduledCount,
        next: nextScheduled.map(projectEvent)[0] || null,
        query: queries.scheduled,
      },
      missing_process_on: {
        count: unscheduledCount,
        query: queries.unscheduled,
      },
      interpretation: 'overdue means process_on has already passed. scheduled means process_on is still in the future, so it is waiting on purpose, not stuck. missing_process_on events carry no schedule value.',
    },
    processors,
    unmatched_processors: unmatched,
  };
}

function clip(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function formatEventList(data) {
  const lines = [
    'STATE        CREATED              NAME                          QUEUE            PROCESS_ON           SYS_ID',
    '-----------  -------------------  ----------------------------  ---------------  -------------------  --------------------------------',
  ];
  for (const row of data.records) {
    lines.push(`${clip(row.state, 11).padEnd(11)}  ${clip(row.created, 19).padEnd(19)}  ${clip(row.name, 28).padEnd(28)}  ${clip(row.queue, 15).padEnd(15)}  ${clip(row.process_on, 19).padEnd(19)}  ${row.sys_id}`);
  }
  if (data.records.length === 0) lines.push('(no events matched)');
  lines.push('', `${data.records.length} of ${data.total_matching} matching event(s)${data.has_more ? '; more exist' : ''}.`);
  return `${lines.join('\n')}\n`;
}

export function formatEventDetail(data) {
  const { event, timing } = data;
  const lines = [
    `Event ${event.name || '(no name)'}  [${event.state || 'unknown state'}]`,
    `  sys_id:        ${event.sys_id}`,
    `  queue:         ${event.queue || '(default queue)'}`,
    `  record:        ${event.table || '(none)'}${event.record ? ` / ${event.record}` : ''}`,
    `  parm1/parm2:   ${event.parm1 || '-'} / ${event.parm2 || '-'}`,
    `  created:       ${timing.created || '-'} by ${event.created_by || '-'}`,
    `  scheduled for: ${timing.scheduled_for || '-'}`,
    `  processed:     ${timing.processed || '-'}${timing.queued_seconds == null ? '' : ` (queued ${timing.queued_seconds}s)`}`,
    `  processing:    ${timing.processing_duration == null ? 'unrecorded' : `${timing.processing_duration} (platform value)`}`,
    `  node:          ${timing.node || 'unrecorded'}`,
    `  user:          ${event.user_name || '-'}${event.user_id ? ` (${event.user_id})` : ''}`,
  ];
  lines.push('', `Registry (sysevent_register): ${data.registry.length}${data.truncated.registry ? '+' : ''}`);
  if (!data.registry.length) lines.push('  (not registered by name)');
  for (const row of data.registry) lines.push(`  ${row.event_name}  table=${row.table || '-'}  ${row.description || ''}`.trimEnd());
  lines.push('', `Script actions (sysevent_script_action): ${data.script_actions.length}${data.truncated.script_actions ? '+' : ''}`);
  if (!data.script_actions.length) lines.push('  (none listen for this event name)');
  for (const row of data.script_actions) {
    lines.push(`  ${row.sys_id}  active=${row.active}${row.condition_script ? `  condition=${clip(row.condition_script, 70)}` : ''}`);
  }
  lines.push('', `Event notifications (sysevent_email_action, generation_type=event): ${data.notifications.length}${data.truncated.notifications ? '+' : ''}`);
  if (!data.notifications.length) lines.push('  (none listen for this event name)');
  for (const row of data.notifications) lines.push(`  ${row.sys_id}  ${row.name}  active=${row.active}  collection=${row.collection || '-'}`);
  lines.push('', `Emails tied to this event (sys_email_log): ${data.emails.length}${data.truncated.emails ? '+' : ''}`);
  if (!data.emails.length) lines.push('  (none recorded)');
  for (const row of data.emails) {
    lines.push(`  ${row.created}  ${row.notification_name || row.notification || 'notification unrecorded'}  ${row.subject || row.email}`);
  }
  for (const note of data.notes || []) lines.push('', note);
  return `${lines.join('\n')}\n`;
}

export function formatBacklog(data) {
  const lines = [
    `Event backlog, window ${data.window.query}`,
    '',
    'QUEUE            STATE        COUNT',
    '---------------  -----------  -----',
  ];
  for (const row of data.counts) {
    lines.push(`${clip(row.queue || '(default)', 15).padEnd(15)}  ${clip(row.state, 11).padEnd(11)}  ${String(row.count).padStart(5)}`);
  }
  if (!data.counts.length) lines.push('(no events in this window)');
  const states = Object.entries(data.totals.by_state).map(([state, count]) => `${state} ${count}`).join(', ') || 'none';
  lines.push('', `Totals by state: ${states}`);
  lines.push(`Ready: overdue ${data.ready.overdue.count}, scheduled ${data.ready.scheduled.count}, no process_on ${data.ready.missing_process_on.count}`);
  const oldest = data.ready.overdue.oldest;
  lines.push(oldest
    ? `Oldest overdue: ${oldest.process_on}  ${oldest.name}  queue=${oldest.queue || '(default)'}  ${oldest.sys_id}`
    : 'Oldest overdue: none (no ready event has a passed process_on in this window)');
  const next = data.ready.scheduled.next;
  lines.push(next
    ? `Next scheduled:  ${next.process_on}  ${next.name}  queue=${next.queue || '(default)'}  ${next.sys_id}`
    : 'Next scheduled:  none');
  lines.push('', 'PROCESSORS (sys_trigger)');
  for (const entry of data.processors) {
    if (!entry.processors.length) {
      lines.push(`  queue ${entry.queue || '(default)'}: no processor job matched${entry.note ? ` (${entry.note})` : ''}`);
      continue;
    }
    for (const job of entry.processors) {
      lines.push(`  queue ${entry.queue || '(default)'}: ${job.name}  next_action=${job.next_action || '-'}  state=${job.state || '-'}  (matched by ${job.matched_by})`);
    }
    if (entry.note) lines.push(`    note: ${entry.note}`);
  }
  if (data.unmatched_processors.length) {
    lines.push('', `Other event-processor jobs not matched to a queue in this window: ${data.unmatched_processors.length}`);
    for (const job of data.unmatched_processors.slice(0, 8)) {
      lines.push(`  ${job.name}  next_action=${job.next_action || '-'}  state=${job.state || '-'}`);
    }
    if (data.unmatched_processors.length > 8) {
      lines.push(`  … ${data.unmatched_processors.length - 8} more (see --json)`);
    }
  }
  lines.push('', data.ready.interpretation);
  return `${lines.join('\n')}\n`;
}
