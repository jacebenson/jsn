// ServiceNow runtime context: current user, scope, update set

import { getStringField } from './helpers.js';

export async function getCurrentUser(sdk) {
  const params = new URLSearchParams();
  params.set('sysparm_query', 'user_name=javascript:gs.getUserName()');
  params.set('sysparm_limit', '1');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_fields', 'sys_id,user_name,name');
  const records = await sdk.list('sys_user', params);
  if (records.length === 0) return null;
  const r = records[0];
  return {
    sys_id: r.sys_id?.value || r.sys_id,
    user_name: r.user_name?.display_value || r.user_name,
    name: r.name?.display_value || r.name,
  };
}

export async function getCurrentApplication(sdk, userSysID, { unknownWhenMissing = false } = {}) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `user=${userSysID}^name=apps.current_app`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'value');
  const records = await sdk.list('sys_user_preference', params);
  if (records.length === 0) return { scope: unknownWhenMissing ? '' : 'global', appSysId: '' };
  const val = records[0].value?.value || records[0].value;
  if (!val) return { scope: unknownWhenMissing ? '' : 'global', appSysId: '' };

  // Try to resolve sys_id to scope name
  try {
    const app = await sdk.get('sys_scope', val);
    if (app) return { scope: getStringField(app, 'scope') || (unknownWhenMissing ? '' : 'global'), appSysId: val };
  } catch {
    // fallback
  }
  try {
    const app2 = await sdk.get('sys_app', val);
    if (app2) return { scope: getStringField(app2, 'scope') || (unknownWhenMissing ? '' : 'global'), appSysId: val };
  } catch {
    // fallback
  }
  return { scope: val, appSysId: val };
}

export async function getCurrentUpdateSet(sdk, userSysID) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `user=${userSysID}^name=sys_update_set`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'value');
  const records = await sdk.list('sys_user_preference', params);
  if (records.length === 0) return null;
  const val = records[0].value?.value || records[0].value;
  if (!val || val === '-') return { name: 'Default', sys_id: '' };

  try {
    const us = await sdk.get('sys_update_set', val);
    if (us) return { name: getStringField(us, 'name') || val, sys_id: val, application: us.application, state: getStringField(us, 'state') };
  } catch {
    // fallback
  }
  return { name: val, sys_id: val };
}

// Use the same selection contract as the platform picker. Table API writes to
// sys_user_preference do not update an already-warmed session's capture context.
async function selectContext(sdk, picker, data, expected) {
  const endpoint = `${sdk.baseURL}/api/now/ui/concoursepicker/${picker}`;
  await sdk.request(endpoint, { method: 'PUT', body: JSON.stringify(data) });
  const response = await sdk.request(endpoint, { method: 'GET' });
  const current = response?.result?.current;
  const actual = picker === 'application' ? current : current?.sysId;
  if (actual !== expected) {
    throw new Error(`${picker === 'application' ? 'Application' : 'Update set'} selection was not applied. Expected ${expected}, received ${typeof actual === 'string' ? actual : 'an unreadable selection'}.`);
  }
}

/** Resolve the current user's sys_id (throws if it can't be determined). */
export async function requireCurrentUserSysId(sdk) {
  const user = await sdk.list('sys_user', new URLSearchParams({
    sysparm_query: 'user_name=javascript:gs.getUserName()',
    sysparm_limit: '1',
    sysparm_fields: 'sys_id',
  }));
  if (user.length === 0) {
    throw new Error('Could not determine current user');
  }
  return getStringField(user[0], 'sys_id');
}

/** Select application scope in the authenticated session and verify it. */
export async function setCurrentApplication(sdk, _userSysID, scopeSysID) {
  await selectContext(sdk, 'application', { app_id: scopeSysID }, scopeSysID);
}

/** Select the capture update set in the authenticated session and verify it. */
export async function setCurrentUpdateSet(sdk, _userSysID, updateSetSysID) {
  await selectContext(sdk, 'updateset', { sysId: updateSetSysID }, updateSetSysID);
}

/**
 * Read the update set this authenticated session will actually capture into.
 *
 * `sys_user_preference:user=<user>^name=sys_update_set` is the persisted
 * choice; this endpoint reports the session's effective picker selection. They
 * are different sources and can disagree in a freshly-warmed session, so the
 * preference alone must not be treated as the provider's capture context.
 */
export async function readEffectiveUpdateSet(sdk) {
  const endpoint = `${sdk.baseURL}/api/now/ui/concoursepicker/updateset`;
  const response = await sdk.request(endpoint, { method: 'GET', readOnly: true });
  const current = response?.result?.current;
  if (!current || typeof current !== 'object') {
    throw new Error('Invalid update-set picker response: expected result.current.');
  }
  const sysId = typeof current.sysId === 'string' ? current.sysId : '';
  return {
    sys_id: sysId,
    name: typeof current.name === 'string' ? current.name : '',
    label: current.displayValue || current.name || sysId,
  };
}

/**
 * Make the warmed session's effective capture set match the persisted choice
 * before content writes, and verify the result.
 *
 * A fresh CLI invocation is a fresh authenticated session; the persisted
 * preference is the user's intentional choice, but nothing guarantees the new
 * session inherited it (`jsn updatesets create`/`set` may have selected the set
 * in a session that has since ended). When the two disagree, re-apply the
 * persisted selection through the same picker contract and verify it.
 *
 * Returns a report instead of throwing when the effective selection cannot be
 * read at all (for example an auth mode that cannot keep a UI session). A
 * readable-but-unalignable mismatch throws, so a content write never proceeds
 * into a set the CLI would then wrongly report.
 */
export async function alignUpdateSetCapture(sdk, intended) {
  const intendedId = intended?.sys_id || '';
  let effective;
  try {
    effective = await readEffectiveUpdateSet(sdk);
  } catch (error) {
    return {
      intended: intended || null,
      effective: null,
      aligned: null,
      action: 'unverified',
      reason: `effective session selection could not be read: ${error.message}`,
    };
  }
  const report = { intended: intended || null, effective, aligned: null, action: 'none' };
  if (!intendedId) {
    report.reason = 'no persisted update-set selection (Default or unreadable preference)';
    return report;
  }
  if (effective.sys_id === intendedId) {
    report.aligned = true;
    return report;
  }
  try {
    await setCurrentUpdateSet(sdk, null, intendedId);
  } catch (error) {
    const message = `Session capture context could not be aligned with the selected update set before any content write. `
      + `This session resolves to ${effective.sys_id || 'an empty selection'} (${effective.name || 'unknown'}), `
      + `but the persisted selection is ${intended?.name || intendedId} (${intendedId}). ${error.message} `
      + 'No content was written. Re-select explicitly with `jsn updatesets set` in an interactive session, '
      + 'or use an auth profile that keeps a UI session, then retry.';
    const failure = new Error(message, { cause: error });
    failure.capture_context = { ...report, aligned: false, action: 'select_failed' };
    throw failure;
  }
  report.previous_effective = effective;
  report.effective = await readEffectiveUpdateSet(sdk);
  report.action = 'selected';
  report.aligned = report.effective.sys_id === intendedId;
  if (!report.aligned) {
    report.reason = 'session still resolves to a different set after re-selection';
  }
  return report;
}
