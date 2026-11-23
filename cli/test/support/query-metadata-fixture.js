// Explicit dictionary transport for caller tests, not a validation bypass.
export function queryMetadataFixture(table, params, opts = {}, target = 'incident', fields = ['priority']) {
  if (table === 'sys_db_object') return [{ sys_id: 'a'.repeat(32), name: target, super_class: '' }];
  if (table !== 'sys_dictionary') return undefined;
  const rows = fields.map(element => ({ name: target, element, internal_type: 'string', reference: '' }));
  if (opts.responseMetadata) opts.responseMetadata.total = rows.length;
  return rows;
}
