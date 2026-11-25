// Stats and Table API access can differ. Retain the old Table count when
// Stats is unavailable, but never hide an unreadable successful response.
export async function detailCount(sdk, table, query) {
  try {
    return await sdk.aggregateCount(table, query, { strict: true });
  } catch (error) {
    if (error.code === 'invalid_aggregate_count') throw error;
    const params = new URLSearchParams({
      sysparm_query: query,
      sysparm_limit: '0',
      sysparm_fields: 'sys_id',
    });
    const rows = await sdk.list(table, params);
    return rows.length;
  }
}
