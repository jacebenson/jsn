import { buildDevCmd } from './_generic.js';
import { getStringField } from '../../helpers.js';

export const restmessageCmd = (wrap) => buildDevCmd('restmessage', 'sys_rest_message', ['rm', 'restmsg'],
  ['name', 'endpoint', 'active', 'sys_scope'], wrap, {
    singular: 'REST message',
    scopeValidation: true,
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;

      // Fetch related methods
      const mp = new URLSearchParams();
      mp.set('sysparm_query', `rest_message=${sysID}^ORDERBYorder`);
      mp.set('sysparm_limit', '100');
      mp.set('sysparm_display_value', 'all');
      mp.set('sysparm_fields', 'name,http_method,rest_endpoint,order,sys_id');
      const methods = await app.sdk.list('sys_rest_message_fn', mp);

      if (methods.length > 0) {
        console.log(`  Methods (${methods.length}):`);
        for (const m of methods) {
          const name = getStringField(m, 'name') || getStringField(m, 'http_method') || '';
          const method = getStringField(m, 'http_method') || '';
          const path = getStringField(m, 'rest_endpoint') || '';
          const mid = getStringField(m, 'sys_id') || '';
          console.log(`    ${method} ${path}  (${name})`);
          console.log(`      → jsn records get --table sys_rest_message_fn --sys-id ${mid}`);
        }
      }
    },
  });
