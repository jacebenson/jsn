import { errUsage } from '../errors.js';
import { assertSafeExactMatch } from '../helpers.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';

const JOURNAL = 'sys_journal_field';
const FIELDS = 'sys_id,element_id,name,element,value,sys_created_on,sys_created_by';
// Journal fields the platform writes that are useful to read back by name.
export const JOURNAL_ELEMENTS = ['comments', 'work_notes'];

// Display labels are presentation only; timestamps and authors are joins, so
// they use raw values and the caller renders the display name separately.
const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const text = value => (value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? ''));
const malformed = message => Object.assign(new Error(message), { code: 'malformed_response' });

function validate({ limit, elements }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  for (const element of elements) assertSafeExactMatch(element);
}

/**
 * Read a record's journal entries from sys_journal_field.
 *
 * The record's rendered `comments` / `work_notes` values are one string per
 * field, so an agent cannot query them or join the author to sys_user. Each
 * entry is its own sys_journal_field row, and `element_id` is the only
 * reliable key: `name` is not always the record's own table (incident entries
 * also appear under `name=task`), so filtering on it loses rows.
 */
export async function recordJournal(sdk, { table, identifier, identifierField, element, limit = 20 } = {}) {
  const elements = element ? [element] : [];
  validate({ limit, elements });
  const record = await resolveRecord(sdk, {
    table, identifier, identifierField,
    fields: ['sys_class_name', 'comments', 'work_notes', 'comments_and_work_notes'],
    resource: 'Record',
  });
  const sysId = unwrapSysId(record);
  if (!/^[0-9a-f]{32}$/i.test(sysId)) throw malformed('The matched record has no readable sys_id; check field ACLs before retrying.');

  const query = [`element_id=${sysId}`, ...elements.map(value => `element=${value}`), 'ORDERBYDESCsys_created_on', 'ORDERBYDESCsys_id'].join('^');
  const rows = await sdk.listStrict(JOURNAL, new URLSearchParams({
    sysparm_query: query,
    sysparm_fields: FIELDS,
    sysparm_limit: String(limit + 1),
    sysparm_display_value: 'all',
  }));
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw malformed(`Malformed table response for ${JOURNAL}`);
  if (rows.some(row => raw(row.element_id) && raw(row.element_id) !== sysId)) throw malformed(`${JOURNAL} returned a row for another record than ${sysId}.`);

  const entries = rows.slice(0, limit).map(row => ({
    sys_id: raw(row.sys_id),
    element: raw(row.element),
    // The Table API returns UTC here; the record's rendered journal uses the
    // caller's time zone, which cannot be compared or joined.
    created_on: raw(row.sys_created_on),
    created_by: text(row.sys_created_by),
    created_by_id: raw(row.sys_created_by),
    table: raw(row.name),
    value: raw(row.value),
  }));

  const notes = [];
  if (!entries.length) {
    const rendered = [text(record.comments), text(record.work_notes), text(record.comments_and_work_notes)]
      .some(value => value.trim());
    notes.push(rendered
      ? `${JOURNAL} returned no rows for ${sysId}, but the record's rendered journal holds text: the entries are hidden by ACLs on ${JOURNAL}, not absent.`
      : `No journal entries found for ${sysId}. The record may have none, or ACLs on ${JOURNAL} may hide them.`);
  }
  if (rows.length > limit) notes.push(limit < 200 ? `More entries exist; raise --limit (up to 200) to read them.` : `More entries exist; only the newest 200 can be read.`);

  return {
    table,
    record: { sys_id: sysId, table: raw(record.sys_class_name) || table },
    elements: elements.length ? elements : 'all',
    count: entries.length,
    entries,
    pagination: { limit, has_more: rows.length > limit },
    notes,
  };
}

export function formatJournal(data) {
  const scope = data.elements === 'all' ? 'all journal elements' : data.elements.join(', ');
  const lines = [`Journal of ${data.record.table} ${data.record.sys_id} (${scope}), newest first (read-only)`];
  for (const entry of data.entries) {
    const author = entry.created_by || entry.created_by_id || '(author hidden)';
    lines.push('', `${entry.created_on}  ${author}  ${entry.element}${entry.table ? ` (name=${entry.table})` : ''}`);
    for (const line of entry.value.split('\n')) lines.push(`  ${line}`);
  }
  if (!data.entries.length) lines.push('', 'No entries.');
  lines.push(...data.notes);
  return lines.join('\n');
}
