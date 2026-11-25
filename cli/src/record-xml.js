// Unload XML: what `<table>.do?UNL` writes (the UI's Export > XML) and `sys_upload.do` loads.
import { SaxesParser } from 'saxes';
import { AppError, errAPI, errUsage } from './errors.js';
import { getStringField } from './helpers.js';

export const DEFAULT_XML_EXPORT_LIMIT = 10000;
// The 30-second request default covers the body read; an unload near the cap with attachments takes longer.
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
export const TABLE_NAME = /^[a-z][a-z0-9_]*$/i;
// An export carries these for each exported record; they are not matches of the query.
const RELATED = new Set(['sys_journal_field', 'sys_attachment', 'sys_attachment_doc']);
const ID = /^[a-f0-9]{32}$/i;
// An update set moves as a whole through jsn updatesets export and import, never as these rows.
export const UPDATE_SET_TABLES = new Set(['sys_remote_update_set', 'sys_update_xml']);

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
  const text = value => { if (depth === 3 && field === 'sys_id') record.sys_id += value; };
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
  const xml = await sdk.rawRequest(`${sdk.baseURL}/${table}.do?${params}`, { method: 'GET', timeout: EXPORT_TIMEOUT_MS });
  if (!/^\s*(<\?xml|<unload)/i.test(xml)) {
    throw errAPI(200, `Export returned a non-XML response (${xml.trimStart().slice(0, 60) || 'empty body'}); the instance may need an authenticated admin session.`);
  }
  let records;
  try { records = inspectUnloadXML(xml); } catch (error) { throw errAPI(200, `Export returned unreadable XML: ${error.message}`); }
  const matches = records.filter(record => RELATED.has(table) ? record.table === table : !RELATED.has(record.table));
  if (matches.some(record => !ID.test(record.sys_id))) throw errAPI(200, 'Export returned a record without a sys_id; refusing to write it.');
  return { xml, records: matches.length, tables: countByTable(records) };
}
