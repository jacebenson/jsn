import { formatRecordForDisplay, getStringField, interactiveList, assertSafeExactMatch } from '../../helpers.js';
import { requireCurrentUserSysId, setCurrentApplication } from '../../context.js';
import { declareCapabilities } from '../../capabilities.js';
import { unwrapSysId } from '../../resolve-record.js';

declareCapabilities('scopes', { mutationSubcommands: ['create', 'set'], devAlias: true });

/**
 * Resolve a scope identifier to a single sys_scope record.
 *
 * Precedence (issue #190):
 *   1. sys_id — tried first so explicit selectors win. This catches both the
 *      32-hex form AND the canonical Global record, whose sys_id is the
 *      literal string 'global' (not hex, so isSysId() alone would miss it).
 *   2. scope value — e.g. 'global', 'x_417611_daves_o_0'. When several rows
 *      share the value (a third-party app can also report scope=global), the
 *      canonical Global record (sys_id='global') is preferred; any other tie
 *      is an ambiguous error naming the candidates.
 *   3. name — the display name, last resort.
 *
 * @param {object} sdk — SDK handle (uses sdk.list)
 * @param {string} identifier — sys_id, scope value, or name
 * @returns {Promise<object>} the sys_scope record (display values requested)
 * @throws {Error} 'Scope not found: <id>' when nothing matches, or an
 *   'Ambiguous scope' error listing candidate sys_ids on a non-global tie.
 */
export async function resolveScope(sdk, identifier) {
  assertSafeExactMatch(identifier);
  for (const queryField of ['sys_id', 'scope', 'name']) {
    const params = new URLSearchParams();
    params.set('sysparm_query', `${queryField}=${identifier}`);
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,scope,name');
    const records = await sdk.list('sys_scope', params);
    if (records.length === 0) continue;
    if (records.length === 1) return records[0];
    // Multiple matches on one field. Only the 'scope' value can legitimately
    // collide (sys_id and name are unique). Prefer the canonical Global
    // record when 'global' is in play; otherwise force an explicit choice.
    const canonical = records.find(r => unwrapSysId(r) === 'global');
    if (queryField === 'scope' && canonical) return canonical;
    const candidates = records.map(r => `${unwrapSysId(r)} (${getStringField(r, 'name') || 'unnamed'})`).join(', ');
    throw new Error(`Ambiguous scope '${identifier}' matches ${records.length} records: ${candidates}. Re-run with an explicit sys_id.`);
  }
  throw new Error(`Scope not found: ${identifier}`);
}


/** Format a picker label for a scope: "Name [scope]". */
export function formatScopeLabel(r) {
  return `${getStringField(r, 'name')} [${getStringField(r, 'scope') || '?'}]`;
}

/**
 * Rich display for a scope: header fields + record link.
 * Shared by `list` pick and `show` so they can't drift.
 */
export async function formatScopeDetail(app, record) {
  const sysID = getStringField(record, 'sys_id');
  const instance = app.getEffectiveInstance();
  const link = `${instance}/sys_scope.do?sys_id=${sysID}`;

  let full = record;
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${sysID}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', 'sys_id,name,scope,short_description,active,description,version,release_date,sys_class_name,sys_created_on,sys_updated_on');
    const recs = await app.sdk.list('sys_scope', params);
    if (Array.isArray(recs) && recs.length > 0) full = recs[0];
  } catch {
    // fall back to the passed record
  }

  // Store apps carry sys_class_name "Store Application" — link to the
  // Store search for the scope value (no store-side app ID is available
  // locally; the search URL is the reliable path).
  const isStoreApp = String(getStringField(full, 'sys_class_name')).toLowerCase().includes('store');
  const storeLink = isStoreApp ? `https://store.servicenow.com/store/apps?q=${encodeURIComponent(getStringField(full, 'scope'))}` : '';

  const lines = [];
  lines.push(`Scope: ${getStringField(full, 'name') || '?'}`);
  lines.push(`  Scope value: ${getStringField(full, 'scope') || '?'}`);
  if (getStringField(full, 'version')) lines.push(`  Version:     ${getStringField(full, 'version')}`);
  if (getStringField(full, 'release_date')) lines.push(`  Released:    ${getStringField(full, 'release_date')}`);
  if (getStringField(full, 'short_description')) lines.push(`  Description: ${getStringField(full, 'short_description')}`);
  if (getStringField(full, 'active')) lines.push(`  Active:      ${getStringField(full, 'active')}`);
  if (storeLink) lines.push(`  Store:       ${storeLink}`);
  if (getStringField(full, 'sys_created_on')) lines.push(`  Created:     ${getStringField(full, 'sys_created_on')}`);
  if (getStringField(full, 'sys_updated_on')) lines.push(`  Updated:     ${getStringField(full, 'sys_updated_on')}`);
  lines.push(`  Link:        ${link}`);

  return {
    sys_id: sysID,
    name: getStringField(full, 'name'),
    scope: getStringField(full, 'scope'),
    version: getStringField(full, 'version') || '',
    release_date: getStringField(full, 'release_date') || '',
    short_description: getStringField(full, 'short_description') || '',
    active: getStringField(full, 'active') || '',
    store_link: storeLink,
    sys_created_on: getStringField(full, 'sys_created_on') || '',
    sys_updated_on: getStringField(full, 'sys_updated_on') || '',
    link,
    _formatted: lines.join('\n'),
  };
}

