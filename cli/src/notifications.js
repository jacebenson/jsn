const raw = value => value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? '');
const display = value => value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '');
const SYS_ID = /^[0-9a-f]{32}$/i;
const TRIGGERS = { engine: 'record', event: 'event', triggered: 'flow' };
const DELIVERY_FIELDS = ['generation_type', 'collection', 'action_insert', 'action_update', 'event_name', 'condition', 'advanced_condition', 'content_type', 'template', 'message_html'];

export function mailScripts(body) {
  return [...new Set([...String(body || '').matchAll(/\$\{mail_script:([^}\s]+)\}/g)].map(match => match[1]))];
}

/** What sends this notification: a record save, an event, or a flow. */
export function notificationTrigger(record) {
  if (!DELIVERY_FIELDS.every(field => Object.hasOwn(record, field))) return null;
  const generation = raw(record.generation_type);
  const trigger = { kind: TRIGGERS[generation] || generation || 'unknown', table: raw(record.collection) || null };
  if (generation === 'engine') Object.assign(trigger, { on_insert: raw(record.action_insert) === 'true', on_update: raw(record.action_update) === 'true' });
  if (generation === 'event') trigger.event = raw(record.event_name) || null;
  if (generation !== 'triggered') Object.assign(trigger, { condition: raw(record.condition) || null, advanced_condition: Boolean(raw(record.advanced_condition).trim()) });
  return trigger;
}

function ownBody(record, template = null) {
  return { source: 'notification', status: 'complete', template, mail_scripts: mailScripts(raw(record.message_html)) };
}

/**
 * The platform's body precedence, in one place: a template with a non-empty
 * message_html replaces the notification's own body; an empty template body
 * leaves the notification's own message_html in play.
 */
export function bodyDecision(record, templateRow, template) {
  const body = raw(templateRow.message_html);
  return body.trim()
    ? { source: 'template', status: 'complete', template, mail_scripts: mailScripts(body) }
    : ownBody(record, template);
}

export async function describeNotification(sdk, record, { displayValues } = {}) {
  if (displayValues === 'display') return { status: 'unavailable', reason: 'Display values hide the stored values delivery is read from; run show without --display-values display.' };
  if (!DELIVERY_FIELDS.every(field => Object.hasOwn(record, field))) return { status: 'unavailable', reason: 'The notification was read without its delivery fields.' };
  return { trigger: notificationTrigger(record), body: await bodySource(sdk, record) };
}

function unsupportedBody() {
  return { source: null, status: 'unsupported', reason: 'Plain-text notifications use message_text; only HTML bodies are described.' };
}

async function bodySource(sdk, record) {
  if (raw(record.content_type) === 'text/plain') return unsupportedBody();
  const templateId = raw(record.template);
  if (!templateId) return ownBody(record);
  const template = { sys_id: templateId, name: display(record.template) || null };
  if (!SYS_ID.test(templateId)) return { source: null, status: 'unavailable', template, reason: 'The template reference is not a sys_id.' };
  let row;
  try {
    [row] = await sdk.listStrict('sysevent_email_template', new URLSearchParams({ sysparm_query: `sys_id=${templateId}`, sysparm_fields: 'sys_id,name,message_html,email_layout', sysparm_limit: '1', sysparm_display_value: 'all' }));
  } catch (error) {
    return { source: null, status: 'unavailable', template, reason: `The template could not be read: ${error.message}` };
  }
  if (!row || raw(row.sys_id) !== templateId || !Object.hasOwn(row, 'message_html')) return { source: null, status: 'unavailable', template, reason: 'The template could not be read.' };
  const found = { sys_id: templateId, name: display(row.name) || template.name, layout: display(row.email_layout) || null };
  return bodyDecision(record, row, found);
}

/**
 * Resolve the body for many notifications at once. A list page would
 * otherwise read one template per notification; this reads the unique
 * referenced templates in bounded IN chunks and applies the same precedence
 * as describeNotification.
 */
export async function listNotificationBodies(sdk, records) {
  const bodies = new Map();
  const templateIds = new Set();
  for (const record of records) {
    const recordId = raw(record.sys_id);
    if (raw(record.content_type) === 'text/plain') { bodies.set(recordId, unsupportedBody()); continue; }
    const templateId = raw(record.template);
    if (!templateId) continue;
    if (!SYS_ID.test(templateId)) {
      bodies.set(recordId, { source: null, status: 'unavailable', template: { sys_id: templateId, name: display(record.template) || null }, reason: 'The template reference is not a sys_id.' });
      continue;
    }
    templateIds.add(templateId);
  }
  const rows = new Map();
  const ids = [...templateIds];
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    try {
      const result = await sdk.listStrict('sysevent_email_template', new URLSearchParams({
        sysparm_query: `sys_idIN${chunk.join(',')}`, sysparm_fields: 'sys_id,name,message_html,email_layout',
        sysparm_limit: String(chunk.length), sysparm_display_value: 'all',
      }));
      for (const row of result) rows.set(raw(row.sys_id), row);
    } catch (error) {
      for (const id of chunk) rows.set(id, error);
    }
  }
  for (const record of records) {
    const recordId = raw(record.sys_id);
    if (bodies.has(recordId)) continue;
    const templateId = raw(record.template);
    const template = templateId ? { sys_id: templateId, name: display(record.template) || null } : null;
    if (!templateId) { bodies.set(recordId, ownBody(record)); continue; }
    const row = rows.get(templateId);
    if (!row) { bodies.set(recordId, { source: null, status: 'unavailable', template, reason: 'The template was not returned by the instance.' }); continue; }
    if (row instanceof Error) { bodies.set(recordId, { source: null, status: 'unavailable', template, reason: `The template could not be read: ${row.message}` }); continue; }
    if (!Object.hasOwn(row, 'message_html')) { bodies.set(recordId, { source: null, status: 'unavailable', template, reason: 'The template was read without message_html.' }); continue; }
    const found = { sys_id: templateId, name: display(row.name) || template.name, layout: display(row.email_layout) || null };
    bodies.set(recordId, bodyDecision(record, row, found));
  }
  return bodies;
}

export function deliverySummary(record, id) {
  const title = `Email notification: ${display(record.name) || id}`;
  if (record._delivery.status === 'unavailable') return `${title}\n  Delivery: unavailable. ${record._delivery.reason}`;
  const { trigger, body } = record._delivery;
  const when = trigger.kind === 'record' ? `record ${[trigger.on_insert && 'insert', trigger.on_update && 'update'].filter(Boolean).join(' or ') || '(neither insert nor update)'}`
    : trigger.kind === 'event' ? `event ${trigger.event || '(no event name)'}` : trigger.kind;
  const condition = 'condition' in trigger ? `; condition: ${trigger.condition || 'none'}${trigger.advanced_condition ? ', plus an advanced condition script' : ''}` : '';
  const template = body.template ? `${body.template.name || body.template.sys_id}${body.template.layout ? ` (layout ${body.template.layout})` : ''}` : '';
  const source = body.status !== 'complete' ? `${body.status}: ${body.reason}` : body.source === 'template' ? `template ${template}` : template ? `own message_html (template ${template} has no body)` : 'own message_html';
  const scripts = body.mail_scripts ? `; mail scripts: ${body.mail_scripts.join(', ') || 'none'}` : '';
  return `${title}\n  Sends on: ${when}${trigger.table ? ` on ${trigger.table}` : ''}${condition}\n  Body: ${source}${scripts}`;
}
