import { buildDevCmd } from './_generic.js';
import { getStringField } from '../../helpers.js';

export const soapmessagesCmd = (wrap) => buildDevCmd('soapmessages', 'sys_soap_message', ['soapmsg'],
  ['name', 'active', 'sys_scope'], wrap, {
    singular: 'SOAP message',
    scopeValidation: true,
    devAlias: false,
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;

      // Fetch related functions
      const mp = new URLSearchParams();
      mp.set('sysparm_query', `soap_message=${sysID}^ORDERBYorder`);
      mp.set('sysparm_limit', '100');
      mp.set('sysparm_display_value', 'all');
      mp.set('sysparm_fields', 'name,order,sys_id');
      const funcs = await app.sdk.list('sys_soap_message_function', mp);

      if (funcs.length > 0) {
        console.log(`  Functions (${funcs.length}):`);
        for (const f of funcs) {
          const name = getStringField(f, 'name') || '';
          const fid = getStringField(f, 'sys_id') || '';
          console.log(`    ${name}`);
          console.log(`      → jsn records get --table sys_soap_message_function --sys-id ${fid}`);
        }
      }
    },
  });
