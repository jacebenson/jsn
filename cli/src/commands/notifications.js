import { SaxesParser } from 'saxes';
import { deliverySummary, describeNotification, listNotificationBodies, notificationTrigger } from '../notifications.js';
import { confirmAction, quoteShellArg } from '../helpers.js';
import { errAPI, errUsage } from '../errors.js';
import { displayValue, recordListParams } from '../records-engine.js';
import { isSysId, resolveRecord, unwrapSysId } from '../resolve-record.js';
import { queryDiagnostics, validateReadQuery } from '../query-validate.js';

const TABLE = 'sysevent_email_action';

// The delivery fields describeNotification needs, plus everything the list and
// why output read. We never ask for message_text unless a plain-text body is
// the thing being described.
const DELIVERY_FIELDS = ['generation_type', 'collection', 'action_insert', 'action_update', 'event_name',
  'condition', 'advanced_condition', 'content_type', 'template', 'message_html'];
const DETAIL_FIELDS = [...DELIVERY_FIELDS, 'sys_id', 'name', 'active', 'weight', 'sys_scope', 'subject', 'from',
  'reply_to', 'mandatory', 'send_self', 'exclude_delegates', 'force_delivery', 'subscribable', 'digestable',
  'default_digest', 'recipient_users', 'recipient_groups', 'recipient_fields', 'event_parm_1', 'event_parm_2',
  'message_text', 'sys_updated_on', 'sys_created_on'];
const LIST_FIELDS = ['sys_id', 'name', 'collection', 'generation_type', 'active', 'weight', 'sys_scope',
  ...DELIVERY_FIELDS, 'recipient_users', 'recipient_groups', 'recipient_fields', 'event_parm_1', 'event_parm_2',
  'send_self', 'exclude_delegates'];
const DEFAULT_COLUMNS = ['name', 'collection', 'generation_type', 'active', 'weight', 'sends_on', 'recipients', 'body'];
const OUTPUT_FIELDS = [...DEFAULT_COLUMNS, 'sys_id', 'sys_scope', 'collection_label', 'trigger_kind', 'scope_label', 'delivery'];
const SWITCHES = ['glide.email.smtp.active', 'glide.email.notification.save_when_no_recipients',
  'glide.user.default_notification', 'glide.notification.preview_notification.allow_all'];

const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const shown = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const present = value => raw(value).trim() !== '';
const truthy = value => ['true', '1', 'yes', true, 1].includes(value && typeof value === 'object' ? value.value : value);
const splitList = value => raw(value).split(',').map(item => item.trim()).filter(Boolean);

function requireTable(table) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(table || ''))) throw errUsage('Invalid table name.');
  return table;
}

