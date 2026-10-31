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
