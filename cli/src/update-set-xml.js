// Parse the export envelope without evaluating its payload or resolving entities.
import { SaxesParser } from 'saxes';
import { errUsage } from './errors.js';

export const MAX_UPDATE_SET_BYTES = 50 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/i;

export function updateSetFilename(name) {
  const stem = String(name).normalize('NFKC').replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 180);
  return `${stem || 'update-set'}.xml`;
}

export function inspectUpdateSetXML(xml) {
  if (Buffer.byteLength(xml, 'utf8') > MAX_UPDATE_SET_BYTES) throw errUsage('Update set XML exceeds the 50 MiB limit');
  const parser = new SaxesParser();
  const stack = [], sets = [], updates = [];
  let record;
  parser.on('doctype', () => { throw errUsage('DOCTYPE and external entities are not allowed in update set XML'); });
  parser.on('opentag', tag => {
    stack.push(tag.name);
    if (stack.length === 1 && tag.name !== 'unload') throw errUsage('Expected an update set export with an <unload> root');
    if (stack.length === 2) {
      if (!['sys_remote_update_set', 'sys_update_xml'].includes(tag.name) || tag.attributes.action !== 'INSERT_OR_UPDATE') {
        throw errUsage('Only INSERT_OR_UPDATE sys_remote_update_set and sys_update_xml envelope records may be imported');
      }
      record = {};
    }
    if (stack.length === 3) {
      if (Object.hasOwn(record, tag.name)) throw errUsage(`Duplicate XML field: ${tag.name}`);
      record[tag.name] = '';
    }
    if (stack.length > 3) throw errUsage('Update payloads must be XML text or CDATA, not nested envelope elements');
  });
  const text = value => { if (stack.length === 3) record[stack[2]] += value; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    if (stack.length === 2) (stack[1] === 'sys_remote_update_set' ? sets : updates).push(record);
    stack.pop();
  });
  try { parser.write(xml).close(); } catch (error) { throw errUsage(`Invalid update set XML: ${error.message}`); }
  if (sets.length !== 1) throw errUsage('Import exactly one retrieved update set per XML file');
  const set = sets[0];
  if (!ID.test(set.sys_id || '') || !ID.test(set.remote_sys_id || '') || !set.name?.trim()) {
    throw errUsage('Update set requires a name, sys_id, and remote_sys_id');
  }
  if (set.sys_class_name && set.sys_class_name !== 'sys_remote_update_set') throw errUsage('Invalid retrieved update set class');
  if (set.state !== 'loaded' || set.update_set?.trim()) throw errUsage('Expected a loaded, uncommitted retrieved update set export');
  const seen = new Set();
  const summary = new Map(), payloadOperations = new Map();
  for (const update of updates) {
    if (!ID.test(update.sys_id || '') || seen.has(update.sys_id.toLowerCase()) || update.remote_update_set !== set.sys_id
      || update.update_set?.trim() || !update.name || !update.payload?.trim()
      || !['INSERT_OR_UPDATE', 'DELETE'].includes(update.action)) {
      throw errUsage('Invalid, duplicate, or unrelated update XML member');
    }
    if (update.sys_class_name && update.sys_class_name !== 'sys_update_xml') throw errUsage('Invalid update XML class');
    seen.add(update.sys_id.toLowerCase());
    // Payload XML stays inert; parse it solely to describe the affected table.
    const payload = new SaxesParser(); let table = '', depth = 0, primary = '';
    payload.on('doctype', () => { throw errUsage('DOCTYPE is not allowed in update payloads'); });
    payload.on('opentag', tag => {
      depth++;
      if (depth === 1 && tag.name !== 'record_update') throw errUsage('Expected a record_update payload');
      if (depth === 1) table = tag.attributes.table || '';
      if (depth === 2) {
        if (!primary) {
          primary = tag.name;
          if (table && table !== primary) throw errUsage('Payload table does not match its primary record');
          table = primary;
          if (tag.attributes.action && tag.attributes.action !== update.action) throw errUsage('Payload action does not match the update member action');
        }
        const action = tag.attributes.action || 'platform_default';
        if (!['INSERT_OR_UPDATE', 'INSERT', 'UPDATE', 'DELETE', 'delete_multiple', 'platform_default'].includes(action)) throw errUsage('Unsupported payload record action');
        const key = `${tag.name}:${action}`;
        const operation = payloadOperations.get(key) || { table: tag.name, action, count: 0 };
        operation.count++; payloadOperations.set(key, operation);
      }
    });
    payload.on('closetag', () => { depth--; });
    try { payload.write(update.payload).close(); } catch (error) { throw errUsage(`Invalid update payload: ${error.message}`); }
    if (!primary || !/^[a-z][a-z0-9_]*$/i.test(table)) throw errUsage(`Missing or invalid payload table for ${update.name}`);
    const key = `${table}:${update.action}`;
    const row = summary.get(key) || { table, action: update.action, count: 0 };
    row.count++; summary.set(key, row);
  }
  return { name: set.name, sys_id: set.sys_id, remote_sys_id: set.remote_sys_id,
    state: set.state, count: updates.length, summary: [...summary.values()], payload_operations: [...payloadOperations.values()],
    members: updates.map(update => ({ sys_id: update.sys_id, name: update.name, target_name: update.target_name || '', action: update.action })) };
}