function bounded(value, { label = '--limit', min = 1, max = 200, fallback = 50 } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw errUsage(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function boundedOffset(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw errUsage('--offset must be a nonnegative integer.');
  return value;
}

async function readRows(sdk, table, query, fields, { limit = 200, offset, display = 'all' } = {}) {
  return sdk.listStrict(table, recordListParams({ limit, offset, query, fields, displayValue: display }));
}

function recipientConfig(record) {
  return {
    users: splitList(record.recipient_users),
    user_labels: shown(record.recipient_users) || null,
    groups: splitList(record.recipient_groups),
    group_labels: shown(record.recipient_groups) || null,
    fields: splitList(record.recipient_fields),
    event_parm_1_contains_recipient: truthy(record.event_parm_1),
    event_parm_2_contains_recipient: truthy(record.event_parm_2),
    send_self: truthy(record.send_self),
    exclude_delegates: truthy(record.exclude_delegates),
  };
}

function recipientText(config) {
  const parts = [];
  if (config.users.length) parts.push(`users ${config.user_labels || config.users.join(', ')}`);
  if (config.groups.length) parts.push(`groups ${config.group_labels || config.groups.join(', ')}`);
  if (config.fields.length) parts.push(`fields ${config.fields.join(', ')}`);
  if (config.event_parm_1_contains_recipient) parts.push('event parm 1');
  if (config.event_parm_2_contains_recipient) parts.push('event parm 2');
  if (config.send_self) parts.push('event creator');
  return parts.length ? parts.join('; ') : 'no recipients configured';
}

function triggerText(trigger) {
  if (!trigger) return 'unavailable';
  if (trigger.kind === 'record') {
    const actions = [trigger.on_insert && 'insert', trigger.on_update && 'update'].filter(Boolean);
    return `record ${actions.join(' or ') || '(neither insert nor update)'}${trigger.condition ? `; condition ${trigger.condition}` : '; no condition'}${trigger.advanced_condition ? '; advanced condition' : ''}`;
  }
  if (trigger.kind === 'event') return `event ${trigger.event || '(no event name)'}`;
  return 'flow (not covered by notifications why)';
}

function bodyText(body) {
  if (!body) return 'unavailable';
  if (body.status !== 'complete') return `${body.status}: ${body.reason}`;
  if (body.source === 'template') return `template ${body.template?.name || body.template?.sys_id}`;
  return body.template ? `own message_html (template ${body.template.name || body.template.sys_id} has no body)` : 'own message_html';
}

function shapeListRecord(record, body, mode = 'both') {
  const trigger = notificationTrigger(record);
  const recipients = recipientConfig(record);
  const field = mode === 'display' ? shown : raw;
  return {
    sys_id: raw(record.sys_id),
    name: shown(record.name) || raw(record.name),
    collection: raw(record.collection) || null,
    collection_label: shown(record.collection) || null,
    generation_type: field(record.generation_type) || null,
    trigger_kind: trigger?.kind || 'unknown',
    active: raw(record.active),
    weight: present(record.weight) ? raw(record.weight) : null,
    sys_scope: raw(record.sys_scope) || null,
    scope_label: shown(record.sys_scope) || null,
    sends_on: triggerText(trigger),
    recipients: recipientText(recipients),
    body: bodyText(body),
    delivery: { trigger, recipients, body },
  };
}

function listBreadcrumbs(records) {
  return records.slice(0, 5).map(record => ({
    action: 'show',
    cmd: `jsn notifications show ${quoteShellArg(raw(record.sys_id))}`,
    description: `Inspect ${shown(record.name) || raw(record.name)}`,
  }));
}

function buildList(wrap) {
  return {
    command: 'list',
    aliases: ['ls'],
    describe: 'List outbound notifications with when they send, who they target and which body wins',
    builder: y => y
      .option('query', { type: 'string', describe: 'Encoded query (e.g. "collection=incident^active=true")' })
      .option('columns', { alias: ['c', 'fields'], type: 'string', describe: `Comma-separated output fields (${OUTPUT_FIELDS.join(', ')})` })
      .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records (1-200)' })
      .option('offset', { type: 'number', default: 0, describe: 'Pagination offset' })
      .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' }),
    handler: wrap(async (argv, app) => {
      const query = argv.query || '';
      const limit = bounded(argv.limit);
      const offset = boundedOffset(argv.offset);
      const verdict = await validateReadQuery(app, { table: TABLE, query, refresh: argv['refresh-metadata'] });
      const columns = argv.columns ? argv.columns.split(',').map(column => column.trim()).filter(Boolean) : DEFAULT_COLUMNS;
      const unknown = columns.filter(column => !OUTPUT_FIELDS.includes(column));
      if (unknown.length) throw errUsage(`Unknown list field(s): ${unknown.join(', ')}. Use ${OUTPUT_FIELDS.join(', ')}.`);
      const ordered = `${query}${query ? '^' : ''}ORDERBYDESCsys_updated_on`;
      const records = await readRows(app.sdk, TABLE, ordered, LIST_FIELDS, { limit, offset, display: 'all' });
      const bodies = await listNotificationBodies(app.sdk, records);
      const mode = argv.displayValues || 'both';
      const shaped = records.map(record => shapeListRecord(record, bodies.get(raw(record.sys_id)), mode));
      app.ok({
        table: TABLE,
        count: shaped.length,
        columns,
        records: shaped.map(record => Object.fromEntries(columns.map(column => [column, record[column]]))),
        pagination: { limit, offset, has_more: shaped.length === limit },
        context: { instance_url: app.getEffectiveInstance() },
        ...queryDiagnostics(verdict),
      }, {
        summary: `${shaped.length} notification(s)`,
        breadcrumbs: listBreadcrumbs(records),
      });
    }),
  };
}

function buildShow(wrap) {
  return {
    command: 'show <identifier>',
    aliases: ['get'],
    describe: 'Show one notification: trigger, recipients, weight and the body that wins',
    builder: y => y
      .option('identifier-field', { type: 'string', describe: 'Exact field for disambiguation (name, sys_id)' })
      .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' }),
    handler: wrap(async (argv, app) => {
      const mode = argv.displayValues || 'both';
      const record = await resolveRecord(app.sdk, {
        table: TABLE, identifier: argv.identifier, matchField: 'name', identifierField: argv.identifierField,
        fields: DETAIL_FIELDS, displayValue: displayValue(mode), resource: 'notification',
      });
      record.recipients = recipientConfig(record);
      record._delivery = await describeNotification(app.sdk, record, { displayValues: mode });
      const id = unwrapSysId(record);
      app.ok(record, {
        summary: deliverySummary(record, id),
        breadcrumbs: [
          { action: 'list', cmd: 'jsn notifications list', description: 'Back to all notifications' },
          { action: 'why', cmd: `jsn notifications why ${quoteShellArg(raw(record.collection) || '<table>')} <number|sys_id> <user>`, description: 'Explain delivery for a record and user' },
        ],
      });
    }),
  };
}

// ── why ────────────────────────────────────────────────────────────────────

async function safeRead(label, read) {
  try { return { status: 'available', rows: await read() }; }
  catch (error) { return { status: 'unavailable', reason: `Could not read ${label}: ${error.message}`, code: error.code, http_status: error.status }; }
}

function countResult(result, total) {
  return result.status === 'available' ? { status: 'available', count: result.rows.length, total: total ?? null,
    truncated: total != null ? result.rows.length < total : result.rows.length === 200 } : result;
}

async function readCount(sdk, table, query) {
  try { return await sdk.aggregateCount(table, query, { strict: true }); }
  catch { return null; }
}

function pickRecordLabel(record) {
  return raw(record.number) || shown(record.number) || shown(record.name) || shown(record.short_description)
    || shown(record.sys_id) || null;
}

function buildWhy(wrap) {
  return {
    command: 'why <table> <identifier> <user>',
    describe: 'Explain, per notification on a table, whether it fired for a record and why a user was or was not a recipient',
    builder: y => y
      .option('identifier-field', { type: 'string', default: 'number', describe: 'Record identifier field (number by default; use sys_id for tables without a number)' })
      .option('user-field', { type: 'string', default: 'user_name', describe: 'User identifier field (user_name, email or sys_id)' })
      .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max evidence rows per source (1-200)' })
      .option('include-inactive', { type: 'boolean', default: false, describe: 'Include inactive notifications on the table' }),
    handler: wrap(async (argv, app) => {
      const table = requireTable(argv.table);
      const evidenceLimit = bounded(argv.limit);
      const identifierField = String(argv.identifierField || (isSysId(argv.identifier) ? 'sys_id' : 'number'));
      if (identifierField === 'sys_id' && !isSysId(argv.identifier)) throw errUsage('Use a full 32-character sys_id when --identifier-field is sys_id.');
      const recordRef = await resolveRecord(app.sdk, {
        table, identifier: argv.identifier, matchField: identifierField,
        fields: ['sys_id', 'number', 'name', 'short_description'], displayValue: 'all', resource: `${table} record`,
      });
      const recordId = unwrapSysId(recordRef);
      const user = await resolveRecord(app.sdk, {
        table: 'sys_user', identifier: argv.user, matchField: argv.userField || 'user_name',
        fields: ['sys_id', 'user_name', 'name', 'email', 'active', 'notification'], displayValue: 'all', resource: 'user',
      });
      const userId = unwrapSysId(user);
      const userEmail = raw(user.email);
      const userActive = truthy(user.active);

      const notificationQuery = `collection=${table}${argv.includeInactive ? '' : '^active=true'}^ORDERBYDESCweight`;
      const notifications = await readRows(app.sdk, TABLE, notificationQuery, DETAIL_FIELDS, { limit: 200, display: 'all' });
      const notificationTotal = await readCount(app.sdk, TABLE, notificationQuery);
      const flowNotifications = notifications.filter(record => raw(record.generation_type) === 'triggered');

      const [eventsRead, emailTotal, devicesRead, subscriptionsRead, choiceRead, propertiesRead] = await Promise.all([
        safeRead('sysevent rows for this record', () => readRows(app.sdk, 'sysevent', `instance=${recordId}`,
          ['sys_id', 'name', 'instance', 'parm1', 'parm2', 'state', 'processed', 'process_on', 'queue', 'table', 'sys_created_on'],
          { limit: 200, display: 'false' })),
        readCount(app.sdk, 'sys_email', `instance=${recordId}`),
        safeRead('the user devices', () => readRows(app.sdk, 'cmn_notif_device', `user=${userId}`,
          ['sys_id', 'name', 'type', 'active', 'primary_email', 'email_address', 'phone_number', 'order'], { limit: 100, display: 'all' })),
        safeRead('the user subscriptions', () => readRows(app.sdk, 'cmn_notif_message', `user=${userId}`,
          ['sys_id', 'notification', 'collection', 'device', 'name', 'condition'], { limit: 200, display: 'all' })),
        safeRead('the notification choice labels', () => readRows(app.sdk, 'sys_choice', 'name=sys_user^element=notification',
          ['value', 'label'], { limit: 50, display: 'false' })),
        safeRead('the instance switches', () => readRows(app.sdk, 'sys_properties', `nameIN${SWITCHES.join(',')}`,
          ['name', 'value'], { limit: 20, display: 'false' })),
      ]);

      const eventResult = countResult(eventsRead, await readCount(app.sdk, 'sysevent', `instance=${recordId}`));
      const events = eventsRead.status === 'available' ? eventsRead.rows : [];
      const emailsRead = eventResult.status === 'available'
        ? await safeRead('the emails for this record', () => readRows(app.sdk, 'sys_email', `instance=${recordId}`,
          ['sys_id', 'instance', 'subject', 'recipients', 'user_id', 'state', 'status', 'notification_type', 'weight', 'target_table', 'sys_created_on'],
          { limit: 200, display: 'all' }))
        : { status: 'unavailable', reason: 'The event evidence needed to bound email reads was unavailable.' };
      const emailList = emailsRead.status === 'available' ? emailsRead.rows : [];
      const emailIds = emailList.map(email => raw(email.sys_id)).filter(Boolean);
      const logRead = emailIds.length
        ? await safeRead('the email-to-notification index', async () => {
          const rows = [];
          for (let index = 0; index < emailIds.length; index += 50) {
            const chunk = emailIds.slice(index, index + 50);
            rows.push(...await readRows(app.sdk, 'sys_email_log', `emailIN${chunk.join(',')}`,
              ['sys_id', 'notification', 'event', 'email', 'sys_created_on'], { limit: 200, display: 'false' }));
          }
          return rows;
        })
        : { status: 'available', rows: [] };
      const logs = logRead.status === 'available' ? logRead.rows : [];
      const emailsById = new Map(emailList.map(email => [raw(email.sys_id), email]));

      const choiceLabels = new Map(choiceRead.status === 'available'
        ? choiceRead.rows.map(row => [raw(row.value), shown(row.label)])
        : []);
      const properties = new Map(propertiesRead.status === 'available'
        ? propertiesRead.rows.map(row => [raw(row.name), raw(row.value)])
        : []);
      const switchValue = name => {
        if (propertiesRead.status !== 'available') return { status: 'unavailable', reason: propertiesRead.reason };
        if (!properties.has(name)) return { status: 'not_configured', value: null };
        return { status: 'configured', value: properties.get(name) };
      };
      const switches = Object.fromEntries(SWITCHES.map(name => [name, switchValue(name)]));
      const smtp = switches['glide.email.smtp.active'];
      const saveWhenNoRecipients = switches['glide.email.notification.save_when_no_recipients'];

      const devices = devicesRead.status === 'available' ? devicesRead.rows : [];
      const addresses = [...new Set([userEmail, ...devices.filter(device => truthy(device.active))
        .map(device => raw(device.email_address))].filter(Boolean))];
      const recipientLog = addresses.length
        ? await safeRead('the platform recipient log', () => readRows(app.sdk, 'syslog_email',
          addresses.length === 1 ? `email=${addresses[0]}` : `emailIN${addresses.join(',')}`,
          ['sys_id', 'email', 'message', 'source', 'level', 'sys_created_on'], { limit: 200, display: 'all' }))
        : { status: 'no_email', reason: 'The user has no email address on sys_user or an active email device, so the recipient log cannot be attributed.' };
      const recipientRows = recipientLog.status === 'available' ? recipientLog.rows : [];

      const subscriptions = subscriptionsRead.status === 'available' ? subscriptionsRead.rows : [];
      const notificationIds = new Set(notifications.map(notification => raw(notification.sys_id)));
      const tableSubscriptions = subscriptions.filter(subscription =>
        (raw(subscription.notification) && notificationIds.has(raw(subscription.notification)))
        || (!raw(subscription.notification) && raw(subscription.collection) === table));
      const subscriptionFor = notificationId => tableSubscriptions.filter(subscription =>
        raw(subscription.notification) === notificationId
        || (!raw(subscription.notification) && raw(subscription.collection) === table));

      const recordFields = [...new Set(notifications.flatMap(record => splitList(record.recipient_fields)))]
        .filter(field => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field));
      let recordDetail = { status: 'not_needed', values: {} };
      if (recordFields.length) {
        const detailRead = await safeRead('the recipient field values', () => readRows(app.sdk, table, `sys_id=${recordId}`,
          ['sys_id', ...recordFields], { limit: 1, display: 'all' }));
        recordDetail = detailRead.status === 'available' && detailRead.rows[0]
          ? { status: 'available', values: Object.fromEntries(recordFields.map(field => [field, detailRead.rows[0][field] ?? null])) }
          : { status: 'unavailable', reason: detailRead.reason || 'The record was not returned.', values: {} };
      }

      const userSetting = raw(user.notification);
      const userFacts = {
        sys_id: userId,
        user_name: shown(user.user_name) || raw(user.user_name),
        name: shown(user.name) || null,
        email: userEmail || null,
        active: userActive,
        notification_setting: {
          value: userSetting || null,
          label: userSetting ? (choiceLabels.get(userSetting) || null) : null,
          source: userSetting ? 'user' : 'default',
          ...(userSetting ? {} : {
            default_property: switches['glide.user.default_notification'],
            default_label: switches['glide.user.default_notification']?.value
              ? (choiceLabels.get(switches['glide.user.default_notification'].value) || null) : null,
          }),
        },
        devices: devices.map(device => ({
          name: shown(device.name) || null, type: shown(device.type) || raw(device.type) || null,
          active: truthy(device.active), primary_email: truthy(device.primary_email),
          email_address: raw(device.email_address) || null, phone_number: raw(device.phone_number) || null,
        })),
        subscriptions: {
          status: subscriptionsRead.status,
          ...(subscriptionsRead.status !== 'available' ? { reason: subscriptionsRead.reason } : {
            count: subscriptions.length,
            for_this_table: tableSubscriptions.map(subscription => ({
              sys_id: raw(subscription.sys_id), notification: raw(subscription.notification) || null,
              name: shown(subscription.name) || null, collection: raw(subscription.collection) || null,
            })),
          }),
        },
      };

      const recipientLogFor = notification => {
        if (recipientLog.status !== 'available') return { status: recipientLog.status, reason: recipientLog.reason };
        const keys = [raw(notification.name).toLowerCase(), raw(notification.sys_id).toLowerCase()].filter(Boolean);
        const rows = recipientRows.filter(row => {
          const text = `${raw(row.message)} ${raw(row.source)}`.toLowerCase();
          return keys.some(key => text.includes(key));
        });
        return { status: 'available', attribution: 'message/source text match', count: rows.length,
          rows: rows.slice(0, evidenceLimit).map(row => ({
            sys_created_on: raw(row.sys_created_on) || null, email: raw(row.email) || null,
            level: raw(row.level) || null, source: raw(row.source) || null, message: raw(row.message) || null,
          })),
          truncated: rows.length > evidenceLimit,
          ...(rows.length ? {} : { note: 'No recipient log row mentions this notification; syslog_email has no notification reference, so text is the only available join.' }),
        };
      };

      const rendered = notifications.map(notification => {
        const id = raw(notification.sys_id);
        const generation = raw(notification.generation_type);
        const isFlow = generation === 'triggered';
        const matchedEvents = events.filter(event => isFlow ? false
          : generation === 'event' ? raw(event.name) === raw(notification.event_name)
            : generation === 'engine' ? raw(event.name) === 'notification_engine.process' && raw(event.parm1) === id
              : false);
        const notificationLogs = logs.filter(log => raw(log.notification) === id);
        const matchedEmails = [...new Map(notificationLogs.map(log => {
          const email = emailsById.get(raw(log.email));
          return [raw(log.email), email ? { ...email, event: raw(log.event) || null } : null];
        }).filter(([, email]) => email && raw(email.instance) === recordId)).values()];
        const state = isFlow ? 'not_covered'
          : matchedEvents.length || matchedEmails.length ? 'logged'
            : eventsRead.status !== 'available' || emailsRead.status !== 'available' || logRead.status !== 'available' ? 'unavailable'
              : 'not_logged';
        const fields = splitList(notification.recipient_fields);
        const values = Object.fromEntries(fields.map(field => [field, recordDetail.status === 'available' ? recordDetail.values[field] ?? null : null]));
        return {
          sys_id: id,
          name: shown(notification.name) || raw(notification.name),
          active: truthy(notification.active),
          generation_type: generation || null,
          trigger: notificationTrigger(notification),
          weight: present(notification.weight) ? raw(notification.weight) : null,
          recipients: recipientConfig(notification),
          subscriptions: {
            status: subscriptionsRead.status,
            ...(subscriptionsRead.status !== 'available' ? { reason: subscriptionsRead.reason } : {
              matching: subscriptionFor(id).map(subscription => ({
                sys_id: raw(subscription.sys_id), notification: raw(subscription.notification) || null,
                name: shown(subscription.name) || null, collection: raw(subscription.collection) || null,
                condition: raw(subscription.condition) || null,
              })),
            }),
          },
          evidence: {
            status: state,
            ...(isFlow ? { reason: 'Flow-triggered notifications are out of scope for this evidence view.' } : {}),
            ...(state === 'not_logged' ? { note: `No ${generation === 'event' ? `"${raw(notification.event_name)}" event` : 'notification_engine.process event'} or linked email was logged for this record.` } : {}),
            ...(state === 'unavailable' ? { reason: [eventsRead, emailsRead, logRead].filter(read => read.status !== 'available').map(read => read.reason).join(' ') } : {}),
            events: { status: eventsRead.status, count: matchedEvents.length, rows: matchedEvents.slice(0, evidenceLimit).map(event => ({
              sys_id: raw(event.sys_id), name: raw(event.name) || null, parm1: raw(event.parm1) || null, parm2: raw(event.parm2) || null,
              state: raw(event.state) || null, processed: raw(event.processed) || null, process_on: raw(event.process_on) || null,
              sys_created_on: raw(event.sys_created_on) || null,
            })), truncated: matchedEvents.length > evidenceLimit },
            emails: { status: emailsRead.status === 'available' && logRead.status === 'available' ? 'available' : 'unavailable',
              count: matchedEmails.length, rows: matchedEmails.slice(0, evidenceLimit).map(email => ({
                sys_id: raw(email.sys_id), event: email.event, subject: shown(email.subject) || raw(email.subject) || null,
                recipients: raw(email.recipients) || null, state: raw(email.state) || null, status: raw(email.status) || null,
                notification_type: raw(email.notification_type) || null, sys_created_on: raw(email.sys_created_on) || null,
              })), truncated: matchedEmails.length > evidenceLimit },
          },
          recipient_log: recipientLogFor(notification),
          ...(state === 'not_logged' ? { record_values: { status: recordDetail.status, fields: values } } : {}),
        };
      });

      const covered = rendered.filter(item => item.evidence.status !== 'not_covered').length;
      const gaps = [];
      if (flowNotifications.length) gaps.push(`${flowNotifications.length} flow-triggered notification(s) on ${table} were not covered; their evidence lives in flow execution records, not this engine.`);
      if (recipientLog.status === 'unavailable') gaps.push(`Recipient inclusion/exclusion reasons are unavailable: ${recipientLog.reason}`);
      if (recipientLog.status === 'no_email') gaps.push(recipientLog.reason);
      if (smtp.status === 'configured' && smtp.value === 'false') gaps.push('Outbound SMTP is disabled (glide.email.smtp.active=false); saved emails remain send-ready in the Outbox and were not delivered.');
      if (saveWhenNoRecipients.status === 'not_configured') gaps.push('glide.email.notification.save_when_no_recipients is not configured (platform default is false): with no recipients, no sys_email row is saved, so a missing email is not proof the condition failed.');
      if (saveWhenNoRecipients.status === 'configured' && saveWhenNoRecipients.value === 'false') gaps.push('glide.email.notification.save_when_no_recipients=false: with no recipients, no sys_email row is saved.');
      if (eventResult.status === 'available' && eventResult.total != null && eventResult.total > events.length) gaps.push(`Event evidence is truncated: read ${events.length} of ${eventResult.total} sysevent row(s) for this record.`);
      if (emailsRead.status !== 'available') gaps.push(`Email evidence is unavailable: ${emailsRead.reason}`);
      if (logRead.status !== 'available') gaps.push(`Email-to-notification evidence is unavailable: ${logRead.reason}`);
      if (emailsRead.status === 'available' && emailTotal != null && emailList.length < emailTotal) gaps.push(`Email evidence is truncated: read ${emailList.length} of ${emailTotal} sys_email row(s) for this record.`);

      const data = {
        record: {
          table, sys_id: recordId,
          identifier: argv.identifier,
          label: pickRecordLabel(recordRef),
          values: recordDetail.status === 'available' ? Object.fromEntries(Object.entries(recordDetail.values).map(([field, value]) => [field, value && typeof value === 'object'
            ? { value: value.value ?? null, display_value: value.display_value ?? null } : value])) : null,
          values_status: recordDetail.status,
          ...(recordDetail.reason ? { values_reason: recordDetail.reason } : {}),
        },
        user: userFacts,
        instance: { switches, smtp_effect: smtp.status === 'configured' && smtp.value === 'false' ? 'emails remain in the Outbox' : null },
        notifications: rendered,
        coverage: {
          notifications_read: notifications.length,
          notifications_total: notificationTotal,
          active_only: !argv.includeInactive,
          covered,
          flow_not_covered: flowNotifications.length,
        },
        gaps,
      };
      Object.defineProperty(data, '_formatted', { value: renderWhy(data), enumerable: false });
      app.ok(data, { summary: `${rendered.length} notification(s) on ${table}; ${covered} covered, ${flowNotifications.length} flow-triggered not covered` });
    }),
  };
}

function renderWhy(data) {
  const lines = [
    `Notification evidence for ${data.record.table} ${data.record.label || data.record.sys_id}`,
    `User: ${data.user.name || data.user.user_name} <${data.user.email || 'no email'}>; active=${data.user.active}; notification setting ${data.user.notification_setting.value || '(default)'}${data.user.notification_setting.label ? ` (${data.user.notification_setting.label})` : ''}`,
    `Devices: ${data.user.devices.length ? data.user.devices.map(device => `${device.name || device.type || 'device'}${device.active ? '' : ' (inactive)'}${device.email_address ? ` <${device.email_address}>` : ''}`).join(', ') : 'none'}`,
    `Subscriptions: ${data.user.subscriptions.status === 'available' ? `${data.user.subscriptions.count} row(s), ${data.user.subscriptions.for_this_table.length} for this table` : `unavailable: ${data.user.subscriptions.reason}`}`,
    '',
  ];
  for (const notification of data.notifications) {
    const state = notification.evidence.status === 'logged' ? 'logged'
      : notification.evidence.status === 'not_logged' ? 'no event or email logged'
        : notification.evidence.status === 'not_covered' ? 'not covered (flow-triggered)' : notification.evidence.status;
    lines.push(`  ${notification.name} [${notification.generation_type || 'unknown'}, weight ${notification.weight ?? 'unset'}] — ${state}`);
    lines.push(`    Recipients: ${recipientText(notification.recipients)}`);
    for (const event of notification.evidence.events.rows) lines.push(`    Event ${event.name} ${event.sys_created_on || ''} (${event.state || 'state unknown'})`);
    for (const email of notification.evidence.emails.rows) lines.push(`    Email ${email.subject || email.sys_id} to ${email.recipients || '(none)'} state=${email.state || 'unknown'}`);
    if (notification.recipient_log.status === 'available') {
      for (const row of notification.recipient_log.rows) lines.push(`    Recipient log ${row.sys_created_on || ''}: ${row.message || ''}`);
      if (!notification.recipient_log.count) lines.push('    Recipient log: no row mentions this notification.');
    } else {
      lines.push(`    Recipient log: ${notification.recipient_log.status}`);
    }
    if (notification.evidence.status === 'not_logged') {
      const fields = Object.entries(notification.record_values.fields);
      lines.push(`    Record values: ${fields.length ? fields.map(([field, value]) => `${field}=${value && typeof value === 'object' ? (value.display_value || value.value || '(empty)') : (value ?? '(empty)')}`).join(', ') : '(no recipient fields configured)'}`);
    }
  }
  lines.push('');
  lines.push(`Coverage: ${data.coverage.covered}/${data.coverage.notifications_read} notification(s); ${data.coverage.flow_not_covered} flow-triggered not covered.`);
  for (const gap of data.gaps) lines.push(`Gap: ${gap}`);
  return lines.join('\n');
}

// ── preview ────────────────────────────────────────────────────────────────

function decodeAnswer(xml) {
  let answer;
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw errAPI(200, 'Unexpected document type in NotificationSimulator response.'); });
  parser.on('opentag', node => { if (node.name === 'xml' && node.attributes) answer = node.attributes.answer; });
  try { parser.write(xml).close(); }
  catch (error) { if (error.code) throw error; throw errAPI(200, 'Malformed NotificationSimulator XML response.'); }
  if (typeof answer !== 'string') throw errAPI(200, 'NotificationSimulator returned no answer; check endpoint access.');
  return answer;
}

