import { AppError, CodeAPI } from './errors.js';

// Flow Designer's safeEdit lease is separate from publishing and artifact deletion.
// The provider exposes a user-level lock, not an operation token: refuse even a
// same-user existing lease so this CLI cannot release an open designer session.
export async function flowSafeEditRequest(sdk, instance, flowId, operation, lastUpdated) {
  const id = JSON.stringify(flowId);
  const input = operation === 'upsert' ? `upsert:{flowId:${id} lastUpdated:${JSON.stringify(lastUpdated)}}` : `${operation}:${id}`;
  const selection = operation === 'delete' ? 'deleteResult{deleteSuccess id}' : `status{canUserEdit currentEditor${operation === 'upsert' ? ' clientFlowStale' : ''}}`;
  const query = `${operation === 'read' ? 'query' : 'mutation'} {global {snFlowDesigner {safeEdit(safeEditInput:{${input}}){${selection}}}}}`;
  const response = await sdk.request(`${instance}/api/now/graphql`, { method: 'POST', body: JSON.stringify({ query, variables: {} }) });
  if (response.errors?.length) throw new AppError(CodeAPI, `Flow safe edit ${operation}: ${response.errors.map(error => error.message).join('; ')}`);
  const result = response.data?.global?.snFlowDesigner?.safeEdit;
  if (!result) throw new AppError(CodeAPI, `Flow safe edit ${operation} returned no result`);
  return result;
}

export async function readFlowSafeEditStatus(sdk, instance, flowId) {
  const { status } = await flowSafeEditRequest(sdk, instance, flowId, 'read');
  if (!status || typeof status.canUserEdit !== 'boolean' || !(status.currentEditor == null || typeof status.currentEditor === 'string')) throw new AppError(CodeAPI, 'Unreadable safe edit status');
  return status;
}

// The provider's `delete` only ever releases the calling user's own session, so
// recovery needs no ownership guess. It stays explicit anyway: releasing a lease
// that a live Flow Designer tab owns makes that editor's next save fail.
export async function releaseOwnFlowSafeEdit(sdk, instance, flowId) {
  const before = await readFlowSafeEditStatus(sdk, instance, flowId);
  const describe = status => `canUserEdit=${status.canUserEdit}, currentEditor=${JSON.stringify(status.currentEditor ?? null)}`;
  if (!before.canUserEdit && !before.currentEditor) return { released: false, before, after: before };
  const { deleteResult } = await flowSafeEditRequest(sdk, instance, flowId, 'delete');
  if (deleteResult?.deleteSuccess !== true || deleteResult.id !== flowId) {
    throw new AppError(CodeAPI, `Flow ${flowId} safe edit release was not confirmed by the provider (deleteSuccess=${JSON.stringify(deleteResult?.deleteSuccess ?? null)}, id=${JSON.stringify(deleteResult?.id ?? null)}); no retry attempted. Status before release: ${describe(before)}.`);
  }
  const after = await readFlowSafeEditStatus(sdk, instance, flowId);
  if (after.canUserEdit || after.currentEditor) throw new AppError(CodeAPI, `Flow ${flowId} release was acknowledged, but readback still reports an edit session (${describe(after)}). Inspect the exact flow and Flow Designer session before retrying.`);
  return { released: true, before, after };
}

export async function withFlowSafeEdit(sdk, instance, flowId, lastUpdated, operation) {
  if (typeof lastUpdated !== 'string' || !lastUpdated) throw new Error(`Flow ${flowId} has no authoritative updated timestamp; safe edit refused`);
  const read = () => readFlowSafeEditStatus(sdk, instance, flowId);
  const before = await read();
  // Refuse any reported session, including one this same user holds: releasing
  // it would close a Flow Designer tab this CLI never opened, so recovery stays
  // an explicit command (`jsn flows unlock`) rather than an implicit takeover.
  if (before.canUserEdit || before.currentEditor) throw new Error(`Flow ${flowId} already has an existing edit session/editor (canUserEdit=${before.canUserEdit}, currentEditor=${JSON.stringify(before.currentEditor ?? null)}); close it in Flow Designer before retrying, or release your own stale session with \`jsn flows unlock ${flowId}\`. No lock changed.`);
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