export function scopesCmd(wrap) {
  return {
    command: 'scopes [subcommand]',
    aliases: ['scope', 'sc'],
    describe: 'Manage application scopes',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List application scopes',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'scope', 'short_description', 'active'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'sys_scope', singular: 'scope', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: formatScopeLabel,
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const detail = await formatScopeDetail(app, picked);
              return app.ok(detail, { summary: `Scope: ${getStringField(picked, 'name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_scope', params);
            app.ok({
              table: 'sys_scope',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} scope(s)` });
          }),
        })
        .command({
          command: 'show <scope>',
          aliases: ['get'],
          describe: 'Show a scope by scope value or name',
          builder: (y) => y
            .positional('scope', {
              describe: 'Scope value (e.g. x_417611_daves_o_0) or display name',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            const record = await resolveScope(app.sdk, argv.scope);
            const detail = await formatScopeDetail(app, record);
            app.ok(detail, { summary: `Scope ${argv.scope}` });
          }),
        })
        .command({
          command: 'set [scope]',
          describe: 'Set the current application scope (interactive picker when run bare)',
          handler: wrap(async (argv, app) => {
            let scopeArg = argv.scope;
            if (!scopeArg) {
              const picked = await interactiveList({
                app, table: 'sys_scope', singular: 'scope', columns: ['name', 'scope'], labelField: 'name',
                formatLabel: r => `${getStringField(r, 'name')} [${getStringField(r, 'scope') || '?'}]`,
              });
              if (!picked) return; // cancelled or non-interactive
              scopeArg = getStringField(picked, 'scope');
            }
            const record = await resolveScope(app.sdk, scopeArg);
            const scopeSysID = unwrapSysId(record);
            const userSysID = await requireCurrentUserSysId(app.sdk);
            await setCurrentApplication(app.sdk, userSysID, scopeSysID);
            app.ok({ scope: scopeArg, sys_id: scopeSysID }, { summary: `Current scope: ${scopeArg}` });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new application scope',
          builder: (y) => y
            .option('name', { alias: 'n', type: 'string', demandOption: true, describe: 'Application name' })
            .option('scope', { type: 'string', describe: 'Scope value (auto-generated from name if omitted)' }),
          handler: wrap(async (argv, app) => {
            let scope = argv.scope;
            if (!scope) {
              // Auto-generate scope from name: lowercase, replace spaces/special chars
              scope = 'x_' + argv.name.toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '')
                .substring(0, 38); // x_ + max 35 chars = 37, leave room
            }
            // Check for existing scope
            const existing = await app.sdk.list('sys_scope', new URLSearchParams({
              sysparm_query: `scope=${scope}`,
              sysparm_limit: '1',
            }));
            if (existing.length > 0) {
              throw new Error(`Scope '${scope}' already exists. Use a different name or --scope flag.`);
            }
            const record = await app.sdk.create('sys_scope', {
              name: argv.name,
              scope,
              short_description: argv.name,
            });
            app.ok(record, {
              summary: `Created scope: ${scope}`,
              breadcrumbs: [{
                action: 'show',
                cmd: `jsn scopes show ${scope}`,
                description: 'View the new scope',
              }],
            });
          }),
        })

    },
    handler: (argv) => {
      if (!argv._[1]) {
        console.log('Manage ServiceNow application scopes.\n');
        console.log('Commands:');
        console.log('  list           List application scopes');
        console.log('  show <scope>   Show a scope');
        console.log('  set  [scope]   Set the current application scope (picker when run bare)');
        console.log('  create         Create a new application scope');
        console.log('\nRun "jsn scopes <command> --help" for details.');
      }
    },
  };
}