async function countFor(sdk, table, query) {
  try { return { before: await sdk.aggregateCount(table, query, { strict: true }) }; }
  catch (error) { return { status: 'unavailable', reason: `Could not count ${table}: ${error.message}` }; }
}

async function finishCount(sdk, table, query, entry) {
  if (entry.status === 'unavailable') return entry;
  try {
    entry.after = await sdk.aggregateCount(table, query, { strict: true });
    entry.unchanged = entry.before === entry.after;
    return entry;
  } catch (error) {
    return { ...entry, status: 'unavailable', reason: `Could not recount ${table}: ${error.message}` };
  }
}

function buildPreview(wrap) {
  return {
    command: 'preview <notification> <table> <identifier>',
    describe: 'Render a notification for one record through the platform NotificationSimulator (mutation: runs mail scripts, sends nothing)',
    builder: y => y
      .option('identifier-field', { type: 'string', default: 'number', describe: 'Record identifier field (number by default; use sys_id for tables without a number)' })
      .option('user', { type: 'string', describe: 'Optional user_name or sys_id for the simulation' })
      .option('event', { type: 'string', describe: 'Optional event sys_id' })
      .option('changed-fields', { type: 'string', describe: 'Optional comma-separated changed field names' }),
    handler: wrap(async (argv, app) => {
      const table = requireTable(argv.table);
      const notification = await resolveRecord(app.sdk, {
        table: TABLE, identifier: argv.notification, matchField: 'name', fields: ['sys_id', 'name', 'collection', 'active'],
        displayValue: 'all', resource: 'notification',
      });
      const notificationId = unwrapSysId(notification);
      const configuredTable = raw(notification.collection);
      if (configuredTable && configuredTable !== table) throw errUsage(`Notification "${shown(notification.name) || notificationId}" is configured for ${configuredTable}, not ${table}.`);
      const identifierField = String(argv.identifierField || (isSysId(argv.identifier) ? 'sys_id' : 'number'));
      if (identifierField === 'sys_id' && !isSysId(argv.identifier)) throw errUsage('Use a full 32-character sys_id when --identifier-field is sys_id.');
      const record = await resolveRecord(app.sdk, {
        table, identifier: argv.identifier, matchField: identifierField,
        fields: ['sys_id', 'number', 'name', 'short_description'], displayValue: 'all', resource: `${table} record`,
      });
      const recordId = unwrapSysId(record);
      let userId = '';
      if (argv.user) {
        const user = await resolveRecord(app.sdk, {
          table: 'sys_user', identifier: argv.user, matchField: 'user_name', fields: ['sys_id'], displayValue: 'false', resource: 'user',
        });
        userId = unwrapSysId(user);
      }
      if (argv.event && !isSysId(argv.event)) throw errUsage('--event must be a full 32-character sys_id.');
      const changedFields = argv.changedFields ? argv.changedFields.split(',').map(field => field.trim()).filter(Boolean) : [];
      if (changedFields.some(field => !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field))) throw errUsage('--changed-fields must be comma-separated field names.');

      await confirmAction(app, argv, `Run the NotificationSimulator for "${shown(notification.name) || notificationId}" on ${table} ${pickRecordLabel(record)}? It runs mail scripts and sends no email.`);

      const emailQuery = `instance=${recordId}`;
      const checks = {
        sys_email: await countFor(app.sdk, 'sys_email', emailQuery),
        sysevent: await countFor(app.sdk, 'sysevent', emailQuery),
        syslog_email: await countFor(app.sdk, 'syslog_email', ''),
      };
      const parameters = new URLSearchParams({
        sysparm_processor: 'NotificationSimulator', sysparm_name: 'simulate',
        sysparm_email_action_id: notificationId, sysparm_record_id: recordId,
        sysparm_user_id: userId, sysparm_event_id: argv.event || '', sysparm_changed_fields: changedFields.join(','),
      });
      const answer = decodeAnswer(await app.sdk.rawRequest(`${app.sdk.baseURL}/xmlhttp.do?${parameters}`, { method: 'POST' }));
      let simulation;
      try { simulation = { parsed: true, value: JSON.parse(answer) }; }
      catch { simulation = { parsed: false, raw_answer: answer }; }
      checks.sys_email = await finishCount(app.sdk, 'sys_email', emailQuery, checks.sys_email);
      checks.sysevent = await finishCount(app.sdk, 'sysevent', emailQuery, checks.sysevent);
      checks.syslog_email = await finishCount(app.sdk, 'syslog_email', '', checks.syslog_email);

      const answerValue = simulation.parsed ? simulation.value : null;
      const buckets = answerValue && typeof answerValue === 'object' ? {
        included_users: answerValue.includedUsers ?? null,
        excluded_users: answerValue.excludedUsers ?? null,
        included_emails: answerValue.includedEmails ?? null,
      } : null;
      const data = {
        notification: { sys_id: notificationId, name: shown(notification.name) || null, table: configuredTable || null },
        record: { table, sys_id: recordId, label: pickRecordLabel(record) },
        simulation,
        recipients: {
          // Derived, never assumed: an answer that carries buckets is evidence,
          // and one that does not is reported as unavailable.
          status: buckets && [buckets.included_users, buckets.excluded_users, buckets.included_emails].some(list => Array.isArray(list)) ? 'reported' : 'unavailable',
          buckets,
          reason: 'The NotificationSimulator answer does not explain the platform\'s inclusion or exclusion decision. Use jsn notifications why <table> <number|sys_id> <user> for recipient evidence.',
        },
        write_check: {
          note: `sys_email and sysevent counts are scoped to ${table} ${recordId}; the syslog_email count is instance-wide because that table has no record reference.`,
          ...checks,
        },
      };
      Object.defineProperty(data, '_formatted', { value: renderPreview(data), enumerable: false });
      app.ok(data, { summary: `Notification simulated: ${shown(notification.name) || notificationId}` });
    }),
  };
}

