// Generic dev subcommand builder for table-based CRUD

import { formatRecordForDisplay, getStringField, isHexString, parseDataArg, confirmDelete } from '../../helpers.js';
import { getCurrentUser, getCurrentApplication } from '../../context.js';
import { paginatedSearch } from '../../paginated-search.js';
import { isTTY, FormatAuto } from '../../output.js';

function vowelArticle(word) {
  const first = word.charAt(0).toLowerCase();
  return first === 'a' || first === 'e' || first === 'i' || first === 'o' || first === 'u' ? 'an' : 'a';
}

function buildHints(name, singular, readOnly) {
  const crumbs = [];
  if (!readOnly) {
    crumbs.push({
      action: 'create',
      cmd: `jsn ${name} create --name ... --label "..."`,
      description: `Create ${vowelArticle(singular)} ${singular}`,
    });
  }
  crumbs.push({
    action: 'show',
    cmd: `jsn ${name} show <name_or_sys_id>`,
    description: `Show ${singular} details`,
  });
  return crumbs;
}

function toSingular(name, explicitSingular) {
  if (explicitSingular) return explicitSingular;
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('es') && !name.endsWith('ses')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

async function getCurrentScope(sdk) {
  try {
    const user = await getCurrentUser(sdk);
    if (!user) return 'global';
    const app = await getCurrentApplication(sdk, user.sys_id);
    return app?.scope || 'global';
  } catch {
    return 'global';
  }
}

async function checkScope(sdk, recordScope) {
  const currentScope = await getCurrentScope(sdk);
  if (currentScope === 'global') return null;
  if (currentScope === recordScope) return null;
  return { currentScope, recordScope };
}

/**
 * Resolve the API scope name from a record's sys_scope reference field.
 * With sysparm_display_value=all, sys_scope is { display_value: "Name", value: "<sys_id>" }.
 * getStringField returns the display_value (human-readable), but we need the API name
 * (e.g. "x_example_app") to compare against getCurrentScope().
 */
async function resolveRecordScope(sdk, record) {
  const sysScope = record['sys_scope'];
  let scopeId;
  if (sysScope && typeof sysScope === 'object' && sysScope.value) {
    scopeId = sysScope.value;
  } else {
    return getStringField(record, 'sys_scope');
  }
  try {
    const scopeRecord = await sdk.get('sys_scope', scopeId);
    return scopeRecord?.scope || 'global';
  } catch {
    return getStringField(record, 'sys_scope');
  }
}

export function buildDevCmd(name, table, aliases, defaultColumns, wrap, opts = {}) {
  const showFields = opts.showFields !== undefined ? opts.showFields : null;
  const singular = toSingular(name, opts.singular);
  const readOnly = opts.readOnly || false;
  const scopeValidation = opts.scopeValidation || false;
  const extraQuery = opts.extraQuery || '';
  const showSummary = opts.showSummary || ((record, id) => `${singular.charAt(0).toUpperCase() + singular.slice(1)}: ${getStringField(record, 'name') || id}`);
  const showBreadcrumbs = opts.showBreadcrumbs || ((record, id) => {
    const crumbs = [
      { action: 'list', cmd: `jsn ${name} list`, description: `Back to all ${name}` },
    ];
    if (!readOnly) {
      crumbs.unshift(
        { action: 'delete', cmd: `jsn ${name} delete ${id}`, description: `Delete this ${singular}` },
        { action: 'update', cmd: `jsn ${name} update ${id} --data '{...}'`, description: `Update this ${singular}` }
      );
    }
    return crumbs;
  });

  const builder = (yargs) => {
    let y = yargs
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: `List ${name}`,
        builder: (y) => y
          .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true^priority=1")' })
          .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "name,label,super_class")' })
          .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
        handler: wrap(async (argv, app) => {
          const query = argv.query || '';
          const columns = argv.columns ? argv.columns.split(',') : defaultColumns;
          const limit = argv.limit;

          // Interactive picker with pagination
          const interactive = isTTY(process.stdout) && isTTY(process.stdin);
          if (interactive && app.output.getFormat() === FormatAuto && !query) {
            // Get total count
            let totalCount = 0;
            try {
              totalCount = await app.sdk.aggregateCount(table, extraQuery || '');
            } catch { /* non-critical */ }

            const source = async (term, offset, { signal: _signal } = {}) => {
              const params = new URLSearchParams();
              params.set('sysparm_limit', String(limit));
              params.set('sysparm_display_value', 'all');
              params.set('sysparm_fields', ['sys_id', 'name', 'sys_scope'].join(','));
              if (term) {
                params.set('sysparm_query', `nameLIKE${term}^ORDERBYDESCsys_updated_on`);
              } else {
                params.set('sysparm_query', (extraQuery ? extraQuery + '^' : '') + 'ORDERBYDESCsys_updated_on');
                params.set('sysparm_offset', String(offset));
              }
              const records = await app.sdk.list(table, params);
              return records.map(r => {
                const recordName = getStringField(r, 'name') || getStringField(r, 'sys_id');
                const scope = getStringField(r, 'sys_scope') || '';
                let label = recordName;
                if (scope && scope !== 'global') label += ` [${scope}]`;
                return { name: label, value: recordName };
              });
            };

            const selectedName = await paginatedSearch({
              message: `Select ${vowelArticle(singular)} ${singular}`,
              pageSize: 10,
              totalCount,
              source,
            });

            if (selectedName) {
              const recordName = typeof selectedName === 'object' ? selectedName.value : selectedName;
              const showParams = new URLSearchParams();
              showParams.set('sysparm_query', `name=${recordName}`);
              showParams.set('sysparm_display_value', 'all');
              showParams.set('sysparm_limit', '1');
              const showRecords = await app.sdk.list(table, showParams);
              if (showRecords.length === 0) {
                throw new Error(`${singular} not found: ${recordName}`);
              }
              const record = showRecords[0];
              record._context = { instance_url: app.getEffectiveInstance(), table };
              if (opts.onShow) {
                await opts.onShow(record, app);
              }
              app.ok(record, {
                summary: `${singular.charAt(0).toUpperCase() + singular.slice(1)}: ${recordName}`,
                breadcrumbs: [
                  ...(readOnly ? [] : [{ action: 'update', cmd: `jsn ${name} update ${recordName} --data '{...}'`, description: `Update this ${singular}` }]),
                  { action: 'list', cmd: `jsn ${name} list`, description: `Back to all ${name}` },
                ],
              });
            }
            return;
          }

          // Non-interactive: text/table output
          const params = new URLSearchParams();
          params.set('sysparm_limit', String(limit));
          params.set('sysparm_display_value', 'all');
          params.set('sysparm_fields', ['sys_id', ...columns].join(','));
          const baseQ = extraQuery ? extraQuery + '^' : '';
          const q = query ? query + '^ORDERBYDESCsys_updated_on' : (baseQ + 'ORDERBYDESCsys_updated_on');
          params.set('sysparm_query', q);
          const records = await app.sdk.list(table, params);
          app.ok({
            table,
            count: records.length,
            columns,
            records: records.map(r => formatRecordForDisplay(r, columns)),
            context: { instance_url: app.getEffectiveInstance() },
          }, {
            summary: `${records.length} ${name}(s)`,
            breadcrumbs: buildHints(name, singular, readOnly),
          });
        }),
      })
      .command({
        command: 'show <identifier>',
        aliases: ['get'],
        describe: `Show ${vowelArticle(singular)} ${singular} by name or sys_id`,
        handler: wrap(async (argv, app) => {
          const id = argv.identifier;
          const queryField = isHexString(id) && id.length === 32 ? 'sys_id' : 'name';
          const params = new URLSearchParams();
          params.set('sysparm_query', `${queryField}=${id}`);
          params.set('sysparm_limit', '1');
          params.set('sysparm_display_value', 'all');
          // Only restrict sysparm_fields if showFields is explicitly set.
          // Go version fetches all fields for show unless explicitly restricted.
          if (showFields && showFields.length > 0) {
            params.set('sysparm_fields', [...new Set(['sys_id', ...showFields])].join(','));
          }
          const records = await app.sdk.list(table, params);
          if (records.length === 0) {
            throw new Error(`${singular} not found: ${id}`);
          }
          records[0]._context = {
            instance_url: app.getEffectiveInstance(),
            table,
          };

          if (opts.onShow) {
            await opts.onShow(records[0], app);
          }

          const summary = typeof showSummary === 'function' ? showSummary(records[0], id) : showSummary;
          const breadcrumbs = typeof showBreadcrumbs === 'function' ? showBreadcrumbs(records[0], id) : showBreadcrumbs;

          app.ok(records[0], { summary, breadcrumbs });
        }),
      });

    if (!readOnly) {
      y = y
        .command({
          command: 'create',
          describe: `Create a new ${singular}`,
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON fields (e.g. \'{"state":"2"}\')' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' }),
          handler: wrap(async (argv, app) => {
            const recordData = parseDataArg(argv);
            const record = await app.sdk.create(table, recordData);
            app.ok(record, {
              summary: `Created ${singular}`,
              breadcrumbs: [
                { action: 'show', cmd: `jsn ${name} show ${getStringField(record, 'name') || getStringField(record, 'sys_id')}`, description: `View the new ${singular}` },
              ],
            });
          }),
        })
        .command({
          command: 'update <identifier>',
          describe: `Update ${vowelArticle(singular)} ${singular}`,
          builder: (y) => y
            .option('data', { type: 'string', describe: 'JSON fields (e.g. \'{"state":"2"}\')' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const queryField = isHexString(id) && id.length === 32 ? 'sys_id' : 'name';
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `${queryField}=${id}`);
            findParams.set('sysparm_limit', '1');
            findParams.set('sysparm_display_value', 'all');
            const records = await app.sdk.list(table, findParams);
            if (records.length === 0) {
              throw new Error(`${singular} not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const recordScope = await resolveRecordScope(app.sdk, records[0]);

            if (scopeValidation) {
              const scopeErr = await checkScope(app.sdk, recordScope);
              if (scopeErr) {
                throw new Error(`record is in scope '${scopeErr.recordScope}', but your current scope is '${scopeErr.currentScope}'. Switch scope first: jsn scopes set ${scopeErr.recordScope}`);
              }
            }

            const recordData = parseDataArg(argv);
            const updated = await app.sdk.update(table, sysID, recordData);
            app.ok(updated, { summary: `Updated ${singular} ${id}` });
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: `Delete ${vowelArticle(singular)} ${singular}`,
          builder: (y) => y.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const queryField = isHexString(id) && id.length === 32 ? 'sys_id' : 'name';
            const findParams = new URLSearchParams();
            findParams.set('sysparm_query', `${queryField}=${id}`);
            findParams.set('sysparm_limit', '1');
            findParams.set('sysparm_display_value', 'all');
            const records = await app.sdk.list(table, findParams);
            if (records.length === 0) {
              throw new Error(`${singular} not found: ${id}`);
            }
            const sysID = getStringField(records[0], 'sys_id');
            const recordName = getStringField(records[0], 'name') || id;
            const recordScope = await resolveRecordScope(app.sdk, records[0]);

            if (scopeValidation) {
              const scopeErr = await checkScope(app.sdk, recordScope);
              if (scopeErr) {
                throw new Error(`record is in scope '${scopeErr.recordScope}', but your current scope is '${scopeErr.currentScope}'. Switch scope first: jsn scopes set ${scopeErr.recordScope}`);
              }
            }

            await confirmDelete(app, argv, `Delete ${singular} '${recordName}'`);

            await app.sdk.delete(table, sysID);
            app.ok({ name: recordName, sys_id: sysID, deleted: true }, { summary: `Deleted ${singular} '${recordName}'` });
          }),
        });
    }

    return y;
  };

  return {
    command: `${name} [subcommand]`,
    aliases: aliases || [],
    describe: `Manage ${name} (e.g. "${name} list --query nameLIKEincident")`,
    builder,
    handler: (_argv) => {
      // This handler only runs when no subcommand is matched (the default case).
      // Show help for the subcommands available.
      console.log(`Manage ${name} from the ${table} table.`);
      console.log('');
      console.log('Available subcommands:');
      console.log('  list        List all records');
      console.log('  show        Show record details');
      if (!readOnly) {
        console.log('  create      Create a new record');
        console.log('  update      Update a record');
        console.log('  delete      Delete a record');
      }
      console.log(`\nRun "jsn ${name} <command> --help" for details.`);
    },
  };
}
