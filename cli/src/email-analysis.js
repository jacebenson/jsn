// Read-only email queue analysis.
//
// `jsn email queue` and `jsn email why` answer the two recurring mailbox
// tickets: mail piling up in the outbox, and an inbound message that was
// ignored. Both read the Table/Stats APIs with GET only.
//
// Evidence rules this module follows:
// - Counts come from the Stats API aggregate over the whole window, never
//   from one Table API page.
// - A source that cannot be read (403/404/absent) is reported as unavailable
//   evidence, not as zero rows.
// - Inbound skip reasons are not stored on sys_email. Candidate inbound
//   actions and notification log rows are listed as related evidence and are
//   labelled unconfirmed; they are never presented as the reason.

import { errNotFound, errUsage } from './errors.js';

// sys_choice records for sys_email.type on a stock instance. Present values
// come back from the aggregate; these only drive the "zero in window" list.
export const EMAIL_TYPES = [
  'send-ready',
  'send-translation-ready',
  'send-failed',
  'sent',
  'send-ignored',
  'received',
  'received-ignored',
];

const WINDOW_UNITS = { h: 'hoursAgo', d: 'daysAgo', w: 'weeksAgo', m: 'monthsAgo' };

/**
 * Translate `--since` into an encoded query. Relative windows are evaluated
 * by ServiceNow (`javascript:gs.daysAgo(7)`), so the CLI does not have to
 * guess the instance time zone. Absolute dates are passed through and are
 * interpreted in the instance system time zone.
 */
export function parseEmailWindow(since = '7d', now = new Date()) {
  if (since === undefined || since === null || String(since).trim() === '') {
    throw errUsage('--since needs a date (YYYY-MM-DD[ HH:MM[:SS]]) or a relative window like 24h, 7d, 4w, 1m.');
  }
  const raw = String(since).trim();
  const relative = /^(\d+)([hdwm])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw errUsage('--since relative windows must be a positive number followed by h, d, w or m (e.g. 24h, 7d).');
    }
    const unit = relative[2];
    // gs.weeksAgo does not exist on every release; days are universal.
    const query = unit === 'w'
      ? `sys_created_on>=javascript:gs.daysAgo(${amount * 7})`
      : `sys_created_on>=javascript:gs.${WINDOW_UNITS[unit]}(${amount})`;
    return { since: raw, kind: 'relative', unit, amount, query,
      resolution: 'evaluated by ServiceNow relative to request time', computed_at: now.toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(raw)) {
    return { since: raw, kind: 'absolute', query: `sys_created_on>=${raw.replace('T', ' ')}`,
      resolution: 'absolute timestamp, interpreted in the instance system time zone', computed_at: now.toISOString() };
  }
  throw errUsage('--since must be a date (YYYY-MM-DD[ HH:MM[:SS]]) or a relative window like 24h, 7d, 4w, 1m.');
}

/** Unwrap display-value envelopes; returns the raw value. */
function rawValue(value) {
  if (value && typeof value === 'object') return value.value ?? '';
  return value ?? '';
}

/** Unwrap display-value envelopes; returns the human label. */
export function displayValue(value) {
  if (value && typeof value === 'object') return value.display_value ?? value.value ?? '';
  return value ?? '';
}

