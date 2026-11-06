// Read-only evidence checker. No auth or network; consume captured metadata.
// Usage: node cli/scripts/check-batch-schema.mjs fields.json data-fields.json
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { familyBatchAdapters } from '../src/batch-adapters/families.js';

const inherited = {
  catalog_ui_policy: ['sys_ui_policy'],
  catalog_ui_policy_action: ['sys_ui_policy_action'],
  catalog_script_client: ['sys_script_client'],
};
const value = input => input && typeof input === 'object' ? input.value : input;
export function checkBatchSchema(records, adapters = familyBatchAdapters) {
  const rows = records.map(row => Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, value(entry)])));
  const checked = [];
  for (const adapter of adapters) {
    for (const [field, spec] of Object.entries(adapter.fields)) {
      const names = [adapter.table, ...(inherited[adapter.table] || [])];
      const row = names.map(name => rows.find(entry => entry.name === name && entry.element === field)).find(Boolean);
      if (!row) throw Error(`Unconfirmed field ${adapter.table}.${field}`);
      if (spec.type === 'boolean' && row.internal_type !== 'boolean') throw Error(`Wrong boolean type at ${adapter.table}.${field}`);
      if (spec.type === 'integer' && row.internal_type !== 'integer') throw Error(`Wrong integer type at ${adapter.table}.${field}`);
      if (spec.parent && !spec.refOutput) {
        const expected = adapters.find(entry => spec.ref.includes(entry.type))?.table || (spec.ref.includes('catalog_item') ? 'sc_cat_item' : null);
        // Catalog policies are sys_ui_policy subclasses; inherited ui_policy
        // points at the base table rather than the subclass table.
        const allowed = expected === 'catalog_ui_policy' ? ['catalog_ui_policy', 'sys_ui_policy'] : [expected];
        if (!allowed.includes(row.reference)) throw Error(`Unconfirmed reference ${adapter.table}.${field}: ${row.reference}`);
      }
      checked.push({ adapter: adapter.type, table: adapter.table, field, declared_on: row.name,
        internal_type: row.internal_type, reference: row.reference || null, dictionary_sys_id: row.sys_id });
    }
  }
  return checked;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) throw Error('Pass captured sys_dictionary JSON envelope paths.');
  const records = files.flatMap(file => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.ok !== true || !Array.isArray(doc.data?.records)) throw Error(`Invalid dictionary capture: ${file}`);
    return doc.data.records;
  });
  process.stdout.write(`${JSON.stringify({ checked_fields: checkBatchSchema(records) }, null, 2)}\n`);
}
