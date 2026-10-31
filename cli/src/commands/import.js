import { buildDevCmd } from './_generic.js';
import { getStringField } from '../helpers.js';

export const importCmd = (wrap) => buildDevCmd('import', 'sys_import_set', ['imports', 'imp'],
  ['name', 'sys_target_table', 'state', 'sys_created_on'], wrap, {
    singular: 'import set',
    readOnly: true,
    formatLabel: (r) => {
      const name = getStringField(r, 'name') || '';
      const table = getStringField(r, 'sys_target_table') || '';
      return table ? `${name} [${table}]` : name;
    },
    onShow: async (record, app) => {
      const sysID = getStringField(record, 'sys_id') || '';
      if (!sysID) return;
      try {
        const rp = new URLSearchParams();
        rp.set('sysparm_query', `sys_import_set=${sysID}`);
        rp.set('sysparm_limit', '0'); rp.set('sysparm_fields', 'sys_id');
        const rows = await app.sdk.list('sys_import_set_row', rp);
        console.log(`  Import rows: ${rows.length}`);
        console.log(`    → jsn records list --table sys_import_set_row --query "sys_import_set=${sysID}" --limit 200`);
      } catch {
        console.log(`  Import rows: (unavailable)`);
      }
    },
  });
