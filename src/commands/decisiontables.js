import fs from 'node:fs';
import { getStringField, formatRecordForDisplay, interactiveList, assertSafeExactMatch, confirmDelete } from '../helpers.js';
import { resolveRecord, unwrapSysId, isSysId } from '../resolve-record.js';
import { inspectDecisionTable } from '../decision-table-inspection.js';
import { DecisionTableCRUD } from '../decision-table-crud.js';
import { declareCapabilities } from '../capabilities.js';

export const decisiontablesCmd = (wrap) => {
  const name = 'decisiontables';
  const singular = 'decision table';
  declareCapabilities(name, { mutationSubcommands: ['create', 'update', 'delete'] });

  const readData = (argv) => {
    if (argv.dataFile) return fs.readFileSync(argv.dataFile, 'utf8');
    if (argv.data) return argv.data;
    throw new Error('--data or --data-file is required');
  };
  const dataBuilder = (y) => y
    .option('data', { type: 'string', describe: 'Complete decision-table JSON payload' })
    .option('data-file', { type: 'string', describe: 'Read complete decision-table JSON payload from a file' });
  const resolveExecutionScope = async (app) => {
    const scope = app.context?.scope;
    if (!scope) return 'global';
    const scopeSysId = await app.sdk.resolveScope(scope);
    if (!scopeSysId) throw new Error(`Scope not found: ${scope}`);
    return scopeSysId;
  };
  const resolveDecisionTableForDelete = async (app, identifier, scopeSysId) => {
    assertSafeExactMatch(identifier);
    const field = isSysId(identifier) ? 'sys_id' : 'name';
    const params = new URLSearchParams({ sysparm_query: `${field}=${identifier}^sys_scope=${scopeSysId}`, sysparm_limit: '2', sysparm_display_value: 'all' });
    const records = await app.sdk.list('sys_decision', params);
    if (records.length === 0) throw new Error(`Decision table not found in active scope: ${identifier}`);
    if (records.length > 1) throw new Error(`Decision table ${field} is ambiguous in active scope: ${identifier}`);
    return records[0];
  };
  const resolveDecisionTableForUpdate = async (app, identifier, scopeSysId) => {
    assertSafeExactMatch(identifier);
    const field = isSysId(identifier) ? 'sys_id' : 'name';
    const scopeClause = scopeSysId === 'global' ? '' : `^sys_scope=${scopeSysId}`;
    const params = new URLSearchParams({ sysparm_query: `${field}=${identifier}${scopeClause}`, sysparm_limit: '2', sysparm_display_value: 'all' });
    const records = await app.sdk.list('sys_decision', params);
    if (records.length === 0) throw new Error(`Decision table not found${scopeSysId === 'global' ? '' : ' in active scope'}: ${identifier}`);
    if (records.length > 1) throw new Error(`Decision table ${field} is ambiguous: ${identifier}`);
    const id = unwrapSysId(records[0]);
    if (!isSysId(id)) throw new Error(`Decision table returned an invalid identifier: ${identifier}`);
    return id;
  };
  const crud = (operation) => wrap(async (argv, app) => {
    app.requireInstance();
    const scopeSysId = await resolveExecutionScope(app);
    const adapter = new DecisionTableCRUD(app.sdk, { scope: scopeSysId });
    const result = operation === 'create'
      ? await adapter.create(readData(argv))
      : await adapter.update(await resolveDecisionTableForUpdate(app, argv.identifier, scopeSysId), readData(argv));
    app.ok(result, { summary: `Decision table ${operation}d` });
  });
  return {
    command: `${name} [subcommand]`,
    aliases: ['decisiontable'],
    describe: 'Manage decision tables',
    builder: (yargs) => yargs
      .command({
        command: 'list', aliases: ['ls'], describe: 'List decision tables',
        builder: (y) => y.option('query', { type: 'string', describe: 'Encoded query (e.g. nameLIKEapproval)' })
          .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();

          const picked = await interactiveList({
            app,
            table: 'sys_decision',
            singular,
            columns: ['name', 'sys_scope'],
            limit: argv.limit,
            query: argv.query || '',
            labelField: 'name',
            message: 'Select a decision table',
            formatLabel: (record) => {
              const recordName = getStringField(record, 'name') || getStringField(record, 'sys_id');
              const scope = getStringField(record, 'sys_scope') || '';
              return (scope && scope.toLowerCase() !== 'global') ? `${recordName} [${scope}]` : recordName;
            },
            promptFn: app.promptFn,
          });
          if (picked === undefined) return;
          if (picked !== null && picked !== undefined) {
            const detail = await inspectDecisionTable(app, picked);
            detail._context = { instance_url: app.getEffectiveInstance(), table: 'sys_decision' };
            app.ok(detail, { summary: `Decision table: ${getStringField(picked, 'name') || getStringField(picked, 'sys_id')}` });
            return;
          }

          const params = new URLSearchParams({
            sysparm_query: argv.query || 'ORDERBYDESCsys_updated_on',
            sysparm_limit: String(argv.limit),
            sysparm_display_value: 'all',
            sysparm_fields: 'sys_id,name,description,active,sys_scope,sys_updated_on',
          });
          const records = await app.sdk.list('sys_decision', params);
          app.ok({ table: 'sys_decision', count: records.length, columns: ['name', 'active', 'sys_scope'], records: records.map((record) => formatRecordForDisplay(record, ['name', 'active', 'sys_scope'])) }, { summary: `${records.length} decision table(s)` });
        }),
      })
      .command({
        command: 'show <identifier>', aliases: ['get'], describe: 'Show a decision table matrix',
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const table = await resolveRecord(app.sdk, { table: 'sys_decision', identifier: argv.identifier, matchField: 'name', resource: singular });
          const detail = await inspectDecisionTable(app, table);
          detail._context = { instance_url: app.getEffectiveInstance(), table: 'sys_decision' };
          app.ok(detail, { summary: `Decision table: ${getStringField(table, 'name') || argv.identifier}` });
        }),
      })
      .command({
        command: 'create', describe: 'Create a decision table',
        builder: dataBuilder,
        handler: crud('create'),
      })
      .command({
        command: 'update <identifier>', describe: 'Update a decision table and its rows',
        builder: dataBuilder,
        handler: crud('update'),
      })
      .command({
        command: 'delete <identifier>', describe: 'Delete an empty decision table',
        builder: (y) => y.option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const scopeSysId = await resolveExecutionScope(app);
          const table = await resolveDecisionTableForDelete(app, argv.identifier, scopeSysId);
          const id = unwrapSysId(table);
          if (!id || !isSysId(id)) throw new Error(`Decision table not found or returned an invalid identifier: ${argv.identifier}`);
          let records;
          try {
            const [inputs, answers, questions, conditions] = await Promise.all([
              app.sdk.list('sys_decision_input', new URLSearchParams({ sysparm_query: `model=${id}`, sysparm_limit: '1000', sysparm_fields: 'sys_id,name,element' })),
              app.sdk.list('sys_decision_multi_result_element', new URLSearchParams({ sysparm_query: `decision_table=${id}`, sysparm_limit: '1000', sysparm_fields: 'sys_id,name,element' })),
              app.sdk.list('sys_decision_question', new URLSearchParams({ sysparm_query: `decision_table=${id}`, sysparm_limit: '1' })),
              app.sdk.list('sn_decision_table_decision_condition', new URLSearchParams({ sysparm_query: `decision_table=${id}`, sysparm_limit: '1' })),
            ]);
            const childIds = [...inputs, ...answers].map((row) => unwrapSysId(row)).filter(Boolean);
            childIds.forEach((childId) => { if (!isSysId(childId)) throw new Error('invalid child sys_id'); });
            const choiceClauses = [...inputs, ...answers].map((row) => {
              const name = getStringField(row, 'name');
              const element = getStringField(row, 'element');
              if (!name || !element) throw new Error('generated choice relationship is incomplete');
              assertSafeExactMatch(name);
              assertSafeExactMatch(element);
              return `name=${name}^element=${element}`;
            });
            const choices = choiceClauses.length ? await app.sdk.list('sys_choice', new URLSearchParams({ sysparm_query: choiceClauses.join('^OR'), sysparm_limit: '1' })) : [];
            records = [inputs, answers, questions, conditions, choices];
          } catch (error) {
            throw new Error('Cannot prove that the decision table is empty; refusing deletion.', { cause: error });
          }
          if (records.some((rows) => rows.length)) throw new Error('Cannot delete a decision table with related records. Remove all inputs, choices, answer elements, conditions, and questions first.');
          await confirmDelete(app, argv, `Delete decision table '${getStringField(table, 'name') || argv.identifier}'`);
          const result = await new DecisionTableCRUD(app.sdk, { scope: await resolveExecutionScope(app) }).delete(id);
          app.ok(result, { summary: 'Decision table deleted' });
        }),
      }),
    handler: wrap((_argv, app) => {
      app.ok({
        command: name,
        guidance: [
          `jsn ${name} list`,
          `jsn ${name} show <name_or_sys_id>`,
          `jsn ${name} create --data '<json>' (or --data-file <path>)`,
          `jsn ${name} update <sys_id> --data '<json>' (or --data-file <path>)`,
          `jsn ${name} delete <name_or_sys_id>`,
        ],
      }, { summary: 'Manage decision tables' });
    }),
  };
};

// Kept as a named export for direct consumers and focused tests.
export { inspectDecisionTable };
