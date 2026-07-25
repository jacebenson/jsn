import { buildDevCmd } from './_generic.js';
import { getStringField } from '../../helpers.js';

export const aliasesCmd = (wrap) => buildDevCmd('aliases', 'sys_alias', ['alias', 'als'],
  ['name', 'table', 'sys_scope'], wrap, {
    singular: 'alias',
    scopeValidation: true,
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;

      const mp = new URLSearchParams();
      mp.set('sysparm_query', `connection_alias=${sysID}^ORDERBYname`);
      mp.set('sysparm_limit', '100');
      mp.set('sysparm_display_value', 'all');
      mp.set('sysparm_fields', 'name,active,credential,sys_id');
      const conns = await app.sdk.list('sys_connection', mp);

      if (conns.length > 0) {
        console.log(`  Connections (${conns.length}):`);
        for (const c of conns) {
          const name = getStringField(c, 'name') || '';
          const cred = getStringField(c, 'credential') || '';
          const cid = getStringField(c, 'sys_id') || '';
          console.log(`    ${name}${cred ? ` → ${cred}` : ''}`);
          console.log(`      → jsn records get --table sys_connection --sys-id ${cid}`);
        }
      }
    },
  });
