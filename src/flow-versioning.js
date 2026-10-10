const VERSION_ENDPOINT = '/api/now/processflow/versioning/create_version';
const VERSION_TABLE = 'sys_hub_flow_version';

function stringValue(value) {
  if (value && typeof value === 'object') return String(value.value ?? value.sys_id ?? value.display_value ?? '');
  return value == null ? '' : String(value);
}

function versionId(record) {
  return stringValue(record?.sys_id ?? record?.sysId ?? record?.id);
}

function responseVersionId(response) {
  const result = response?.result?.result ?? response?.result ?? response?.data?.result ?? response?.data ?? response;
  return versionId(result);
}

function versionType(record) {
  const value = record?.type;
  if (value && typeof value === 'object') return String(value.display_value ?? value.value ?? '');
  return stringValue(value);
}

function versionQuery(flowId) {
  return new URLSearchParams({
    sysparm_query: `flow=${flowId}^ORDERBYDESCsys_updated_on`,
    sysparm_limit: '20',
    sysparm_display_value: 'all',
    sysparm_fields: 'sys_id,flow,type,sys_created_on,sys_updated_on',
  });
}

export async function createVerifiedFlowVersion(sdk, { instance, flowId, scope, type, annotation }) {
  if (!instance || !flowId || !scope || !type) throw new Error('Flow version creation requires instance, flow ID, scope, and type');
  const before = await sdk.list(VERSION_TABLE, versionQuery(flowId));
  const beforeIds = new Set(before.map(versionId).filter(Boolean));
  const response = await sdk.request(`${instance}${VERSION_ENDPOINT}?sysparm_transaction_scope=${encodeURIComponent(scope)}`, {
    method: 'POST',
    body: JSON.stringify({ item_sys_id: flowId, type, annotation, favorite: false }),
  });
  const responseId = responseVersionId(response);
  const after = await sdk.list(VERSION_TABLE, versionQuery(flowId));
  const matching = after.filter(record => stringValue(record.flow) === flowId && versionType(record) === type);
  const newVersions = matching.filter(record => versionId(record) && !beforeIds.has(versionId(record)));
  const verified = responseId
    ? newVersions.find(record => versionId(record) === responseId)
    : newVersions.length === 1 ? newVersions[0] : null;
  if (!verified) {
    if (newVersions.length > 1 && !responseId) throw new Error(`Flow ${flowId} has ambiguous new ${type} versions; refusing to guess`);
    throw new Error(`New ${type} version for flow ${flowId} was not read back with an exact ID`);
  }
  return { version: verified, response };
}
