// Flow Designer's safeEdit lease is separate from publishing and artifact deletion.
// The provider exposes a user-level lock, not an operation token: refuse even a
// same-user existing lease so this CLI cannot release an open designer session.
export async function flowSafeEditRequest(sdk, instance, flowId, operation, lastUpdated) {
  const id = JSON.stringify(flowId);
  const input = operation === 'upsert' ? `upsert:{flowId:${id} lastUpdated:${JSON.stringify(lastUpdated)}}` : `${operation}:${id}`;
  const selection = operation === 'delete' ? 'deleteResult{deleteSuccess id}' : `status{canUserEdit currentEditor${operation === 'upsert' ? ' clientFlowStale' : ''}}`;
  const query = `${operation === 'read' ? 'query' : 'mutation'} {global {snFlowDesigner {safeEdit(safeEditInput:{${input}}){${selection}}}}}`;
  const response = await sdk.request(`${instance}/api/now/graphql`, { method: 'POST', body: JSON.stringify({ query, variables: {} }) });
  if (response.errors?.length) throw new Error(`Flow safe edit ${operation}: ${response.errors.map(error => error.message).join('; ')}`);
  const result = response.data?.global?.snFlowDesigner?.safeEdit;
  if (!result) throw new Error(`Flow safe edit ${operation} returned no result`);
  return result;
}

export async function withFlowSafeEdit(sdk, instance, flowId, lastUpdated, operation) {
  if (typeof lastUpdated !== 'string' || !lastUpdated) throw new Error(`Flow ${flowId} has no authoritative updated timestamp; safe edit refused`);
  const read = async () => {
    const { status } = await flowSafeEditRequest(sdk, instance, flowId, 'read');
    if (!status || typeof status.canUserEdit !== 'boolean' || !(status.currentEditor == null || typeof status.currentEditor === 'string')) throw new Error('Unreadable safe edit status');
    return status;
  };
  const before = await read();
  if (before.canUserEdit || before.currentEditor) throw new Error(`Flow ${flowId} already has an existing edit session/editor; close it in Flow Designer before retrying. No lock changed.`);
  let status;
  try {
    ({ status } = await flowSafeEditRequest(sdk, instance, flowId, 'upsert', lastUpdated));
  } catch (error) {
    throw new Error(`Flow ${flowId} safe edit acquisition is uncertain: ${error.message}. No content write attempted; no release attempted because ownership is unconfirmed. Inspect the exact flow/session before retrying.`, { cause: error });
  }
  // A denied or ambiguous upsert is not proof we own a lease. Never delete it.
  if (status?.canUserEdit !== true || status.currentEditor) throw new Error(`Flow ${flowId} safe edit acquisition denied or ambiguous${status?.clientFlowStale === true ? ' (client flow is stale)' : ' (another editor may own it)'}; no content write or release attempted`);
  let result, failure;
  try {
    if (status.clientFlowStale !== false && status.clientFlowStale !== null) throw new Error(`Flow ${flowId} is stale or has unreadable freshness; reread before retrying`);
    result = await operation();
  } catch (error) { failure = error; }
  try {
    const { deleteResult } = await flowSafeEditRequest(sdk, instance, flowId, 'delete');
    if (deleteResult?.deleteSuccess !== true || deleteResult.id !== flowId) throw new Error('provider did not confirm release');
    const after = await read();
    if (after.canUserEdit || after.currentEditor) throw new Error('release readback still reports an edit session');
  } catch (error) {
    throw new Error(`${failure ? `${failure.message}; ` : 'Content operation completed; '}Flow ${flowId} safe edit release failed: ${error.message}. Inspect the exact flow/session before retrying.`, { cause: error });
  }
  if (failure) throw failure;
  return result;
}
