import fs from 'node:fs';
import { formatRecordForDisplay, getStringField, interactiveList, assertSafeExactMatch } from '../../helpers.js';
import { getCurrentApplication, getCurrentUpdateSet, requireCurrentUserSysId, setCurrentApplication, setCurrentUpdateSet } from '../../context.js';
import { errAPI, errUsage } from '../../errors.js';

/**
 * Scope-mismatch check for an update set vs the current app.
 * The update set's `application` is a sys_app reference — its display is the
 * app NAME ("test"), while the current app resolves to the scope VALUE
 * ("x_8821_test"). Compare by app sys_id: same sys_id = same scope.
 * @param {object} updateSetApp raw application field ({display_value, value} or string)
 * @param {object} currentApp { scope, appSysId } from getCurrentApplication
 * @returns {string} warning text, or '' when scopes match / can't determine
 */
export function scopeMismatchWarning(updateSetApp, currentApp) {
  if (!updateSetApp || !currentApp) return '';
  const updateSetAppId = updateSetApp?.value || (typeof updateSetApp === 'string' ? updateSetApp : '');
  if (!updateSetAppId || !currentApp.appSysId || updateSetAppId === currentApp.appSysId) return '';
  const name = updateSetApp?.display_value || updateSetApp;
  return ` ⚠️ update set is in app "${name}", but current app is "${currentApp.scope}" — changes won't land here. Run: jsn scopes set ${name}`;
}

/** Format a picker label for an update set: "Name [State] (app/scope)". */
export function formatUpdateSetLabel(r) {
  const appName = getStringField(r, 'application');
  const scopeName = getStringField(r, 'application.scope');
  const scope = appName && scopeName ? `${appName}/${scopeName}` : (appName || scopeName);
  return `${getStringField(r, 'name')} [${getStringField(r, 'state') || '?'}] (${scope || '?'})`;
}

/**
 * Resolve an update set by name, disambiguating duplicate names via the
 * current application scope. Every scope has its own "Default" update set,
 * so a bare name lookup must prefer the set in the current scope and only
 * error when it's still ambiguous.
 * @returns {object} resolved record ({sys_id,name,application,state,...})
 */
