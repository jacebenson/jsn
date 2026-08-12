import fs from 'node:fs';
import { formatRecordForDisplay, getStringField, interactiveList, assertSafeExactMatch, confirmDelete } from '../../helpers.js';
import { getCurrentApplication, getCurrentUpdateSet, requireCurrentUserSysId, setCurrentUpdateSet } from '../../context.js';

/**
 * Rich display for an update set: header fields + child update filenames.
 * Children (sys_update_xml) listed filename-only, sorted by sys_updated_on
 * descending (newest first). Shared by `list` pick and `show`.
 *
 * Fetches an enriched record itself (sysparm_display_value=all so the parent
 * reference renders as a name, not a sys_id) — callers can pass a thin
 * picker record; the formatter completes it.
 */
export async function formatUpdateSetDetail(app, record) {
  const sysID = getStringField(record, 'sys_id');
  const name = getStringField(record, 'name');
  const instance = app.getEffectiveInstance();
  const link = `${instance}/sys_update_set.do?sys_id=${sysID}`;

  let full = record;
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${sysID}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,name,state,application,parent,sys_created_on,sys_updated_on');
    const recs = await app.sdk.list('sys_update_set', params);
    if (Array.isArray(recs) && recs.length > 0) full = recs[0];
  } catch {
    // fall back to the passed record
  }

  const state = getStringField(full, 'state') || '?';
  const application = getStringField(full, 'application') || '';
  const parent = getStringField(full, 'parent') || '';
  const created = getStringField(full, 'sys_created_on') || '';
  const updated = getStringField(full, 'sys_updated_on') || '';

  // Child updates: filename only, newest first by sys_updated_on
  let children = [];
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `update_set=${sysID}^ORDERBYDESCsys_updated_on`);
    params.set('sysparm_limit', '500');
    params.set('sysparm_fields', 'name,sys_updated_on');
    const updates = await app.sdk.list('sys_update_xml', params);
    if (Array.isArray(updates)) {
      children = updates.map(u => getStringField(u, 'name')).filter(Boolean);
    }
  } catch {
    // children are best-effort — a broken query shouldn't kill the display
  }

  const lines = [];
  lines.push(`Update set: ${name}`);
  lines.push(`  State:     ${state}`);
  if (application) lines.push(`  Scope:     ${application}`);
  if (parent) lines.push(`  Parent:    ${parent}`);
  if (created) lines.push(`  Created:   ${created}`);
  if (updated) lines.push(`  Updated:   ${updated}`);
  lines.push(`  Updates:   ${children.length}`);
  for (const c of children) {
    lines.push(`    ${c}`);
  }
  lines.push(`  Link:      ${link}`);

  // State-aware action hints (rendered as breadcrumbs under the detail).
  // Closed sets (complete/committed) cannot be set as current.
  const stateRaw = String(full.state?.value ?? full.state ?? '').toLowerCase();
  const isClosed = ['complete', 'committed'].includes(stateRaw);
  const hints = [];
  if (isClosed) {
    hints.push({
      action: 'set',
      cmd: '',
      description: 'Cannot set as current — update set is closed (complete/committed)',
    });
  } else {
    hints.push({
      action: 'set',
      cmd: `jsn updatesets set "${name}"`,
      description: 'Set as current update set',
    });
  }
  hints.push({
    action: 'parent',
    cmd: `jsn updatesets parent "${name}" --parent "<parent set name>"`,
    description: 'Set the parent of this update set',
  });
  if (!isClosed) {
    hints.push({
      action: 'complete',
      cmd: `jsn updatesets complete "${name}"`,
      description: 'Mark as complete when done',
    });
  }

  return {
    sys_id: sysID,
    name,
    state,
    application,
    parent,
    sys_created_on: created,
    sys_updated_on: updated,
    children,
    link,
    _formatted: lines.join('\n'),
    hints,
  };
}

