export async function inspectRecord(app, table, identifier) {
  return { table, identifier, history: [], businessRules: [], flows: [] };
}