export async function resolveUpdateSetByName(app, name) {
  assertSafeExactMatch(name);
  const params = new URLSearchParams();
  params.set('sysparm_query', `name=${name}`);
  params.set('sysparm_limit', '50');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_fields', 'sys_id,name,application,state');
  const records = await app.sdk.list('sys_update_set', params);
  if (records.length === 0) {
    throw new Error(`Update set not found: ${name}`);
  }
  if (records.length === 1) return records[0];

  // Multiple sets share the name — prefer the one in the current scope.
  let scopeNote = '';
  try {
    const userSysID = await requireCurrentUserSysId(app.sdk);
    const currentApp = await getCurrentApplication(app.sdk, userSysID);
    const appIdOf = (r) => r.application?.value || (typeof r.application === 'string' ? r.application : '');
    const inScope = currentApp.appSysId ? records.find((r) => {
      const appId = appIdOf(r);
      return appId && appId === currentApp.appSysId;
    }) : undefined;
    if (inScope) return inScope;

    // OAuth/service accounts often lack the apps.current_app user preference,
    // so getCurrentApplication yields an empty appSysId and nothing matches.
    // Fall back to the user's CURRENT update set sys_id, then a unique
    // Global-scope match.
    let current;
    try { current = await getCurrentUpdateSet(app.sdk, userSysID); } catch { current = null; }
    if (current?.sys_id) {
      const byId = records.find((r) => getStringField(r, 'sys_id') === current.sys_id);
      if (byId) return byId;
    }
    const globalOnes = records.filter((r) => appIdOf(r) === 'global');
    if (globalOnes.length === 1) return globalOnes[0];
    if (!currentApp.appSysId) {
      scopeNote = ' (no apps.current_app preference — resolved nothing by scope)';
    }
  } catch (err) {
    scopeNote = ` (couldn't resolve scope: ${err.message})`;
  }

  const scopes = records.map((r) => r.application?.display_value || r.application || '?').join(', ');
  throw errUsage(`Multiple update sets named "${name}" (${records.length}): ${scopes}.${scopeNote}\nRun bare "jsn updatesets set" and pick by scope.`);
}

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
    params.set('sysparm_fields', 'sys_id,name,state,application,application.scope,parent,sys_created_on,sys_updated_on');
    const recs = await app.sdk.list('sys_update_set', params);
    if (Array.isArray(recs) && recs.length > 0) full = recs[0];
  } catch {
    // fall back to the passed record
  }

  const state = getStringField(full, 'state') || '?';
  const appName = getStringField(full, 'application') || '';
  const scopeName = getStringField(full, 'application.scope') || '';
  const application = appName && scopeName ? `${appName}/${scopeName}` : (appName || scopeName);
  const parent = getStringField(full, 'parent') || '';
  const created = getStringField(full, 'sys_created_on') || '';
  const updated = getStringField(full, 'sys_updated_on') || '';

  // Child updates: filename only, newest first by sys_updated_on.
  // Also group by element type (sys_class_name) and flag risky types for
  // pre-promotion review (update-set members that can clobber prod).
  const RISKY_TYPES = new Set([
    'sys_script',            // business rules
    'sys_script_include',    // script includes
    'sys_script_client',     // client scripts
    'sys_security_acl',      // ACLs / access controls
    'sys_ui_action',         // UI actions
    'sys_process_flow',      // flows
    'sys_flow',              // flow definitions
    'sys_hub_flow',          // flow definitions (flow-designer)
    'sys_script_trigger',    // workflow/script triggers
    'sys_script_email_event',// email notifications/actions
    'sys_script_queue',      // scheduled jobs
    'sys_script_widget',
  ]);
  let children = [];
  const byType = {};
  const risky = [];
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `update_set=${sysID}^ORDERBYDESCsys_updated_on`);
    params.set('sysparm_limit', '500');
    params.set('sysparm_fields', 'name,sys_updated_on,sys_class_name');
    const updates = await app.sdk.list('sys_update_xml', params);
    if (Array.isArray(updates)) {
      for (const u of updates) {
        const name = getStringField(u, 'name');
        if (!name) continue;
        // sys_class_name is often empty on dev; fall back to the element-type
        // prefix baked into the update name (e.g. sys_security_acl_<sysid32>).
        let type = getStringField(u, 'sys_class_name');
        if (!type) {
          const m = /^(sys_[a-z_]+?)_[0-9a-f]{32}$/i.exec(name);
          type = m ? m[1] : '?';
        }
        children.push({ name, type });
        if (type && type !== '?') byType[type] = (byType[type] || 0) + 1;
        if (type && RISKY_TYPES.has(type)) risky.push(name);
      }
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
  lines.push(`Updates:   ${children.length}`);
  const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    lines.push(`  By type:  ${typeEntries.map(([t, n]) => `${t}×${n}`).join(', ')}`);
  }
  if (risky.length > 0) {
    lines.push(`  ⚠️ Risky:  ${risky.length} (business rules, ACLs, client scripts, flows, ...)`);
    for (const r of risky.slice(0, 10)) {
      lines.push(`    ⚠️ ${r}`);
    }
    if (risky.length > 10) lines.push(`    … and ${risky.length - 10} more`);
  }
  for (const c of children) {
    lines.push(`    ${c.name}`);
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
  hints.push({
    action: 'export',
    cmd: `jsn updatesets export "${name}" --out ${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xml`,
    description: 'Export this update set to XML',
  });
  if (!isClosed) {
    hints.push({
      action: 'complete',
      cmd: 'jsn updatesets complete',
      description: 'Mark the current update set as complete (set it first with jsn updatesets set)',
    });
    hints.push({
      action: 'ignore',
      cmd: 'jsn updatesets ignore',
      description: 'Ignore the current update set (won\'t be installed)',
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
    by_type: byType,
    risky_count: risky.length,
    risky,
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
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'state', 'application', 'application.scope'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_update_set', singular: 'update set', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: formatUpdateSetLabel,
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
          aliases: ['get', 'review'],
          describe: 'Show an update set (members, type counts, risky items)',
          handler: wrap(async (argv, app) => {
            const record = await resolveUpdateSetByName(app, argv.name);
            const detail = await formatUpdateSetDetail(app, record);
            app.ok(detail, { summary: `Update set ${argv.name}`, breadcrumbs: detail.hints });
          }),
        })
        .command({
          command: 'export <name>',
          describe: 'Export an update set to XML (raw XML to stdout, or --out file)',
          builder: (y) => y
            .positional('name', { describe: 'Update set name', type: 'string' })
            .option('out', { alias: 'o', type: 'string', describe: 'Write XML to this file instead of stdout' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const record = await resolveUpdateSetByName(app, argv.name);
            const sysID = getStringField(record, 'sys_id');
            // The fluent export endpoint wants the update set's SCOPE sys_id
            // (application is a sys_scope reference) so it can resolve the
            // app's update set members.
            const appSysId = record.application?.value
              || (typeof record.application === 'string' ? record.application : '');

            // Fluent export endpoint: warm session → CSRF → GET. Returns the
            // full update set XML (header + all sys_update_xml payloads).
            const xml = await app.sdk.exportUpdateSet(sysID, appSysId);

            // Guard: the endpoint returns the XML document itself. If we got
            // anything that doesn't start like XML it's an error/login page.
            const trimmed = xml.trimStart();
            if (!/^(<\?xml|<unload)/i.test(trimmed)) {
              throw errAPI(200, `Export returned a non-XML response (${trimmed.slice(0, 60)}…) — the instance may need an authenticated session.`);
            }

            const bytes = Buffer.byteLength(xml, 'utf-8');
            if (argv.out) {
              await fs.promises.writeFile(argv.out, xml);
              app.ok({
                update_set: getStringField(record, 'name'),
                sys_id: sysID,
                out: argv.out,
                bytes,
              }, { summary: `Exported update set "${getStringField(record, 'name')}" (${bytes} bytes) to ${argv.out}` });
              return;
            }

            // No --out: raw XML to stdout so it pipes cleanly
            // (`jsn updatesets export "X" > set.xml`). Only wrap in the JSON
            // envelope when the user explicitly asks for it — auto format
            // detection must NOT hijack the payload for piped consumers.
            if (argv.json || argv.format === 'json') {
              app.ok({
                update_set: getStringField(record, 'name'),
                sys_id: sysID,
                xml,
                bytes,
              }, { summary: `Exported update set "${getStringField(record, 'name')}" (${bytes} bytes)` });
              return;
            }
            process.stdout.write(xml + (xml.endsWith('\n') ? '' : '\n'));
          }),
        })
        .command({
          command: 'set [name]',
          describe: 'Set the current update set (interactive picker with scope when run bare)',
          handler: wrap(async (argv, app) => {
            let name = argv.name;
            let sysID = null;
            let updateSetApp = null; // raw application field ({display_value, value} or string)
            let stateRaw = '';
            if (!name) {
              const picked = await interactiveList({
                app, table: 'sys_update_set', singular: 'update set', columns: ['name', 'state', 'application', 'application.scope'], labelField: 'name',
                formatLabel: formatUpdateSetLabel,
              });
              if (!picked) return; // cancelled or non-interactive
              // Picker returns the full record — use its sys_id directly.
              // Do NOT re-query by name: duplicate names (e.g. "Default")
              // would resolve to the wrong record.
              name = getStringField(picked, 'name');
              sysID = getStringField(picked, 'sys_id');
              updateSetApp = picked.application;
              stateRaw = String(picked.state?.value ?? picked.state ?? '').toLowerCase();
            }
            if (!sysID) {
              const resolved = await resolveUpdateSetByName(app, name);
              sysID = getStringField(resolved, 'sys_id');
              updateSetApp = resolved.application;
              stateRaw = String(resolved.state?.value ?? resolved.state ?? '').toLowerCase();
            }
            if (['complete', 'ignore'].includes(stateRaw)) {
              throw errUsage(`Cannot set "${name}" as current — update set is ${stateRaw === 'ignore' ? 'ignored' : 'complete'}.\nView it instead: jsn updatesets show "${name}"`);
            }
            const userSysID = await requireCurrentUserSysId(app.sdk);
            await setCurrentUpdateSet(app.sdk, userSysID, sysID);

            // Like the platform update set picker: switching the set also
            // switches the application scope into the set's scope. The
            // application field is a sys_scope reference, so its raw value
            // IS the scope sys_id the apps.current_app preference stores.
            let scopeNote = '';
            try {
              const scopeSysId = updateSetApp?.value || (typeof updateSetApp === 'string' ? updateSetApp : '');
              if (scopeSysId) {
                await setCurrentApplication(app.sdk, userSysID, scopeSysId);
                const scopeName = updateSetApp?.display_value || updateSetApp;
                scopeNote = ` — scope switched to ${scopeName}`;
              }
            } catch {
              // scope switch failed — fall back to a warning
              const currentApp = await getCurrentApplication(app.sdk, userSysID).catch(() => null);
              scopeNote = scopeMismatchWarning(updateSetApp, currentApp);
            }

            app.ok({ update_set: name, sys_id: sysID }, { summary: `Current update set: ${name}${scopeNote}` });
          }),
        })
        .command({
          command: 'parent <name>',
          describe: 'Set the parent of an update set',
          builder: (y) => y
            .positional('name', { describe: 'Update set name', type: 'string' })
            .option('parent', { type: 'string', describe: 'Parent update set name' }),
          handler: wrap(async (argv, app) => {
            const child = await resolveUpdateSetByName(app, argv.name);
            const sysID = getStringField(child, 'sys_id');
            const childScope = getStringField(child, 'application');

            let parentName = argv.parent;
            if (!parentName) {
              const picked = await interactiveList({
                app, table: 'sys_update_set', singular: 'parent update set', columns: ['name', 'state', 'application', 'application.scope'], labelField: 'name',
                formatLabel: formatUpdateSetLabel,
              });
              if (!picked) return; // cancelled or non-interactive
              parentName = getStringField(picked, 'name');
            }
            const parentRecord = await resolveUpdateSetByName(app, parentName);
            const parentSysID = getStringField(parentRecord, 'sys_id');
            const parentScope = getStringField(parentRecord, 'application');

            let warn = '';
            if (childScope && parentScope && childScope !== parentScope) {
              warn = ` ⚠️ child is in scope "${childScope}", parent is in scope "${parentScope}" — allowed, but they won't commit as one unit`;
            }

            await app.sdk.update('sys_update_set', sysID, { parent: parentSysID });
            app.ok({ update_set: argv.name, parent: parentName }, { summary: `Parent of "${argv.name}" is now "${parentName}"${warn}` });
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
          command: 'complete',
          describe: 'Mark the current update set as complete',
          handler: wrap(async (argv, app) => {
            const userSysID = await requireCurrentUserSysId(app.sdk);
            const current = await getCurrentUpdateSet(app.sdk, userSysID);
            if (!current?.sys_id) {
              throw errUsage('No current update set. Set one first:\n  jsn updatesets set');
            }
            await app.sdk.update('sys_update_set', current.sys_id, { state: 'complete' });
            app.ok({ update_set: current.name, state: 'complete' }, { summary: `Update set marked complete: ${current.name}` });
          }),
        })
        .command({
          command: 'ignore',
          describe: 'Ignore the current update set (won\'t be installed)',
          handler: wrap(async (argv, app) => {
            const userSysID = await requireCurrentUserSysId(app.sdk);
            const current = await getCurrentUpdateSet(app.sdk, userSysID);
            if (!current?.sys_id) {
              throw errUsage('No current update set. Set one first:\n  jsn updatesets set');
            }
            await app.sdk.update('sys_update_set', current.sys_id, { state: 'ignore' });
            app.ok({ update_set: current.name, state: 'ignore' }, { summary: `Update set ignored: ${current.name}` });
          }),
        })

    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage ServiceNow update sets.\n');
        console.log('Commands:');
        console.log('  list           List update sets (shows scope)');
        console.log('  show <name>    Show an update set (type counts + risky items)');
        console.log('  export <name>  Export an update set to XML (stdout or --out)');
        console.log('  set  [name]    Set the current update set (picker when run bare)');
        console.log('  create         Create a new update set (auto-sets as current)');
        console.log('  complete       Mark the current update set as complete');
        console.log('  ignore         Ignore the current update set');
        console.log('  parent <name>  Set the parent of an update set');
        console.log('\nRun "jsn updatesets <command> --help" for details.');
        console.log('\nTip: Create an update set first:');
        console.log('  jsn updatesets create --name "My Feature"');
        console.log('  # → Auto-set as current, then record changes are captured.');
      }
    },
  };
}
