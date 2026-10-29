// Generic table-based CRUD command builder

import { formatRecordForDisplay, getStringField, buildRecordPayload, confirmDelete, interactiveList, canPrompt } from '../helpers.js';
import { getRecord, listRecords, recordListParams, createRecord, updateRecord, deleteRecord, recordOptions } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { getCurrentUser, getCurrentApplication } from '../context.js';
import { FormatAuto } from '../output.js';
import { declareCapabilities } from '../capabilities.js';

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

/**
 * Scope guard for update/delete on scoped tables: when scopeValidation is
 * enabled and the record lives outside the current scope, refuse with a
 * "switch scope first" error. Pass the resolved record straight through.
 */
async function guardScope(sdk, record) {
  const recordScope = await resolveRecordScope(sdk, record);
  const scopeErr = await checkScope(sdk, recordScope);
  if (scopeErr) {
    throw new Error(`record is in scope '${scopeErr.recordScope}', but your current scope is '${scopeErr.currentScope}'. Switch scope first: jsn scopes set ${scopeErr.recordScope}`);
  }
  return record;
}

export function buildDevCmd(name, table, aliases, defaultColumns, wrap, opts = {}) {
  const showFields = opts.showFields !== undefined ? opts.showFields : null;
  const singular = toSingular(name, opts.singular);
  const readOnly = opts.readOnly || false;
  // Capability declaration: the readOnly flag drives the mutation registry.
  declareCapabilities(name, {
    mutationSubcommands: readOnly ? [] : ['create', 'update', 'delete'],
  });
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
        { action: 'update', cmd: `jsn ${name} update ${id} -f name=value`, description: `Update this ${singular}` }
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
        builder: (y) => recordOptions(y)
          .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true^priority=1")' })
          .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "name,label,super_class")' })
          .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
        handler: wrap(async (argv, app) => {
          const query = argv.query || '';
          const columns = argv.columns ? argv.columns.split(',') : defaultColumns;
          const limit = argv.limit;

          // Interactive picker with pagination
          if (canPrompt() && app.output.getFormat() === FormatAuto && !query) {
            const picked = await interactiveList({
              app, table, singular, columns: ['name', 'sys_scope'], limit, query: extraQuery,
              labelField: 'name',
              message: `Select ${vowelArticle(singular)} ${singular}`,
              formatLabel: (r) => {
                const recordName = getStringField(r, 'name') || getStringField(r, 'sys_id');
                const scope = getStringField(r, 'sys_scope') || '';
                return (scope && scope !== 'global') ? `${recordName} [${scope}]` : recordName;
              },
            });
            if (picked === undefined || picked === null) return; // cancelled, or table is empty

            const record = picked;
            const recordName = getStringField(record, 'name') || getStringField(record, 'sys_id');
            record._context = { instance_url: app.getEffectiveInstance(), table };
            if (opts.onShow) {
              await opts.onShow(record, app, argv);
            }
            app.ok(record, {
              summary: `${singular.charAt(0).toUpperCase() + singular.slice(1)}: ${recordName}`,
              breadcrumbs: [
                ...(readOnly ? [] : [{ action: 'update', cmd: `jsn ${name} update ${recordName} -f name=value`, description: `Update this ${singular}` }]),
                { action: 'list', cmd: `jsn ${name} list`, description: `Back to all ${name}` },
              ],
            });
            return;
          }

          // Non-interactive: text/table output
          const baseQ = extraQuery ? extraQuery + '^' : '';
          const q = query ? query + '^ORDERBYDESCsys_updated_on' : (baseQ + 'ORDERBYDESCsys_updated_on');
          const params = recordListParams({ limit, fields: ['sys_id', ...columns], query: q });
          const records = await listRecords(app.sdk, { table, params, displayValues: argv.displayValues ?? opts.referenceMode });
          app.ok({
            table,
            count: records.length,
            columns,
            records: argv.displayValues || opts.listProjection === 'full' ? records : records.map(r => formatRecordForDisplay(r, columns)),
            context: { instance_url: app.getEffectiveInstance() },
          }, {
            summary: `${records.length} ${name}(s)`,
            breadcrumbs: buildHints(name, singular, readOnly),
          });
        }),
      })
      .command({
        command: opts.resolveIdentifier ? 'show [identifier]' : 'show <identifier>',
        aliases: ['get'],
        describe: `Show ${vowelArticle(singular)} ${singular} by name or sys_id`,
        builder: y => {
          const command = recordOptions(y);
          return opts.relationships?.essential?.length ? command.option('essential', { type: 'boolean', default: true,
            describe: 'Fetch profile-declared essential children; --no-essential skips them. Supplementary lists remain lazy.' }) : command;
        },
        handler: wrap(async (argv, app) => {
          const id = opts.resolveIdentifier ? await opts.resolveIdentifier(argv, app) : argv.identifier;
          if (id === undefined) return;
          // Only restrict sysparm_fields if showFields is explicitly set.
          // Go version fetches all fields for show unless explicitly restricted.
          const fields = (showFields && showFields.length > 0)
            ? [...new Set(['sys_id', ...showFields])]
            : undefined;
          const record = await getRecord(app.sdk, { table, identifier: id, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'name', resource: singular, fields });
          record._context = {
            instance_url: app.getEffectiveInstance(),
            table,
          };

          if (opts.onShow) {
            await opts.onShow(record, app, argv);
          }

          const summary = typeof showSummary === 'function' ? showSummary(record, id) : showSummary;
          const breadcrumbs = typeof showBreadcrumbs === 'function' ? showBreadcrumbs(record, id) : showBreadcrumbs;

          app.ok(record, { summary, breadcrumbs });
        }),
      });

    if (!readOnly) {
      y = y
        .command({
          command: 'create',
          describe: `Create a new ${singular}`,
          builder: (y) => recordOptions(y, false)
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const record = await createRecord(app.sdk, { table, data: recordData });
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
          builder: (y) => recordOptions(y, false)
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const record = await getRecord(app.sdk, { table, identifier: id, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'name', resource: singular });
            if (scopeValidation) {
              await guardScope(app.sdk, record);
            }

            const sysID = unwrapSysId(record);
            const recordData = buildRecordPayload(argv);
            const updated = await updateRecord(app.sdk, { table, record: { sys_id: sysID }, data: recordData });
            app.ok(updated, { summary: `Updated ${singular} ${id}` });
          }),
        })
        .command({
          command: 'delete <identifier>',
          describe: `Delete ${vowelArticle(singular)} ${singular}`,
          builder: (y) => recordOptions(y, false).option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const record = await getRecord(app.sdk, { table, identifier: id, identifierField: argv.identifierField, displayValues: argv.displayValues ?? opts.referenceMode, matchField: opts.identifierField || 'name', resource: singular });
            if (scopeValidation) {
              await guardScope(app.sdk, record);
            }

            const sysID = unwrapSysId(record);
            const recordName = getStringField(record, 'name') || id;

            await confirmDelete(app, argv, `Delete ${singular} '${recordName}'`);

            await deleteRecord(app.sdk, { table, record: { sys_id: sysID } });
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
    discovery: {
      table,
      defaultColumns,
      benefits: ['Configured list columns', 'Lookup by name or sys_id',
        ...(showFields ? ['Configured show fields'] : []),
        ...(opts.onShow ? ['Additional table-specific show processing'] : [])],
    },
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