function renderPreview(data) {
  const lines = [
    `Notification simulation: ${data.notification.name || data.notification.sys_id}`,
    `Record: ${data.record.table} ${data.record.label || data.record.sys_id}`,
  ];
  const value = data.simulation.parsed ? data.simulation.value : null;
  if (value && typeof value === 'object') {
    if (value.subject) lines.push(`Subject: ${value.subject}`);
    if (value.body) lines.push(`Body: ${String(value.body).slice(0, 4000)}`);
    if (!value.subject && !value.body) lines.push(`Answer: ${JSON.stringify(value)}`);
  } else {
    lines.push(`Answer (not JSON): ${String(data.simulation.raw_answer || '').slice(0, 2000)}`);
  }
  lines.push(`Recipients: unavailable — ${data.recipients.reason}`);
  for (const table of ['sys_email', 'sysevent', 'syslog_email']) {
    const check = data.write_check[table];
    lines.push(check.status === 'unavailable' ? `${table}: count unavailable — ${check.reason}`
      : `${table}: ${check.before} before, ${check.after} after (${check.unchanged ? 'no rows written' : 'changed; investigate'})`);
  }
  return lines.join('\n');
}

export function notificationsCmd(wrap) {
  return {
    command: 'notifications [subcommand]',
    aliases: ['notification'],
    describe: 'Inspect outbound email notifications: when they send, to whom, and why a user did or did not receive one',
    summary: 'Explain outbound notification delivery',
    builder: y => y
      .command(buildList(wrap))
      .command(buildShow(wrap))
      .command(buildWhy(wrap))
      .command(buildPreview(wrap)),
    handler: wrap(async (_argv, app) => {
      app.ok({ commands: ['list', 'show', 'why', 'preview'], mutation: ['preview'] }, {
        summary: 'Outbound email notifications (read-only; preview simulates and is refused by read-only profiles)',
        breadcrumbs: [
          { action: 'list', cmd: 'jsn notifications list', description: 'List outbound notifications' },
          { action: 'show', cmd: 'jsn notifications show <name|sys_id>', description: 'Inspect one notification' },
          { action: 'why', cmd: 'jsn notifications why <table> <number|sys_id> <user>', description: 'Explain delivery for a record and user' },
          { action: 'preview', cmd: 'jsn notifications preview <notification> <table> <number|sys_id>', description: 'Render through the platform simulator' },
        ],
      });
    }),
  };
}