export function updateSetsCmd(wrap) {
  return {
    command: 'updatesets [subcommand]',
    aliases: ['updateset', 'us'],
    describe: 'Manage update sets',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List update sets (shows the application scope each belongs to)',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'state', 'application'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_update_set', singular: 'update set', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'state') || '?'}] (${getStringField(r, 'application') || '?'})`,
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const detail = await formatUpdateSetDetail(app, picked);
              return app.ok(detail, { summary: `Update set: ${getStringField(picked, 'name')}`, breadcrumbs: detail.hints });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_update_set', params);
            app.ok({
              table: 'sys_update_set',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} update set(s)` });
          }),
        })
        .command({
          command: 'show <name>',
          aliases: ['get'],
          describe: 'Show an update set',
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv.name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_display_value', 'all');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const detail = await formatUpdateSetDetail(app, records[0]);
            app.ok(detail, { summary: `Update set ${argv.name}`, breadcrumbs: detail.hints });
          }),
        })
        .command({
          command: 'set [name]',
          describe: 'Set the current update set (interactive picker with scope when run bare)',
          handler: wrap(async (argv, app) => {
            let name = argv.name;
            if (!name) {
              const picked = await interactiveList({
                app, table: 'sys_update_set', singular: 'update set', columns: ['name', 'state', 'application'], labelField: 'name',
                formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'state') || '?'}] (${getStringField(r, 'application') || '?'})`,
              });
              if (!picked) return; // cancelled or non-interactive
              name = getStringField(picked, 'name');
            }
            assertSafeExactMatch(name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name,application');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const userSysID = await requireCurrentUserSysId(app.sdk);
            await setCurrentUpdateSet(app.sdk, userSysID, sysID);

            // Scope-aware: if the update set belongs to a scope different from
            // the current one, changes won't be captured in it. Warn + offer.
            let scopeWarn = '';
            const updateSetScope = getStringField(records[0], 'application');
            try {
              const currentApp = await getCurrentApplication(app.sdk, userSysID);
              const currentScope = currentApp?.scope || 'global';
              if (updateSetScope && currentScope !== 'global' && updateSetScope !== currentScope) {
                scopeWarn = ` ⚠️ in scope "${updateSetScope}", but current scope is "${currentScope}" — changes won't land here. Run: jsn scopes set ${updateSetScope}`;
              }
            } catch {
              // non-fatal — warning is best-effort
            }

            app.ok({ update_set: name, sys_id: sysID }, { summary: `Current update set: ${name}${scopeWarn}` });
          }),
        })
        .command({
          command: 'parent <name>',
          describe: 'Set the parent of an update set',
          builder: (y) => y
            .positional('name', { describe: 'Update set name', type: 'string' })
            .option('parent', { type: 'string', describe: 'Parent update set name' }),
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv.name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name,application');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const childScope = getStringField(records[0], 'application');

            let parentName = argv.parent;
            if (!parentName) {
              const picked = await interactiveList({
                app, table: 'sys_update_set', singular: 'parent update set', columns: ['name', 'state', 'application'], labelField: 'name',
                formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'state') || '?'}] (${getStringField(r, 'application') || '?'})`,
              });
              if (!picked) return; // cancelled or non-interactive
              parentName = getStringField(picked, 'name');
            }
            assertSafeExactMatch(parentName);
            const parentParams = new URLSearchParams();
            parentParams.set('sysparm_query', `name=${parentName}`);
            parentParams.set('sysparm_limit', '1');
            parentParams.set('sysparm_fields', 'sys_id,name,application');
            const parentRecords = await app.sdk.list('sys_update_set', parentParams);
            if (parentRecords.length === 0) {
              throw new Error(`Parent update set not found: ${parentName}`);
            }
            const parentSysID = getStringField(parentRecords[0], 'sys_id');
            const parentScope = getStringField(parentRecords[0], 'application');

            let warn = '';
            if (childScope && parentScope && childScope !== parentScope) {
              warn = ` ⚠️ child is in scope "${childScope}", parent is in scope "${parentScope}" — allowed, but they won't commit as one unit`;
            }

            await app.sdk.update('sys_update_set', sysID, { parent: parentSysID });
            app.ok({ update_set: argv.name, parent: parentName }, { summary: `Parent of "${argv.name}" is now "${parentName}"${warn}` });
          }),
        })
        .command({
          command: 'current',
          describe: 'Show the current update set',
          handler: wrap(async (argv, app) => {
            const userSysID = await requireCurrentUserSysId(app.sdk);
            const current = await getCurrentUpdateSet(app.sdk, userSysID);
            app.ok({ update_set: current?.name || 'Default', sys_id: current?.sys_id || '' }, { summary: `Current update set: ${current?.name || 'Default'}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new update set (auto-sets as current)',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Update set name' })
            .option('description', { type: 'string', describe: 'Description' }),
          handler: wrap(async (argv, app) => {
            const record = await app.sdk.create('sys_update_set', {
              name: argv.name,
              description: argv.description || argv.name,
              state: 'in progress',
            });

            // Auto-set as current update set
            const sysID = record?.sys_id?.value || record?.sys_id;
            try {
              const userSysID = await requireCurrentUserSysId(app.sdk);
              await setCurrentUpdateSet(app.sdk, userSysID, sysID);
            } catch {
              // Non-fatal — auto-set is a convenience, not mandatory
            }

            app.ok(record, {
              summary: `Created update set: ${argv.name}`,
              breadcrumbs: [
                {
                  action: 'set',
                  cmd: `jsn updatesets set "${argv.name}"`,
                  description: 'Switch to this update set',
                },
                {
                  action: 'complete',
                  cmd: `jsn updatesets complete "${argv.name}"`,
                  description: 'Mark as complete when done',
                },
              ],
            });
          }),
        })
        .command({
          command: 'complete <name>',
          describe: 'Mark an update set as complete',
          builder: (y) => y
            .positional('name', { describe: 'Update set name', type: 'string' }),
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv.name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await app.sdk.update('sys_update_set', sysID, { state: 'complete' });
            app.ok({ update_set: argv.name, state: 'complete' }, { summary: `Update set marked complete: ${argv.name}` });
          }),
        })
        .command({
          command: 'delete <name>',
          describe: 'Delete an update set',
          builder: (y) => y
            .positional('name', { describe: 'Update set name', type: 'string' })
            .option('force', { type: 'boolean', describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv.name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            await confirmDelete(app, argv, `Delete update set "${argv.name}"?`);
            await app.sdk.delete('sys_update_set', sysID);
            app.ok({ update_set: argv.name, deleted: true }, { summary: `Deleted update set: ${argv.name}` });
          }),
        })
        .command({
          command: 'export <name>',
          describe: 'Export an update set to XML',
          builder: (y) => y
            .positional('name', {
              describe: 'Update set name',
              type: 'string',
            })
            .option('output', {
              alias: 'o',
              type: 'string',
              describe: 'Output file path (default: stdout)',
            }),
          handler: wrap(async (argv, app) => {
            assertSafeExactMatch(argv.name);
            const params = new URLSearchParams();
            params.set('sysparm_query', `name=${argv.name}`);
            params.set('sysparm_limit', '1');
            params.set('sysparm_fields', 'sys_id,name');
            const records = await app.sdk.list('sys_update_set', params);
            if (records.length === 0) {
              throw new Error(`Update set not found: ${argv.name}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const instance = app.getEffectiveInstance();
            const url = `${instance}/sys_update_set.do?XML&sysparm_sys_id=${sysID}`;
            const xml = await app.sdk.rawRequest(url, { method: 'GET' });
            if (argv.output) {
              fs.writeFileSync(argv.output, xml, 'utf-8');
              app.ok({ name: argv.name, sys_id: sysID, output: argv.output }, { summary: `Exported update set to ${argv.output}` });
            } else {
              process.stdout.write(xml + '\n');
            }
          }),
        })

    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage ServiceNow update sets.\n');
        console.log('Commands:');
        console.log('  list           List update sets (shows scope)');
        console.log('  show <name>    Show an update set');
        console.log('  set  [name]    Set the current update set (picker when run bare)');
        console.log('  current        Show the current update set');
        console.log('  create         Create a new update set (auto-sets as current)');
        console.log('  complete <name> Mark an update set as complete');
        console.log('  delete <name>  Delete an update set');
        console.log('  parent <name>  Set the parent of an update set');
        console.log('  export <name>  Export an update set to XML');
        console.log('\nRun "jsn updatesets <command> --help" for details.');
        console.log('\nTip: Create an update set first:');
        console.log('  jsn updatesets create --name "My Feature"');
        console.log('  # → Auto-set as current, then record changes are captured.');
      }
    },
  };
}
