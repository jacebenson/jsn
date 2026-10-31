// Essential relationships are a declarative opt-in of specialized profiles.
// Supplementary metadata/counts live separately; this never fetches them.
import { assertSafeExactMatch, quoteShellArg } from './helpers.js';
import { listRecords, displayValue, recordListParams } from './records-engine.js';

export async function enrichEssentialRecords(record, { sdk, relationships, displayValues = 'both', profileName, instance }) {
  if (!relationships?.length) return record;
  const id = typeof record.sys_id === 'object' ? record.sys_id?.value : record.sys_id;
  const entries = await Promise.all(relationships.map(async relationship => {
    const limit = relationship.limit ?? 100;
    const query = `${relationship.foreignKey}=${id}`;
    const result = { table: relationship.table, query, limit, records: [], loaded: 0,
      coverage: 'visible_rows_only', visibility: 'Subject to field/row ACLs; empty results do not prove no related records.' };
    try {
      if (!id) throw new Error('No readable raw parent sys_id');
      assertSafeExactMatch(id);
      const ordered = query + (relationship.orderBy ? `^ORDERBY${relationship.orderBy}` : '');
      const params = recordListParams({ limit: limit + 1, query: ordered,
        fields: relationship.columns ? ['sys_id', ...relationship.columns] : undefined,
        displayValue: displayValue(displayValues),
      });
      const rows = await listRecords(sdk, { table: relationship.table, params });
      if (!Array.isArray(rows)) throw new Error('Invalid related record response');
      result.records = rows.slice(0, limit);
      result.loaded = result.records.length;
      result.has_more = rows.length > limit;
      result.status = 'loaded';
      const selector = profileName ? ` --profile ${quoteShellArg(profileName)}` : instance ? ` --instance ${quoteShellArg(instance)}` : '';
      result.command = `jsn${selector} records list --table ${quoteShellArg(relationship.table)} --query ${quoteShellArg(ordered)} --limit ${limit} --json`;
    } catch (error) {
      // Provider bodies can contain private data. Preserve uncertainty, not raw errors.
      result.status = 'unavailable';
      result.error = { code: error.code === 'forbidden' || error.status === 403 ? 'forbidden' : 'unavailable',
        message: 'Essential related records could not be read. Check parent identity, table/field permissions and connection.' };
    }
    return [relationship.name, result];
  }));
  record._essential = Object.fromEntries(entries);
  return record;
}