function isTrue(value) {
  const v = String(rawValue(value)).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function messageOf(error) {
  return error?.message || String(error);
}

/** Parse a ServiceNow raw timestamp (`YYYY-MM-DD HH:MM:SS`) as UTC. */
export function parseInstanceTimestamp(value) {
  const text = String(rawValue(value) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const ms = Date.parse(text.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

export function describeAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function groupsOf(result, field) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  return groups.map(group => {
    const counts = group?.stats || {};
    const count = numeric(counts.count ?? counts);
    const descriptor = (group?.groupby_fields || []).find(entry => entry.field === field)
      || (group?.groupby_fields || [])[0];
    return { value: String(descriptor?.value ?? ''), count };
  }).filter(entry => entry.count !== null);
}

function sumCounts(groups) {
  return groups.reduce((total, group) => total + group.count, 0);
}

/**
 * Run one read and convert a provider failure into unavailable evidence.
 * Never substitutes a zero count for a failed read.
 */
async function attempt(source, table, read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, unavailable: { source, table, error: messageOf(error), status: error?.status ?? null } };
  }
}

function tableParams(fields, { query = '', limit = 20, display = 'all' } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('sysparm_query', query);
  if (fields?.length) params.set('sysparm_fields', fields.join(','));
  params.set('sysparm_limit', String(limit));
  params.set('sysparm_display_value', display);
  return params;
}

/**
 * Queue health for sys_email.
 *
 * @param {object} sdk — SDK client (read-only use: aggregate, aggregateCount, list)
 * @param {object} [options]
 * @param {string} [options.since='7d'] — window for counts
 * @param {Date} [options.now] — clock for age arithmetic
 */
export async function buildEmailQueue(sdk, { since = '7d', now = new Date() } = {}) {
  const window = parseEmailWindow(since, now);
  const unavailable = [];
  const notes = [];
  const warnings = [];

  const collect = async (source, table, read, fallback = null) => {
    const result = await attempt(source, table, read);
    if (result.ok) return result.value;
    unavailable.push(result.unavailable);
    return fallback;
  };

  const [typeResult, stateResult, mailboxResult, totalResult, minResult] = await Promise.all([
    attempt('counts by type', 'sys_email', () => sdk.aggregate('sys_email', { query: window.query, groupBy: ['type'], count: true })),
    attempt('counts by state', 'sys_email', () => sdk.aggregate('sys_email', { query: window.query, groupBy: ['state'], count: true })),
    attempt('counts by mailbox', 'sys_email', () => sdk.aggregate('sys_email', { query: window.query, groupBy: ['mailbox'], count: true })),
    attempt('window total', 'sys_email', () => sdk.aggregateCount('sys_email', window.query)),
    attempt('oldest send-ready', 'sys_email', () => sdk.aggregate('sys_email', {
      query: 'type=send-ready', count: true, minimumFields: ['sys_created_on'],
    })),
  ]);

  for (const result of [typeResult, stateResult, mailboxResult, totalResult, minResult]) {
    if (!result.ok) unavailable.push(result.unavailable);
  }

  const byType = typeResult.ok
    ? groupsOf(typeResult.value, 'type').sort((a, b) => b.count - a.count)
    : null;
  const byState = stateResult.ok
    ? groupsOf(stateResult.value, 'state').sort((a, b) => b.count - a.count)
    : null;
  let byMailbox = mailboxResult.ok
    ? groupsOf(mailboxResult.value, 'mailbox').sort((a, b) => b.count - a.count)
    : null;
  const total = totalResult.ok ? numeric(totalResult.value) : null;

  // Mailbox values are sys_mailbox sys_ids (the stock rows use readable ids
  // such as "outbox"), so resolve display labels without losing identity.
  const mailboxNames = await collect('mailbox labels', 'sys_mailbox', async () => {
    const rows = await sdk.list('sys_mailbox', tableParams(['sys_id', 'name'], { limit: 100, display: 'raw' }));
    return Object.fromEntries(rows.map(row => [String(row.sys_id), row.name || String(row.sys_id)]));
  }, null);
  if (byMailbox && mailboxNames) {
    byMailbox = byMailbox.map(entry => ({
      mailbox: entry.value,
      name: mailboxNames[entry.value] || null,
      count: entry.count,
    }));
  } else if (byMailbox) {
    byMailbox = byMailbox.map(entry => ({ mailbox: entry.value, name: null, count: entry.count }));
  }

  let zeroTypes = null;
  if (byType) {
    const known = new Set(byType.map(entry => entry.value));
    zeroTypes = EMAIL_TYPES.filter(type => !known.has(type));
  }

  if (byType && total !== null && sumCounts(byType) !== total) {
    warnings.push(`Type groups sum to ${sumCounts(byType)} but the window total is ${total}; a field may be blank or hidden by field-level ACL. Read groups individually.`);
  }

  // Oldest send-ready row: all-time, because age is the point of the answer.
  let oldest = null;
  const oldestTimestamp = minResult.ok
    ? rawValue(minResult.value?.stats?.min?.sys_created_on) || null : null;
  if (oldestTimestamp) {
    const rows = await collect('oldest send-ready row', 'sys_email', () => sdk.list('sys_email', tableParams(
      ['sys_id', 'type', 'state', 'mailbox', 'direct', 'recipients', 'subject', 'sys_created_on'],
      { query: 'type=send-ready^ORDERBYsys_created_on', limit: 1, display: 'raw' },
    )), []);
    const row = Array.isArray(rows) ? rows[0] : null;
    const createdMs = parseInstanceTimestamp(oldestTimestamp);
    const ageSeconds = createdMs === null ? null : Math.max(0, Math.floor((now.getTime() - createdMs) / 1000));
    oldest = {
      sys_created_on: oldestTimestamp,
      sys_created_on_source: 'UTC',
      age_seconds: ageSeconds,
      age: describeAge(ageSeconds),
      scope: 'all time',
      sys_id: row?.sys_id ?? null,
      state: row?.state ?? null,
      mailbox: row?.mailbox ?? null,
      recipient: row?.direct || row?.recipients || null,
      subject: row?.subject ?? null,
    };
    if (ageSeconds === null) warnings.push('Oldest send-ready timestamp was not a parseable instance timestamp; age is unknown.');
  }

  // Feature switches that stop delivery without any per-message error.
  const switchRows = await collect('email switches', 'sys_properties', () => sdk.list('sys_properties', tableParams(
    ['sys_id', 'name', 'value'],
    { query: 'nameINglide.email.smtp.active,glide.email.read.active', limit: 10, display: 'raw' },
  )), null);
  let switches = null;
  if (switchRows) {
    const values = Object.fromEntries(switchRows.map(row => [row.name, row.value]));
    switches = {
      'glide.email.smtp.active': Object.hasOwn(values, 'glide.email.smtp.active') ? isTrue(values['glide.email.smtp.active']) : null,
      'glide.email.read.active': Object.hasOwn(values, 'glide.email.read.active') ? isTrue(values['glide.email.read.active']) : null,
      source: 'sys_properties',
    };
    for (const property of ['glide.email.smtp.active', 'glide.email.read.active']) {
      if (!Object.hasOwn(values, property)) notes.push(`${property} was not returned; its value is unknown, not false.`);
    }
  }

  // Active mail accounts. Never request the encrypted password field.
  const accountRows = await collect('email accounts', 'sys_email_account', () => sdk.list('sys_email_account', tableParams(
    ['sys_id', 'name', 'active', 'type', 'server', 'port', 'from', 'enable_tls', 'enable_ssl', 'connection_security', 'servicenow_configured'],
    { query: 'active=true', limit: 100, display: 'raw' },
  )), null);
  const accountTotal = await collect('email account total', 'sys_email_account', () => sdk.aggregateCount('sys_email_account', ''));
  const accountActive = await collect('email account active count', 'sys_email_account', () => sdk.aggregateCount('sys_email_account', 'active=true'));
  const accounts = accountRows === null && accountTotal === null ? null : {
    total: accountTotal,
    active: accountActive,
    rows: (accountRows || []).map(row => ({
      sys_id: row.sys_id,
      name: row.name,
      type: row.type,
      server: row.server,
      port: row.port,
      from: row.from,
      enable_tls: isTrue(row.enable_tls),
      enable_ssl: isTrue(row.enable_ssl),
      connection_security: row.connection_security,
      servicenow_configured: isTrue(row.servicenow_configured),
    })),
    rows_complete: accountRows !== null && accountRows.length === accountActive,
  };

  if (switches && switches['glide.email.smtp.active'] === false) {
    notes.push('glide.email.smtp.active is false: outbound mail is not being sent, so send-ready rows accumulate until it is turned on.');
  }
  notes.push('Counts are Stats API aggregates over the whole window, not a sample of one page.');
  if (oldest) notes.push('send-ready age is measured from the oldest send-ready row across all time, using its UTC sys_created_on.');

  return {
    table: 'sys_email',
    window,
    total,
    by_type: byType,
    by_state: byState,
    by_mailbox: byMailbox,
    zero_types_in_window: zeroTypes,
    type_groups_sum: byType ? sumCounts(byType) : null,
    oldest_send_ready: oldest,
    switches,
    email_accounts: accounts,
    unavailable,
    warnings,
    notes,
    read_only: true,
  };
}

const EMAIL_FIELDS = [
  'sys_id', 'type', 'state', 'status', 'mailbox', 'subject', 'direct', 'recipients', 'copied',
  'blind_copied', 'reply_to', 'error_string', 'message_id', 'receive_type', 'notification_type',
  'importance', 'instance', 'checkpoint', 'sys_created_on', 'sys_updated_on',
];

const SOURCE_TABLES = /^[a-z][a-z0-9_]*$/;

function emailDirection(type) {
  const value = String(type || '');
  if (value.startsWith('received')) return 'inbound';
  if (value.startsWith('send') || value === 'sent') return 'outbound';
  return 'unknown';
}

function resolveIdentifier(identifier) {
  const text = String(identifier ?? '').trim();
  if (!text) throw errUsage('jsn email why needs a sys_email sys_id or message_id.');
  if (text.includes('^') || text.includes('=') || /[\r\n]/.test(text)) {
    throw errUsage('Identifier contains encoded-query control characters; pass a plain sys_id or message_id.');
  }
  if (/^[0-9a-f]{32}$/i.test(text)) return { field: 'sys_id', value: text.toLowerCase() };
  return { field: 'message_id', value: text };
}

async function readSourceRecord(sdk, watermark) {
  const table = String(watermark.source_table || '');
  const sysId = String(watermark.source_id || '');
  if (!SOURCE_TABLES.test(table) || !sysId) return null;
  try {
    const rows = await sdk.list(table, tableParams(
      ['sys_id', 'number', 'short_description', 'name'],
      { query: `sys_id=${sysId}`, limit: 1, display: 'all' },
    ));
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { table, sys_id: sysId, found: false, label: null };
    const label = [displayValue(row.number), displayValue(row.short_description), displayValue(row.name)]
      .map(value => String(value || '').trim()).find(Boolean) || null;
    return { table, sys_id: sysId, found: true, label };
  } catch (error) {
    return { table, sys_id: sysId, found: null, label: null, error: messageOf(error), status: error?.status ?? null };
  }
}

async function readNotificationLabels(sdk, ids, unavailable) {
  const labels = new Map();
  for (const id of ids.slice(0, 10)) {
    try {
      const rows = await sdk.list('sysevent_email_action', tableParams(
        ['sys_id', 'name', 'active', 'type', 'event_name'],
        { query: `sys_id=${id}`, limit: 1, display: 'all' },
      ));
      const row = Array.isArray(rows) ? rows[0] : null;
      labels.set(id, row ? { name: displayValue(row.name) || null, active: isTrue(row.active), type: displayValue(row.type) || null } : null);
    } catch (error) {
      unavailable.push({ source: 'notification label', table: 'sysevent_email_action', error: messageOf(error), status: error?.status ?? null });
      labels.set(id, null);
    }
  }
  return labels;
}

async function readEventRows(sdk, ids, unavailable) {
  const events = new Map();
  for (const id of ids.slice(0, 10)) {
    try {
      const rows = await sdk.list('sysevent', tableParams(
        ['sys_id', 'name', 'state', 'processed', 'processing_duration', 'table'],
        { query: `sys_id=${id}`, limit: 1, display: 'all' },
      ));
      const row = Array.isArray(rows) ? rows[0] : null;
      events.set(id, row ? {
        name: displayValue(row.name) || null,
        state: displayValue(row.state) || null,
        processed: displayValue(row.processed) || null,
        processing_duration: displayValue(row.processing_duration) || null,
        table: displayValue(row.table) || null,
      } : null);
    } catch (error) {
      unavailable.push({ source: 'event label', table: 'sysevent', error: messageOf(error), status: error?.status ?? null });
      events.set(id, null);
    }
  }
  return events;
}

/**
 * Explain one sys_email row.
 *
 * @param {object} sdk
 * @param {string} identifier — 32-hex sys_id or exact message_id
 * @param {object} [options]
 */
export async function buildEmailWhy(sdk, identifier, { now = new Date() } = {}) {
  const target = resolveIdentifier(identifier);
  const unavailable = [];
  const notes = [];

  const rows = await sdk.list('sys_email', tableParams(EMAIL_FIELDS, {
    query: `${target.field}=${target.value}`, limit: 2, display: 'all',
  }));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw errNotFound('email', identifier);
  }
  if (rows.length > 1) {
    throw errUsage(`More than one email matches ${target.field}=${target.value}; pass the sys_id instead.`);
  }
  const record = rows[0];
  const sysId = String(rawValue(record.sys_id));
  const type = String(rawValue(record.type));
  const direction = emailDirection(type);

  const email = {
    sys_id: sysId,
    matched_on: target.field,
    type,
    state: displayValue(record.state) || null,
    status: displayValue(record.status) || null,
    direction,
    mailbox: displayValue(record.mailbox) || null,
    mailbox_value: rawValue(record.mailbox) || null,
    subject: displayValue(record.subject) || null,
    direct: displayValue(record.direct) || null,
    recipients: displayValue(record.recipients) || null,
    reply_to: displayValue(record.reply_to) || null,
    error_string: displayValue(record.error_string) || null,
    message_id: displayValue(record.message_id) || null,
    receive_type: displayValue(record.receive_type) || null,
    notification_type: displayValue(record.notification_type) || null,
    importance: displayValue(record.importance) || null,
    instance: displayValue(record.instance) || null,
    checkpoint: displayValue(record.checkpoint) || null,
    sys_created_on: displayValue(record.sys_created_on) || null,
    sys_created_on_utc: rawValue(record.sys_created_on) || null,
    sys_updated_on: displayValue(record.sys_updated_on) || null,
  };
  const createdMs = parseInstanceTimestamp(email.sys_created_on_utc);
  email.age_seconds = createdMs === null ? null : Math.max(0, Math.floor((now.getTime() - createdMs) / 1000));
  email.age = describeAge(email.age_seconds);
  if (email.age_seconds !== null) {
    notes.push('created is shown in the instance user time zone; age is measured from the UTC sys_created_on value.');
  }

  // Watermark: the per-message row that ties a received/sent message to the
  // source record it was produced from or applied to.
  const watermarkRows = await attempt('watermark', 'sys_watermark', () => sdk.list('sys_watermark', tableParams(
    ['sys_id', 'number', 'source_id', 'source_table', 'sys_created_on'],
    { query: `email=${sysId}`, limit: 21, display: 'raw' },
  )));
  const watermarkCount = await attempt('watermark count', 'sys_watermark', () => sdk.aggregateCount('sys_watermark', `email=${sysId}`));
  let watermarks = null;
  let watermarksTotal = watermarkCount.ok ? watermarkCount.value : null;
  if (watermarkRows.ok) {
    watermarks = [];
    for (const row of watermarkRows.value.slice(0, 20)) {
      watermarks.push({
        sys_id: row.sys_id,
        number: row.number || null,
        source_table: row.source_table || null,
        source_id: row.source_id || null,
        source: await readSourceRecord(sdk, row),
        sys_created_on: row.sys_created_on || null,
      });
    }
  } else {
    unavailable.push(watermarkRows.unavailable);
  }
  if (!watermarkCount.ok) unavailable.push(watermarkCount.unavailable);

  // Inbound actions are matched by the type value the instance stores (New /
  // Reply). receive_type records how ServiceNow classified the message; the
  // subject prefix is a fallback only. Matching is evidence of configuration,
  // not proof of execution.
  let inboundActions = null;
  const receiveType = String(email.receive_type || '').trim();
  const expectedActionType = receiveType
    || (/^\s*(re|fw|fwd)\s*:/i.test(email.subject || '') ? 'Reply' : 'New');
  if (direction === 'inbound') {
    const actionRows = await attempt('inbound actions', 'sysevent_in_email_action', () => sdk.list('sysevent_in_email_action', tableParams(
      ['sys_id', 'name', 'active', 'type', 'event_name'],
      { query: 'event_name=email.read', limit: 200, display: 'all' },
    )));
    if (actionRows.ok) {
      const mapped = actionRows.value.map(row => ({
        sys_id: rawValue(row.sys_id),
        name: displayValue(row.name) || null,
        active: isTrue(row.active),
        type: displayValue(row.type) || null,
        matches_message_type: String(displayValue(row.type)).toLowerCase() === expectedActionType.toLowerCase(),
      }));
      inboundActions = { expected_type: expectedActionType,
        expected_type_source: receiveType ? 'receive_type' : 'subject-prefix',
        candidates: mapped, matched: mapped.filter(row => row.matches_message_type) };
    } else {
      unavailable.push(actionRows.unavailable);
    }
  }

  // sys_email_log rows tied to this email, with notification + event labels.
  const logRows = await attempt('email log', 'sys_email_log', () => sdk.list('sys_email_log', tableParams(
    ['sys_id', 'notification', 'event', 'sys_created_on'],
    { query: `email=${sysId}^ORDERBYsys_created_on`, limit: 21, display: 'raw' },
  )));
  const logCount = await attempt('email log count', 'sys_email_log', () => sdk.aggregateCount('sys_email_log', `email=${sysId}`));
  let emailLog = null;
  const emailLogTotal = logCount.ok ? logCount.value : null;
  if (logRows.ok) {
    const rows = logRows.value.slice(0, 20);
    const notificationIds = [...new Set(rows.map(row => row.notification).filter(Boolean))];
    const eventIds = [...new Set(rows.map(row => row.event).filter(Boolean))];
    const notifications = await readNotificationLabels(sdk, notificationIds, unavailable);
    const events = await readEventRows(sdk, eventIds, unavailable);
    emailLog = rows.map(row => ({
      sys_id: row.sys_id,
      sys_created_on: row.sys_created_on || null,
      notification: row.notification ? { sys_id: row.notification, ...(notifications.get(row.notification) || {}) } : null,
      event: row.event ? { sys_id: row.event, ...(events.get(row.event) || {}) } : null,
    }));
  } else {
    unavailable.push(logRows.unavailable);
  }
  if (!logCount.ok) unavailable.push(logCount.unavailable);

  // syslog_email is the platform's email log table. It is frequently locked
  // down; a 403 is unavailable evidence, not "no log lines".
  const syslogRows = await attempt('syslog_email', 'syslog_email', () => sdk.list('syslog_email', tableParams(
    ['sys_id', 'email'],
    { query: `email=${sysId}`, limit: 50, display: 'raw' },
  )));
  let syslogEmail;
  if (syslogRows.ok) {
    syslogEmail = { available: true, rows: syslogRows.value.map(row => ({ sys_id: row.sys_id, email: row.email })),
      interpretation: 'unconfirmed' };
  } else {
    syslogEmail = { available: false, rows: null, error: syslogRows.unavailable.error, status: syslogRows.unavailable.status };
    unavailable.push(syslogRows.unavailable);
  }

  if (direction === 'inbound') {
    notes.push('sys_email does not store the inbound skip reason. Candidate actions are filtered by the type value (New/Reply) and are configuration evidence, not proof that an action ran.');
    if (watermarks && watermarks.length === 0) {
      notes.push('No sys_watermark row references this email. If it was ignored as a reply, no watermark match is the observable condition; the underlying skip reason is unconfirmed.');
    }
  } else if (direction === 'outbound') {
    notes.push('For outbound mail, the mailbox, type and error_string show delivery state; sys_email_log and syslog_email supply surrounding evidence.');
  }
  if (!syslogEmail.available) {
    notes.push(`syslog_email could not be read: ${syslogEmail.error} Skip reasons from that table are unavailable, not absent.`);
  }
  if (direction === 'inbound' && inboundActions && inboundActions.matched.length === 0) {
    notes.push(`No active/generic inbound action with type ${expectedActionType} was returned; the message may have matched none, or action rows may be restricted.`);
  }

  return {
    table: 'sys_email',
    identifier: { value: identifier, matched_on: target.field },
    email,
    watermarks,
    watermarks_total: watermarksTotal,
    watermarks_truncated: watermarks !== null && watermarksTotal !== null && watermarksTotal > watermarks.length,
    inbound_actions: inboundActions,
    email_log: emailLog,
    email_log_total: emailLogTotal,
    email_log_truncated: emailLog !== null && emailLogTotal !== null && emailLogTotal > emailLog.length,
    syslog_email: syslogEmail,
    unavailable,
    notes,
    read_only: true,
  };
}
