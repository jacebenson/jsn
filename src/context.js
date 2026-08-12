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

export async function getCurrentApplication(sdk, userSysID) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `user=${userSysID}^name=apps.current_app`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'value');
  const records = await sdk.list('sys_user_preference', params);
  if (records.length === 0) return { scope: 'global', appSysId: '' };
  const val = records[0].value?.value || records[0].value;
  if (!val) return { scope: 'global', appSysId: '' };

  // Try to resolve sys_id to scope name
  try {
    const app = await sdk.get('sys_scope', val);
    if (app) return { scope: app.scope || 'global', appSysId: val };
  } catch {
    // fallback
  }
  try {
    const app2 = await sdk.get('sys_app', val);
    if (app2) return { scope: app2.scope || 'global', appSysId: val };
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
    if (us) return { name: us.name || val, sys_id: val };
  } catch {
    // fallback
  }
  return { name: val, sys_id: val };
}

/**
 * Find-or-create a sys_user_preference and set its value. Shared by the
 * scope/update-set "set" commands and create auto-set (was copy-pasted 3x).
 */
async function setUserPreference(sdk, userSysID, name, value) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `user=${userSysID}^name=${name}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'sys_id');
  const prefs = await sdk.list('sys_user_preference', params);
  if (prefs.length > 0) {
    await sdk.update('sys_user_preference', getStringField(prefs[0], 'sys_id'), { value });
  } else {
    await sdk.create('sys_user_preference', {
      user: userSysID,
      name,
      value,
      type: 'string',
    });
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

/** Set the current application scope via the apps.current_app preference. */
export async function setCurrentApplication(sdk, userSysID, scopeSysID) {
  await setUserPreference(sdk, userSysID, 'apps.current_app', scopeSysID);
}

/** Set the current update set via the sys_update_set preference. */
export async function setCurrentUpdateSet(sdk, userSysID, updateSetSysID) {
  await setUserPreference(sdk, userSysID, 'sys_update_set', updateSetSysID);
}
