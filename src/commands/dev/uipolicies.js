import { buildDevCmd } from './_generic.js';
import { getStringField } from '../../helpers.js';

export const uipoliciesCmd = (wrap) => buildDevCmd('uipolicies', 'sys_ui_policy', ['uipolicy', 'up'],
  ['short_description', 'table', 'sys_class_name', 'active'], wrap, {
    singular: 'UI policy',
    scopeValidation: true,
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;
      const mp = new URLSearchParams();
      mp.set('sysparm_query', `ui_policy=${sysID}^ORDERBYorder`);
      mp.set('sysparm_limit', '100'); mp.set('sysparm_display_value', 'all');
      mp.set('sysparm_fields', 'name,table,field_name,read_only,mandatory,visible,sys_id');
      const actions = await app.sdk.list('sys_ui_policy_action', mp);
      if (actions.length > 0) {
        console.log(`  Actions (${actions.length}):`);
        for (const a of actions) {
          const f = getStringField(a, 'field_name') || '(all fields)';
          const flags = [];
          if (getStringField(a, 'mandatory') === 'true') flags.push('mandatory');
          if (getStringField(a, 'read_only') === 'true') flags.push('read-only');
          if (getStringField(a, 'visible') === 'false') flags.push('hidden');
          console.log(`    ${f}  ${flags.length ? `[${flags.join(', ')}]` : ''}`);
        }
      }
    },
  });
