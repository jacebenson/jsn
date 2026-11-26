import { formatCommandList, formatRecordForDisplay, findOmittedColumns, buildQuerySuffix, buildRecordPayload, getStringField, interactiveList, resolveFieldsParam, checkDerivedFields, confirmDelete, verifyWriteBack, quoteShellArg, buildRerunCommand } from '../helpers.js';
import { deferredFamilyDefinition } from '../command-families.js';
import { listRecords, recordListParams, getRecord, createRecord, updateRecord, deleteRecord } from '../records-engine.js';
import { resolveRecord, unwrapSysId } from '../resolve-record.js';
import { findDeletedRecord, restoreDeletedRecord, previewRelatedUndelete, runRelatedUndelete } from '../record-undelete.js';
import { listDeleted, deletedBreadcrumb, formatDeleted } from '../record-deleted.js';
import { errAPI, errUsage } from '../errors.js';
import { exportRecordsXML, xmlExportCap, TABLE_NAME, UPDATE_SET_TABLES, MAX_UNLOAD_BYTES, planUnloadImport, importUnloadXML, countByTable } from '../record-xml.js';
import fs from 'node:fs';
import { AmbClient } from '../amb.js';
import { watchRecord } from '../record-watch.js';
import { assertMutationRecordScope, assertMutationScope } from '../intended-context.js';
import { validateReadQuery, assertWriteQuery, queryDiagnostics, invalidateAfterMutation } from '../query-validate.js';
import { previewCascade } from '../delete-cascade.js';

const tableDefaultColumns = {
  incident: ['number', 'short_description', 'priority', 'state', 'assigned_to'],
  change_request: ['number', 'short_description', 'risk', 'state', 'assigned_to'],
  change_task: ['number', 'short_description', 'state', 'assigned_to'],
  problem: ['number', 'short_description', 'priority', 'state', 'assigned_to'],
  sc_request: ['number', 'short_description', 'request_state', 'requested_for'],
  sc_req_item: ['number', 'short_description', 'stage', 'assigned_to'],
  sc_task: ['number', 'short_description', 'state', 'assigned_to'],
  sys_user: ['user_name', 'name', 'email', 'active'],
  sys_user_group: ['name', 'manager', 'email'],
  cmdb_ci: ['name', 'operational_status', 'ip_address'],
  cmdb_ci_server: ['name', 'operational_status', 'ip_address'],
  cmdb_rel_ci: ['parent', 'type', 'child'],
  kb_knowledge: ['number', 'short_description', 'workflow_state', 'author'],
};

/**
 * Raw sys_id from a reference field (string or {display_value, link, value}).
 */
function refSysId(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (field.value && typeof field.value === 'string') return field.value;
    if (field.link && typeof field.link === 'string') {
      const parts = field.link.split('/');
      return parts[parts.length - 1];
    }
  }
  return '';
}

/**
 * Breadcrumbs from a cmdb_rel_ci record into the cmdb relationships walk.
 */
export function relationshipBreadcrumbs(record) {
  const parentId = refSysId(record.parent);
  const childId = refSysId(record.child);
  const crumbs = [];
  if (childId) {
    crumbs.push({
      action: 'relationships',
      cmd: `jsn cmdb relationships --ci ${childId}`,
      description: "Traverse from this relationship's child CI",
    });
  }
  if (parentId) {
    crumbs.push({
      action: 'impact',
      cmd: `jsn cmdb relationships --ci ${parentId} --impact`,
      description: 'Impact analysis upstream from the parent CI',
    });
  }
  return crumbs;
}

function getDefaultColumns(table) {
  return tableDefaultColumns[table] || ['sys_id'];
}

function recordLookup(argv) {
  const sysId = argv['sys-id'];
  if ((sysId === undefined) === (argv.identifier === undefined)) throw errUsage('Supply exactly one of --sys-id or --identifier.');
  if (sysId !== undefined && argv.identifierField && argv.identifierField !== 'sys_id') throw errUsage('--sys-id cannot be combined with a different --identifier-field.');
  return { table: argv.table, identifier: sysId ?? argv.identifier,
    identifierField: sysId !== undefined ? 'sys_id' : (argv.identifierField || 'sys_id'),
    displayValues: argv.displayValues, resource: 'Record' };
}

export function recordsCmd(wrap) {
  return {
    ...deferredFamilyDefinition('records'),
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          describe: 'List records from a table',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Record sys_id (filters to a single record)' })
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident" or "active=true")' })
            .option('refresh-metadata', { type: 'boolean', default: false, describe: 'Refresh table metadata used to validate --query (five-minute cache)' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('limit', { type: 'number', default: 20, describe: 'Max records' })
            .option('offset', { type: 'number', default: 0, describe: 'Offset' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('count', { type: 'boolean', default: true, describe: 'Include the total-matching count (use --no-count to opt out)' })
            .epilogue([
              'In an interactive terminal with automatic output, browse a picker (10 visible items).',
              'Use arrow keys to browse, type to search sys_id on the server, scroll to load more,',
              'and press Enter to select or Esc to cancel. --sys-id skips the picker.',
              'Use --json for noninteractive structured output; pipes and explicit formats also skip the picker.',
              'Example: jsn records list --table incident --query "active=true" --limit 5 --json',
              'JSON shape (abbreviated): {"ok":true,"data":{"records":[{"sys_id":"...","number":"INC0010001"}]},...}',
              'Records are at data.records; fields are directly on each record (e.g. record.number).',
              'Array only: jsn records list --table incident --get data.records',
              'Discover fields with: jsn columns list --table incident',
            ].join('\n')),
          handler: wrap(async (argv, app) => {
            const table = argv.table;
            const columns = argv.columns ? argv.columns.split(',') : getDefaultColumns(table);
            let query = argv.query || '';
            const verdict = await validateReadQuery(app, { table, query: argv.query || '', refresh: argv['refresh-metadata'] });

            // If --sys-id is provided, append it to the query
            if (argv['sys-id']) {
              if (query) query += '^';
              query += `sys_id=${argv['sys-id']}`;
            }

            // Interactive picker (only when no --sys-id filter, otherwise go straight to results)
            if (!argv['sys-id']) {
              const picked = await interactiveList({
                app, table, singular: 'record', columns, limit: argv.limit, query, labelField: 'sys_id',
                formatLabel: r => {
                  // Relationship rows read best as "parent <type> child [sys_id]"
                  if (table === 'cmdb_rel_ci') {
                    const parent = getStringField(r, 'parent');
                    const type = getStringField(r, 'type') || 'Related to';
                    const child = getStringField(r, 'child');
                    return `${parent || '?'} ${type} ${child || '?'} [${getStringField(r, 'sys_id')}]`;
                  }
                  const cols = getDefaultColumns(table);
                  return cols.map(c => `${c}: ${getStringField(r, c) || '-'}`).join(' | ');
                },
              });
              if (picked) {
                picked._context = { instance_url: app.getEffectiveInstance(), table };
                const crumbs = table === 'cmdb_rel_ci' ? relationshipBreadcrumbs(picked) : [];
                return app.ok(picked, {
                  summary: `Record from ${table}`,
                  ...(crumbs.length ? { breadcrumbs: crumbs } : {}),
                });
              }
            }

            // Text/table fallback (or sys-id direct lookup)
            const fields = resolveFieldsParam(columns);
            const params = recordListParams({ limit: argv['sys-id'] ? 1 : argv.limit, offset: argv.offset, fields, query });
            const responseMetadata = {};
            const records = await listRecords(app.sdk, { table, params, displayValues: argv.displayValues, responseMetadata });
            const missingColumns = fields ? findOmittedColumns(records, columns) : [];
            const presentColumns = missingColumns.length ? columns.filter(c => !missingColumns.includes(c)) : columns;
            const displayRecords = fields && !argv.displayValues ? records.map(r => formatRecordForDisplay(r, presentColumns)) : records;

            // include_counts: default opt-in on every list. Opt out per-profile
            // (config include_counts:false) or per-invocation (--no-count).
            const profile = (app.config.profiles || {})[app.config.activeProfile || app.config.defaultProfile] || {};
            const countsOn = argv.count !== false && profile.include_counts !== false;
            let total;
            if (countsOn && !argv['sys-id']) {
              total = responseMetadata.total;
              if (total === undefined) {
                try { total = await app.sdk.aggregateCount(table, query); } catch { total = undefined; }
              }
            }

            const breadcrumbs = [
              { action: 'create', cmd: `jsn records create --table ${table} -f name=value`, description: 'Create a new record' },
              { action: 'filter', cmd: `jsn records list --table ${table} --query "priority=1"`, description: 'Filter: priority 1 only' },
              { action: 'columns', cmd: `jsn columns list --table ${table}`, description: 'View available columns' },
            ];
            if (argv['sys-id']) {
              breadcrumbs.unshift({
                action: 'get',
                cmd: `jsn records get --table ${table} --sys-id ${argv['sys-id']}`,
                description: 'Get full record details',
              });
            }
            if (records.length === argv.limit) {
              breadcrumbs.push({
                action: 'next',
                cmd: `jsn records list --table ${table} --limit ${argv.limit} --offset ${argv.offset + argv.limit}${buildQuerySuffix(argv.query)}`,
                description: `Next page`,
              });
            }
            if (argv.offset > 0) {
              breadcrumbs.push({
                action: 'prev',
                cmd: `jsn records list --table ${table} --limit ${argv.limit} --offset ${Math.max(0, argv.offset - argv.limit)}${buildQuerySuffix(argv.query)}`,
                description: 'Previous page',
              });
            }
            app.ok({
              table,
              count: records.length,
              columns,
              ...(missingColumns.length ? {
                missing_columns: missingColumns,
                warnings: [
                  `Column(s) not returned by ServiceNow (non-existent or restricted on ${table}): ${missingColumns.join(', ')}. Run \`jsn columns list --table ${table}\` to inspect valid fields.`,
                ],
              } : {}),
              records: displayRecords,
              pagination: { limit: argv.limit, offset: argv.offset, ...(total != null ? { total, hasMore: argv.offset + argv.limit < total } : {}) },
              context: { instance_url: app.getEffectiveInstance() },
              ...queryDiagnostics(verdict),
            }, {
              summary: `${records.length} record(s) from ${table}${total != null ? ` of ${total}` : ''}`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'watch',
          describe: 'Stream change events for one record, or every record matching a query, through ServiceNow AMB record watchers',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Record sys_id' })
            .option('query', { type: 'string', describe: 'Encoded query: watch every matching record (e.g. "priority=1^active=true")' })
            .option('operation', { type: 'string', choices: ['insert', 'update', 'delete'], describe: 'Only emit this kind of change' })
            .option('on-change', { type: 'string', describe: 'Only emit changes to one of these comma-separated fields (e.g. "state,assigned_to")' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('timeout', { type: 'number', default: 0, describe: 'Stop after this many seconds (0 = until interrupted)' })
            .option('max-events', { type: 'number', default: 0, describe: 'Stop after this many change events (0 = unlimited)' })
            .option('state', { type: 'string', choices: ['auto', 'always', 'never'], default: 'auto', describe: 'Fetch current record state after an event: auto (only when the notification lacks detail), always, never' })
            .option('fields', { type: 'string', describe: 'Comma-separated fields for the fetched state (default all readable fields)' })
            .option('reconnect', { type: 'boolean', default: true, describe: 'Reconnect after a dropped connection and report the gap; use --no-reconnect to fail fast' })
            .option('poll-timeout', { type: 'number', default: 60000, describe: 'Long-poll hold timeout in milliseconds (advanced)' })
            .epilogue([
              'Emits newline-delimited JSON events (type record_change, gap, subscribed, reconnected, watch_summary) with --json or when piped; a --query that cannot be fully verified first emits query_validation.',
              'The notification is emitted as the event; a fetched record is attached separately as event.state (source: "fetched").',
              'Record watchers are best effort: after a reconnect the stream reports a gap and does not replay missed events.',
              'Needs a ServiceNow UI session, which jsn opens from basic, OAuth or browser (gck) profiles. Not a durable queue or scheduler.',
              'Example: jsn records watch --table incident --sys-id <sys_id> --timeout 300 --json',
              'Example: jsn records watch --table incident --identifier INC0010001 --identifier-field number --max-events 1 --json',
              'Example: jsn records watch --table incident --query "priority=1^active=true" --operation update --on-change state,assigned_to --timeout 300 --json',
            ].join('\n')),
          handler: wrap(async (argv, app) => {
            const query = argv.query;
            const onChange = argv['on-change'] === undefined ? [] : argv['on-change'].split(',').map(field => field.trim()).filter(Boolean);
            if (argv['on-change'] !== undefined && !onChange.length) throw errUsage('--on-change needs at least one field name.');
            let sysID = null;
            if (query !== undefined) {
              if (argv['sys-id'] !== undefined || argv.identifier !== undefined || argv.identifierField !== undefined) throw errUsage('--query watches every matching record; it cannot be combined with --sys-id, --identifier or --identifier-field.');
              if (!query.trim()) throw errUsage('--query needs an encoded query, for example "priority=1^active=true".');
              // A misspelt field must not silently widen or empty the channel: refuse what is invalid, report what is unverified.
              const { query_validation: validation, warnings = [] } = queryDiagnostics(await validateReadQuery(app, { table: argv.table, query, refresh: argv['refresh-metadata'] }));
              if (warnings.length) app.output.writeEvent({ type: 'query_validation', ...validation, warnings }, { line: warnings.map(warning => `⚠ ${warning}`).join('\n') });
            } else {
              if (argv['sys-id'] === undefined && argv.identifier === undefined) throw errUsage('Supply exactly one of --sys-id, --identifier or --query.');
              const record = await resolveRecord(app.sdk, { ...recordLookup(argv), fields: ['sys_id'] });
              sysID = unwrapSysId(record);
              if (!sysID) throw errUsage('The matched record has no readable sys_id; check field ACLs before retrying.');
            }
            const stateFields = argv.fields ? argv.fields.split(',').filter(Boolean) : null;

            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once('SIGINT', cancel);
            process.once('SIGTERM', cancel);

            const emit = (data, line) => app.output.writeEvent(data, { line });
            // A live record-watcher notification carries `record`: a map of the
            // fields that changed plus sys_* audit fields. It does not carry the
            // `changes` array. Render the changed fields so human output names
            // what moved; the values are current, because the platform does not
            // send the previous value.
            const describeRecord = record => Object.entries(record && typeof record === 'object' ? record : {})
              .filter(([field]) => !field.startsWith('sys_'))
              .slice(0, 5)
              .map(([field, entry]) => {
                const value = entry && typeof entry === 'object' ? (entry.display_value ?? entry.value) : entry;
                return `${field}: ${value === '' || value == null ? '(empty)' : value}`;
              })
              .join(', ');
            const formatEventLine = event => {
              if (event.type === 'record_change') {
                const id = event.display_value || event.sys_id;
                const changes = (event.changes || [])
                  .filter(c => c.value !== undefined || c.previous_value !== undefined || c.display_value !== undefined)
                  .map(c => `${c.field}: ${c.previous_value ?? '?'} → ${c.display_value ?? c.value ?? '?'}`)
                  .join(', ');
                // Field names alone when the platform withheld the values.
                const detail = changes || describeRecord(event.record) || (event.changes || []).map(c => c.field).join(', ');
                const moved = event.operation === 'updated' ? { entry: ' (now matches)', exit: ' (no longer matches)' }[event.match] || '' : '';
                return `${event.received_at} ${event.table} ${id} ${event.operation}${moved}${detail ? ` — ${detail}` : ''}`;
              }
              if (event.type === 'unsubscribed') return `unsubscribed${event.reason ? ` (${event.reason})` : ''}`;
              if (event.type === 'gap') return `⚠ connection gap since ${event.since}: ${event.reason} (events in this window were not observed)`;
              if (event.type === 'reconnected') return `⚠ reconnected after ${event.gaps} gap(s); missed events are not replayed`;
              if (event.type === 'watch_summary') {
                return `watch ended (${event.reason}) — ${event.events} event(s), ${event.gaps} gap(s), ${Math.round(event.duration_ms / 1000)}s`;
              }
              if (event.type === 'subscribed') return `watching ${event.channel}`;
              return `${event.type}: ${event.channel || ''}`;
            };
            const onStatus = status => emit(status, formatEventLine(status));
            const onEvent = async event => emit(event, formatEventLine(event));

            const fetchState = async event => {
              const id = sysID || event.sys_id;
              if (!/^[\w-]+$/.test(id ?? '')) throw errUsage('The notification carried no usable sys_id, so the record was not read.');
              const params = new URLSearchParams({
                sysparm_query: `sys_id=${id}`,
                sysparm_limit: '1',
                sysparm_display_value: 'all',
              });
              if (stateFields) params.set('sysparm_fields', [...new Set(['sys_id', ...stateFields])].join(','));
              const rows = await app.sdk.list(argv.table, params);
              return rows[0] ?? null;
            };

            const client = new AmbClient({
              baseUrl: app.getEffectiveInstance(),
              session: () => app.sdk.ambSession(),
              connectTimeoutMs: argv['poll-timeout'] ?? argv.pollTimeout,
            });

            try {
              const summary = await watchRecord({
                client,
                table: argv.table,
                sysID,
                query,
                operation: { insert: 'created', update: 'updated', delete: 'deleted' }[argv.operation],
                onChange,
                timeoutMs: argv.timeout > 0 ? argv.timeout * 1000 : 0,
                maxEvents: argv['max-events'] ?? argv.maxEvents,
                signal: controller.signal,
                statePolicy: argv.state,
                fetchState,
                reconnect: argv.reconnect !== false,
                onStatus,
                onEvent,
              });
              emit(summary, formatEventLine(summary));
            } finally {
              process.removeListener('SIGINT', cancel);
              process.removeListener('SIGTERM', cancel);
            }
          }),
        })
        .command({
          command: 'get',
          describe: 'Get one record by sys_id or an explicit identifier field',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns (e.g. "number,short_description")' })
            .option('attachments', { type: 'boolean', default: false, describe: 'Also list the record\'s attachments' })
            .epilogue('Exact lookup precedes sys_id prefix, then suffix. Ambiguous matches fail.\nExample: jsn records get --table incident --sys-id <sys_id> --json\nExample: jsn records get --table incident --identifier INC0010001 --identifier-field number --json'),
          handler: wrap(async (argv, app) => {
            const lookup = recordLookup(argv);
            const fields = argv.columns && argv.columns !== '*' ? argv.columns.split(',') : undefined;
            const record = await getRecord(app.sdk, { ...lookup, fields, displayValue: 'true' });
            if (argv.attachments) {
              try {
                const atts = await app.sdk.listAttachments(unwrapSysId(record));
                record._attachments = atts;
              } catch {
                record._attachments = [];
              }
            }
            record._context = { instance_url: app.getEffectiveInstance(), table: argv.table };
            const crumbs = argv.table === 'cmdb_rel_ci' ? relationshipBreadcrumbs(record) : [];
            app.ok(record, {
              summary: `Record from ${argv.table}${argv.attachments ? ` (${(record._attachments || []).length} attachment(s))` : ''}`,
              ...(crumbs.length ? { breadcrumbs: crumbs } : {}),
            });
          }),
        })
        .command({
          command: 'create',
          describe: 'Create a new record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const record = await createRecord(app.sdk, { table: argv.table, data: recordData });
            invalidateAfterMutation(app, argv.table);
            const sysID = getStringField(record, 'sys_id');
            const mismatches = await verifyWriteBack(app, argv.table, sysID, recordData);
            for (const m of mismatches) {
              process.stderr.write(`⚠ field "${m.field}" was not persisted (sent: "${m.sent}", got: "${m.got}")\n`);
            }
            if (mismatches.length > 0 && argv.strict) {
              throw new Error(`Strict mode: ${mismatches.length} field(s) not persisted after create`);
            }
            app.ok(record, { summary: `Created record in ${argv.table}` });
          }),
        })
        .command({
          command: 'update',
          describe: 'Update an existing record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('data', { type: 'string', describe: 'JSON fields' })
            .option('data-file', { type: 'string', describe: 'Read JSON payload from file' })
            .option('data-stdin', { type: 'boolean', describe: 'Read JSON payload from stdin (pipe-friendly)' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('strict', { type: 'boolean', default: false, describe: 'Exit non-zero if any supplied field was not persisted (write-back check)' }),
          handler: wrap(async (argv, app) => {
            const recordData = buildRecordPayload(argv);
            const warnings = checkDerivedFields(argv.table, recordData);
            for (const w of warnings) {
              process.stderr.write(`⚠ ${w.hint}\n`);
            }
            const lookup = recordLookup(argv);
            const resolved = await getRecord(app.sdk, lookup);
            const record = await updateRecord(app.sdk, { table: argv.table, record: resolved, data: recordData });
            invalidateAfterMutation(app, argv.table);
            const mismatches = await verifyWriteBack(app, argv.table, unwrapSysId(resolved), recordData);
            for (const m of mismatches) {
              process.stderr.write(`⚠ field "${m.field}" was not persisted (sent: "${m.sent}", got: "${m.got}")\n`);
            }
            if (mismatches.length > 0 && argv.strict) {
              throw new Error(`Strict mode: ${mismatches.length} field(s) not persisted after update`);
            }
            app.ok(record, { summary: `Updated record in ${argv.table}` });
          }),
        })
        .command({
          command: 'delete',
          describe: 'Delete a record',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('sys-id', { type: 'string', describe: 'Full or unambiguous partial record sys_id (including legacy IDs)' })
            .option('identifier', { type: 'string', describe: 'Identifier value; use --identifier-field number/name/etc for human identifiers' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id); disambiguates names and legacy sys_ids' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            const lookup = recordLookup(argv);
            await confirmDelete(app, argv, `Delete record from ${argv.table} (${lookup.identifier})`);
            const sysID = await deleteRecord(app.sdk, lookup);
            invalidateAfterMutation(app, argv.table);
            app.ok({ message: 'Record deleted', table: argv.table, sys_id: sysID }, { summary: `Deleted record from ${argv.table}` });
          }),
        })
        .command({
          command: 'delete-many',
          describe: 'Delete records matching a filter; preview by default, verify after deletion',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', describe: 'Required nonempty encoded query; use records delete for a single record' })
            .option('refresh-metadata', { type: 'boolean', default: false, describe: 'Refresh table metadata before validating the filter (five-minute cache)' })
            .option('expect-count', { type: 'number', describe: 'Required for deletion: exact expected matching count' })
            .option('yes', { type: 'boolean', default: false, describe: 'Confirm deletion (requires --expect-count)' })
            .option('dry-run', { type: 'boolean', default: false, describe: 'Preview only, even with --yes' })
            .option('limit', { type: 'number', default: 200, describe: 'Safety cap: refuse if matches exceed this count' })
            .option('preview-cascade', { type: 'boolean', default: false, describe: 'Also preview the records the delete would cascade to, through a Data Management delete job that is never executed (admin)' })
            .option('keep-job', { type: 'boolean', default: false, describe: 'With --preview-cascade, keep the delete job for review in the UI' })
            .epilogue('Without --yes, reports count and up to 10 sample records without writes.\nDeletion uses per-record Table API DELETE, then re-counts the query. Concurrent changes cannot be made atomic.\n--preview-cascade inserts one sys_dm_delete job for the filter, previews up to 3 cascade levels (counts past the source table are estimates), then deletes the job unless --keep-job. Its sys_dm_delete_count rows stay behind: their delete ACL refuses even an admin. It never deletes the matching records; the --yes delete that follows records no rollback.'),
          handler: wrap(async (argv, app) => {
            if (!argv.query?.trim()) throw errUsage('--query must be nonempty. Use records delete for a single record.');
            if (argv['preview-cascade'] && argv.yes) throw errUsage('--preview-cascade previews only. Run it without --yes, then delete with the command it prints.');
            if (argv['keep-job'] && !argv['preview-cascade']) throw errUsage('--keep-job needs --preview-cascade.');
            // Complete original filter validated before count/enumeration/scope reads or any write.
            await assertWriteQuery(app, { table: argv.table, query: argv.query, refresh: argv['refresh-metadata'] });
            if (!Number.isSafeInteger(argv.limit) || argv.limit < 1) throw errUsage('--limit must be a positive safe integer.');
            const dryRun = !argv.yes || argv['dry-run'];
            const expected = argv['expect-count'];
            if (!dryRun && (!Number.isSafeInteger(expected) || expected < 0)) throw errUsage('Deletion requires --expect-count as a nonnegative safe integer.');
            const countMatches = async () => {
              const count = await app.sdk.aggregateCount(argv.table, argv.query);
              if (!Number.isSafeInteger(count) || count < 0) throw new Error('Cannot verify matching count; refusing deletion.');
              return count;
            };
            const count = await countMatches();
            if (count > argv.limit) throw errUsage(`Matched ${count} records, exceeding --limit ${argv.limit}. Raise --limit explicitly to proceed.`);
            if (!dryRun && count !== expected) throw errUsage(`Count mismatch: --expect-count ${expected}, live count ${count}. No records deleted.`);
            const readPage = (limit, offset) => listRecords(app.sdk, { table: argv.table,
              params: recordListParams({ query: argv.query, limit, offset, fields: ['sys_id', 'number'], displayValue: 'false' }) });
            const rerun = ['jsn', 'records', 'delete-many', '--table', argv.table, '--query', argv.query,
              '--expect-count', String(count), '--limit', String(argv.limit), '--yes'].map(quoteShellArg).join(' ');
            const breadcrumbs = [{ action: 'verify', cmd: `jsn records aggregate --table ${quoteShellArg(argv.table)} --query ${quoteShellArg(argv.query)}`, description: 'Re-check matching records' }];
            if (dryRun) {
              const sample = count ? await readPage(Math.min(10, count), 0) : [];
              const cascade = argv['preview-cascade'] && count
                ? await previewCascade(app.sdk, { table: argv.table, query: argv.query, count, keepJob: argv['keep-job'] }) : undefined;
              const others = cascade?.tables.filter(t => t.table !== argv.table) || [];
              const left = cascade && cascade.job.status !== 'deleted';
              app.ok({ table: argv.table, query: argv.query, count, dry_run: true, sample, rerun, ...(cascade ? { cascade } : {}) }, {
                summary: `Dry run: ${count} record(s) in ${argv.table} would be deleted` + (cascade
                  ? `; cascade preview: about ${others.reduce((n, t) => n + t.count, 0)} more in ${others.length} other table(s)${cascade.more_levels ? ', and deeper levels were not counted' : ''}` : '')
                  + (left && cascade.job.status !== 'kept' ? `; delete job ${cascade.job.number} (${cascade.job.sys_id}) left in sys_dm_delete: ${cascade.job.status}` : ''),
                breadcrumbs: [{ action: 'delete', cmd: rerun, description: 'Delete with this exact expected count' },
                  ...(left ? [{ action: 'job', cmd: `jsn records get --table sys_dm_delete --sys-id ${cascade.job.sys_id}`, description: `Delete job ${cascade.job.number}, ${cascade.job.status === 'kept' ? 'kept for review' : 'left behind'}` }] : [])],
              });
              if (left && cascade.job.status !== 'kept') process.exitCode = 1;
              return;
            }
            // Snapshot all targets before deleting: offset paging over a shrinking set skips rows.
            const targets = [];
            while (targets.length < count) {
              const rows = await readPage(Math.min(1000, count - targets.length), targets.length);
              if (!rows.length) break;
              targets.push(...rows);
              if (targets.length > count) break;
            }
            const ids = targets.map(unwrapSysId);
            if (targets.length !== count || ids.some(id => !id) || new Set(ids).size !== count) {
              throw errUsage('Enumeration differs from the counted targets or contains unreadable/duplicate sys_ids. No records deleted.');
            }
            if (await countMatches() !== count) throw errUsage('Matching count changed during enumeration. No records deleted.');
            // Preflight all customization scopes before the first write, as bulk does.
            if (app.mutationContext?.verified) {
              for (const id of ids) await assertMutationRecordScope(app, argv.table, id);
            }
            const deleted = [];
            const failed = [];
            for (const record of targets) {
              try { deleted.push(await deleteRecord(app.sdk, { table: argv.table, record })); }
              catch (error) { failed.push({ sys_id: unwrapSysId(record), error: error.message || String(error) }); }
            }
            let remaining = null;
            let verificationError;
            try { remaining = await countMatches(); }
            catch (error) { verificationError = error.message; }
            const verified = failed.length === 0 && remaining === 0;
            app.ok({ table: argv.table, query: argv.query, matched: count, deleted, failed, remaining,
              verified, ...(verificationError ? { verification_error: verificationError } : {}) }, {
              summary: verified ? `Deleted ${deleted.length} record(s) from ${argv.table}; verified zero remaining`
                : `Deletion incomplete or unverified: ${deleted.length} deleted, ${failed.length} failed, ${remaining ?? 'unknown'} remaining`,
              breadcrumbs,
            });
            if (!verified) process.exitCode = 1;
          }),
        })
        .command({
          command: 'undelete',
          describe: 'Restore a deleted record from Deleted Records (sys_audit_delete)',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: "The deleted record's own table (incident, not task)" })
            .option('sys-id', { type: 'string', demandOption: true, describe: "The deleted record's sys_id" })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' })
            .option('with-related', { type: 'boolean', default: false, describe: 'Also restore what the delete cascaded to and the references it cleared, from its delete recovery; preview by default' })
            .option('yes', { type: 'boolean', default: false, describe: 'With --with-related: run it' })
            .epilogue('Restores the newest deleted copy with its sys_id and created date, as the Undelete Record action does. Attachments and records its delete cascaded to stay deleted, and references other records held to it may stay cleared. The restore is an insert, so business rules run. Needs admin and background script access.\nWith --with-related, does what the Undelete With Related action does: without --yes, counts by table what the delete recovery would bring back, without writes; with --yes, starts the platform worker (AJAXRollbackWorker), waits up to two minutes, and succeeds only when the record reads back and no recorded operation is left unrecovered. A delete recovery exists only when server-side script deleted the record, as a background script or business rule does, and the docs give seven days to use it. Needs admin.'),
          handler: wrap(async (argv, app) => {
            if (argv.yes && !argv['with-related']) throw errUsage('--yes goes with --with-related. To restore the record alone, confirm when asked or pass --force.');
            const entry = await findDeletedRecord(app, argv.table, argv['sys-id']);
            const display = entry.display_value || entry.documentkey;
            if (argv['with-related']) {
              const plan = await previewRelatedUndelete(app.sdk, entry);
              const counts = plan.operations.map(op => `${op.table} ${op.operation} ${op.count}`).join(', ');
              if (!argv.yes) {
                return app.ok({ ...plan, restored: false }, {
                  summary: `Preview: undeleting ${argv.table} ${display} with related records reverts ${plan.total} recorded operation(s) from ${plan.rollback_context.number}: ${counts}`,
                  breadcrumbs: [{ action: 'undelete', cmd: `jsn records undelete --table ${quoteShellArg(argv.table)} --sys-id ${entry.documentkey} --with-related --yes`, description: 'Run this undelete' }],
                });
              }
              const done = await runRelatedUndelete(app.sdk, plan);
              for (const table of new Set([argv.table, ...plan.operations.map(op => op.table)])) invalidateAfterMutation(app, table);
              return app.ok(done, { summary: `Restored ${argv.table} ${display} with related records from ${plan.rollback_context.number} (${plan.total} recorded operation(s) reverted: ${counts})`,
                breadcrumbs: [{ action: 'get', cmd: `jsn records get --table ${quoteShellArg(argv.table)} --sys-id ${entry.documentkey}`, description: 'Read the restored record' }] });
            }
            await confirmDelete(app, argv, `Restore ${argv.table} ${display} (${entry.documentkey}), deleted ${entry.sys_created_on} by ${entry.sys_created_by}; its attachments and cascaded records stay deleted`,
              { rerun: ['records', 'undelete', '--table', argv.table, '--sys-id', entry.documentkey] });
            await restoreDeletedRecord(app.sdk, entry);
            invalidateAfterMutation(app, argv.table);
            app.ok({ restored: true, table: argv.table, sys_id: entry.documentkey, display_value: entry.display_value, audit_delete: entry.sys_id,
              deleted_on: entry.sys_created_on, deleted_by: entry.sys_created_by }, {
              summary: `Restored ${argv.table} ${display} from Deleted Records`,
              breadcrumbs: [{ action: 'get', cmd: `jsn records get --table ${quoteShellArg(argv.table)} --sys-id ${entry.documentkey}`, description: 'Read the restored record' }],
            });
          }),
        })
        .command({
          command: 'deleted',
          describe: 'List records in Deleted Records (sys_audit_delete), whether each is back, and any delete recovery',
          builder: (y) => y
            .option('table', { type: 'string', describe: "Only records deleted from this table (the record's own table: incident, not task)" })
            .option('by', { type: 'string', describe: 'Only records deleted by this user name' })
            .option('since', { type: 'string', describe: 'Only records deleted on or after this UTC date or date-time (YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS")' })
            .option('query', { type: 'string', describe: 'Additional encoded query on sys_audit_delete' })
            .option('limit', { type: 'number', default: 20, describe: 'Max records, newest first (1-200)' })
            .epilogue('Read only. Checks each record\'s own table for its sys_id to say whether it is back, and reads any delete recovery (sys_delete_recovery) and its rollback context. A delete recovery is recorded only when a script deletes the record (a business rule or background script), and the docs give seven days to use it; Table API deletes, as records delete makes, record none. Restore one record with records undelete.'),
          handler: wrap(async (argv, app) => {
            const options = { table: argv.table, by: argv.by, since: argv.since, query: argv.query, limit: argv.limit };
            const data = await listDeleted(app.sdk, options);
            Object.defineProperty(data, '_formatted', { value: formatDeleted(data), enumerable: false });
            app.ok(data, { summary: data.count ? `${data.count} deleted record(s)${data.pagination.has_more ? ', more match' : ''}` : data.visibility, breadcrumbs: [deletedBreadcrumb(data.records)] });
          }),
        })
        .command({
          command: 'aggregate',
          describe: 'Run ServiceNow Stats API aggregation with optional grouping',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', describe: 'Encoded query to constrain the aggregation' })
            .option('refresh-metadata', { type: 'boolean', default: false, describe: 'Refresh table metadata used to validate --query (five-minute cache)' })
            .option('group-by', { type: 'string', describe: 'Comma-separated fields to group by' })
            .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' })
            .option('count', { type: 'boolean', default: true, describe: 'Include record counts' })
            .option('avg-fields', { type: 'string', describe: 'Comma-separated fields to average' })
            .option('sum-fields', { type: 'string', describe: 'Comma-separated fields to sum' })
            .option('min-fields', { type: 'string', describe: 'Comma-separated fields for minimum values' })
            .option('max-fields', { type: 'string', describe: 'Comma-separated fields for maximum values' })
            .option('order-by', { type: 'string', describe: 'Comma-separated fields to order by' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const verdict = await validateReadQuery(app, { table: argv.table, query: argv.query || '', refresh: argv['refresh-metadata'] });
            const split = (value) => value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
            const options = {
              query: argv.query || '',
              groupBy: split(argv['group-by']),
              count: argv.count !== false,
              averageFields: split(argv['avg-fields']),
              sumFields: split(argv['sum-fields']),
              minimumFields: split(argv['min-fields']),
              maximumFields: split(argv['max-fields']),
              orderBy: split(argv['order-by']),
            };
            const result = await app.sdk.aggregate(argv.table, options);
            app.ok({
              table: argv.table,
              query: options.query,
              group_by: options.groupBy,
              aggregate: {
                count: options.count,
                average_fields: options.averageFields,
                sum_fields: options.sumFields,
                minimum_fields: options.minimumFields,
                maximum_fields: options.maximumFields,
                order_by: options.orderBy,
              },
              ...result,
              context: { instance_url: app.getEffectiveInstance() },
              ...queryDiagnostics(verdict),
            }, { summary: `Aggregated ${argv.table}${options.groupBy.length ? ` by ${options.groupBy.join(', ')}` : ''}` });
          }),
        })
        .command({
          command: 'bulk',
          describe: 'Bulk-update records matching a query. Dry-run by default — pass --execute to commit',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', demandOption: true, describe: 'Encoded query selecting the records to update (e.g. "priority=1^state=1")' })
            .option('refresh-metadata', { type: 'boolean', default: false, describe: 'Refresh table metadata before validating the filter (five-minute cache)' })
            .option('set', { type: 'string', describe: 'JSON object of fields to set' })
            .option('field', { alias: 'f', type: 'string', array: true, describe: 'Set a field as name=value; repeatable' })
            .option('dry-run', { type: 'boolean', default: true, describe: 'Preview the count + a sample without mutating (default)' })
            .option('execute', { type: 'boolean', default: false, describe: 'Perform the update after confirmation' })
            .option('limit', { type: 'number', default: 200, describe: 'Max records to update when executing' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation (with --execute)' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            // Validate the complete original filter before confirmation, count or any write.
            await assertWriteQuery(app, { table: argv.table, query: argv.query, refresh: argv['refresh-metadata'] });
            const set = buildRecordPayload({ ...argv, data: argv.set }, { required: true });
            if (!argv['dry-run'] && !argv.execute) {
              argv.execute = true; // explicit --no-dry-run implies execute intent
            }
            const dryRun = argv['dry-run'] && !argv.execute;
            const count = await app.sdk.aggregateCount(argv.table, argv.query);

            if (dryRun) {
              const params = new URLSearchParams();
              params.set('sysparm_query', argv.query);
              params.set('sysparm_limit', '5');
              params.set('sysparm_fields', 'sys_id,number,name');
              let sample = [];
              try { sample = await app.sdk.list(argv.table, params); } catch { /* non-fatal */ }
              app.ok({
                table: argv.table,
                query: argv.query,
                set,
                count,
                dry_run: true,
                sample,
                context: { instance_url: app.getEffectiveInstance() },
              }, { summary: `Dry run: ${count} record(s) in ${argv.table} would be updated` });
              return;
            }

            await confirmDelete(app, argv, `Bulk update ${count} record(s) in ${argv.table}?`);
            const sysIDs = [];
            const pageSize = Math.min(argv.limit, 1000);
            const params = new URLSearchParams();
            params.set('sysparm_query', argv.query);
            params.set('sysparm_limit', String(pageSize));
            params.set('sysparm_fields', 'sys_id');
            let offset = 0;
            while (sysIDs.length < argv.limit) {
              params.set('sysparm_offset', String(offset));
              let recs;
              try { recs = await app.sdk.list(argv.table, params); } catch { break; }
              if (!recs || recs.length === 0) break;
              for (const r of recs) {
                const id = getStringField(r, 'sys_id');
                if (id) sysIDs.push(id);
              }
              if (recs.length < pageSize) break;
              offset += recs.length;
            }
            const targets = sysIDs.slice(0, argv.limit);
            if (app.mutationContext?.verified) {
              if (Object.hasOwn(set, 'sys_scope')) assertMutationScope(app.mutationContext, set.sys_scope, 'Bulk payload');
              for (const id of targets) await assertMutationRecordScope(app, argv.table, id);
            }
            let updated = 0;
            const failures = [];
            for (const id of targets) {
              try {
                await app.sdk.update(argv.table, id, set);
                updated += 1;
              } catch (e) {
                failures.push({ sys_id: id, error: e.message || String(e) });
              }
            }
            app.ok({
              table: argv.table,
              query: argv.query,
              set,
              matched: count,
              updated,
              failed: failures,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `Updated ${updated} of ${count} matching record(s) in ${argv.table}` });
          }),
        })
        .command({
          command: 'export',
          describe: 'Write records matching a query as unload XML (Export > XML), with their journal entries and attachments',
          builder: (y) => y
            .option('table', { type: 'string', demandOption: true, describe: 'Table name' })
            .option('query', { type: 'string', demandOption: true, describe: 'Required nonempty encoded query; every column must exist on the table, and date-macro and javascript: terms are refused' })
            .option('refresh-metadata', { type: 'boolean', default: false, describe: 'Refresh table metadata before validating the filter (five-minute cache)' })
            .option('limit', { type: 'number', describe: 'Export at most this many records' })
            .option('out', { alias: 'o', type: 'string', describe: 'Write XML to this new file instead of stdout' })
            .epilogue('The XML keeps sys_ids and system fields. The instance drops a term on an unknown column and caps one export at glide.xml.export.limit (10,000 by default) without saying so, so export refuses an unvalidated query and counts matches first. An update set moves whole with jsn updatesets export, not as sys_update_xml rows.'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            if (!TABLE_NAME.test(argv.table)) throw errUsage(`Invalid table name: ${argv.table}`);
            if (UPDATE_SET_TABLES.has(argv.table)) throw errUsage(`${argv.table} rows are parts of an update set; export the whole set with jsn updatesets export <name>.`);
            if (!argv.query?.trim()) throw errUsage('--query must be nonempty.');
            if (argv.limit !== undefined && (!Number.isSafeInteger(argv.limit) || argv.limit < 1)) throw errUsage('--limit must be a positive safe integer.');
            if (argv.out && fs.existsSync(argv.out)) throw errUsage(`${argv.out} already exists; export never overwrites a file.`);
            // A term the instance cannot apply is dropped, widening the export, so only a fully validated query runs.
            await assertWriteQuery(app, { table: argv.table, query: argv.query, refresh: argv['refresh-metadata'], action: 'Export' });
            const matched = await app.sdk.aggregateCount(argv.table, argv.query);
            const expected = Math.min(matched, argv.limit ?? matched);
            if (!Number.isSafeInteger(expected) || expected < 1) throw errUsage(`No ${argv.table} records match the query; nothing exported.`);
            const { cap, source } = await xmlExportCap(app.sdk);
            if (expected > cap) {
              throw errUsage(`${expected} ${argv.table} records match, but the instance exports at most ${cap} per file (${source}) and would drop the rest without saying so. Narrow --query, or pass --limit ${cap} or lower to export part of the set.`);
            }
            const { xml, records, tables } = await exportRecordsXML(app.sdk, { table: argv.table, query: argv.query, limit: argv.limit });
            if (records < expected) {
              throw errAPI(200, `The export holds ${records} ${argv.table} record(s) but ${expected} matched; the instance dropped some (an export cap, or rows the user cannot read). Nothing was written.`);
            }
            if (records > expected) {
              throw errAPI(200, `The export holds ${records} ${argv.table} record(s) but only ${expected} were expected; the instance applied a wider query or ignored the limit. Nothing was written.`);
            }
            const bytes = Buffer.byteLength(xml, 'utf-8');
            const data = { table: argv.table, query: argv.query, matched, records, tables, bytes };
            const summary = `Exported ${records}${records < matched ? ` of ${matched}` : ''} ${argv.table} record(s) as unload XML (${bytes} bytes)`;
            if (argv.out) {
              await fs.promises.writeFile(argv.out, xml, { flag: 'wx' });
              return app.ok({ ...data, out: argv.out }, { summary: `${summary} to ${argv.out}` });
            }
            // Raw XML pipes cleanly; only an explicit JSON request wraps it.
            if (argv.json || argv.format === 'json') return app.ok({ ...data, xml }, { summary });
            process.stdout.write(xml + (xml.endsWith('\n') ? '' : '\n'));
          }),
        })
        .command({
          command: 'import <file>',
          describe: 'Load an unload XML file (records export, or the UI\'s Export > XML); preview by default, re-read every record after',
          builder: (y) => y
            .positional('file', { type: 'string', describe: 'Unload XML file, or - for stdin' })
            .option('yes', { type: 'boolean', default: false, describe: 'Confirm the import (needs admin)' })
            .option('dry-run', { type: 'boolean', default: false, describe: 'Inspect the file locally, without instance requests, even with --yes' })
            .epilogue('Without --yes, reports what the file holds and sends nothing.\nImport writes straight to the tables the file names: it keeps sys_ids, overwrites a record with the same sys_id, deletes records marked action="DELETE", and skips business rules. The instance answers success even when it loads nothing, so every record is re-read afterwards and the command exits nonzero unless each one landed.'),
          handler: wrap(async (argv, app) => {
            const buffer = fs.readFileSync(argv.file === '-' ? 0 : argv.file);
            if (buffer.length > MAX_UNLOAD_BYTES) throw errUsage('Expected unload XML no larger than 50 MiB.');
            const xml = buffer.toString('utf8');
            const records = planUnloadImport(xml);
            const deletes = records.filter(record => record.action === 'DELETE').length;
            const data = { file: argv.file, bytes: buffer.length, records: records.length, tables: countByTable(records), deletes };
            const what = `${records.length} record(s) across ${Object.keys(data.tables).length} table(s), ${deletes} marked DELETE`;
            const rerun = buildRerunCommand(argv, { rerun: ['records', 'import', argv.file, '--yes'] });
            if (!argv.yes || argv['dry-run']) {
              return app.ok({ ...data, dry_run: true, rerun }, { summary: `Dry run: would import ${what}; nothing was sent`,
                breadcrumbs: [{ action: 'import', cmd: rerun, description: 'Import this file after your user approves it' }] });
            }
            app.requireInstance();
            const result = await importUnloadXML(app.sdk, xml, records);
            const verified = result.problems.length === 0;
            const counts = {};
            for (const { status } of result.problems) counts[status] = (counts[status] || 0) + 1;
            app.ok({ ...data, ...result, verified }, {
              summary: verified ? `Imported ${what}; a re-read finds each record present (gone, for DELETE) with the file's sys_updated_on and sys_mod_count where it has them`
                : `Import incomplete or unverified: ${result.landed} of ${records.length} record(s) landed; ${Object.entries(counts).map(([status, n]) => `${n} ${status.replace('_', ' ')}`).join(', ')}`,
            });
            if (!verified) process.exitCode = 1;
          }),
        })
        .command({
          command: 'inspect <table> <identifier>',
          aliases: ['debug', 'diag'],
          describe: 'Inspect a record: show audit history, business rules, and running flows',
          discoveryTasks: [{
            phrases: ['record history', 'audit history', 'record changes', 'show record history', 'who changed a record'],
            args: ['--json'], description: 'Inspect audit history for the specified table and record',
          }],
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident)', type: 'string' })
            .positional('identifier', { describe: 'Record sys_id or number', type: 'string' }),
          handler: wrap(async (argv, app) => {
            const { inspectRecord, formatInspectOutput } = await import('../records/inspect.js');
            const result = await inspectRecord(app, argv.table, argv.identifier);
            const breadcrumbs = [
              ...result.flows.map(f => ({
                action: 'show',
                cmd: `jsn flows show "${f.flow}"`,
                description: `View flow details for ${f.flow}`,
              })),
              ...result.businessRules.slice(0, 5).map(br => ({
                action: 'show',
                cmd: `jsn rules show "${br.name}"`,
                description: `View business rule: ${br.name}`,
              })),
            ];
            app.ok({ ...result, _formatted: formatInspectOutput(result) }, {
              summary: `Inspected ${argv.table} ${argv.identifier}`,
              breadcrumbs,
            });
          }),
        })
        .command({
          command: 'versions <table> <identifier>',
          describe: 'List a record\'s update versions and compare one to the current version (read-only)',
          discoveryTasks: [{
            phrases: ['version history', 'record versions', 'compare to current', 'which update set captured a record', 'show latest update'],
            args: ['--json'], description: 'List sys_update_version history and the latest captured update for one record',
          }],
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. sys_script_include)', type: 'string' })
            .positional('identifier', { describe: 'Record sys_id, or the value of --identifier-field', type: 'string' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id), e.g. name' })
            .option('limit', { type: 'number', default: 20, describe: 'Max versions, newest first (1-200)' })
            .option('diff', { type: 'number', describe: 'Compare version N (1 = newest) to the current version' })
            .epilogue('Versions come from sys_update_version by the record\'s sys_update_name; current means the version in state current, not the live record.\nExample: jsn records versions sys_script_include MyUtil --identifier-field name --diff 2'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const { recordVersions, formatVersions } = await import('../records/versions.js');
            const data = await recordVersions(app.sdk, { table: argv.table, identifier: argv.identifier, identifierField: argv.identifierField, limit: argv.limit, diff: argv.diff });
            Object.defineProperty(data, '_formatted', { value: formatVersions(data), enumerable: false });
            app.ok(data, { summary: `${data.count} version(s) of ${data.record.update_name}${data.diff ? `; version ${data.diff.version} vs current: ${data.diff.status}` : ''}` });
          }),
        })
        .command({
          command: 'journal <table> <identifier>',
          describe: 'Read a record\'s comments and work notes as entries (read-only)',
          discoveryTasks: [{
            phrases: ['work notes', 'record comments', 'what did the last work note say', 'journal entries', 'comment history'],
            args: ['--json'], description: 'List sys_journal_field entries for one record, newest first',
          }],
          builder: (y) => y
            .positional('table', { describe: 'Table name (e.g. incident)', type: 'string' })
            .positional('identifier', { describe: 'Record sys_id or number', type: 'string' })
            .option('identifier-field', { type: 'string', describe: 'Exact identifier field (default sys_id), e.g. number' })
            .option('comments', { type: 'boolean', describe: 'Only comments' })
            .option('work-notes', { type: 'boolean', describe: 'Only work notes' })
            .option('element', { type: 'string', describe: 'Only this journal element, e.g. approval_history' })
            .option('limit', { type: 'number', default: 20, describe: 'Max entries, newest first (1-200)' })
            .epilogue('Entries come from sys_journal_field by element_id, so entries the platform stored under another name (incident notes also appear under name=task) are included. Times are UTC as the Table API returns them, not the caller\'s time zone; the record\'s rendered comments/work_notes string cannot be queried.\nExample: jsn records journal incident INC0010001 --identifier-field number --work-notes --limit 5'),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const selected = [argv.comments, argv.workNotes, argv.element].filter(Boolean).length;
            if (selected > 1) throw errUsage('Choose one of --comments, --work-notes or --element.');
            const element = argv.element || (argv.comments ? 'comments' : argv.workNotes ? 'work_notes' : undefined);
            const { recordJournal, formatJournal } = await import('../records/journal.js');
            const data = await recordJournal(app.sdk, { table: argv.table, identifier: argv.identifier, identifierField: argv.identifierField, element, limit: argv.limit });
            Object.defineProperty(data, '_formatted', { value: formatJournal(data), enumerable: false });
            app.ok(data, { summary: `${data.count} journal entr${data.count === 1 ? 'y' : 'ies'} for ${argv.table} ${argv.identifier}` });
          }),
        })

    },
    // Parent discovery through the output controller: the subcommand list is
    // registry-derived (argv.subcommands), so `jsn records --json` returns a
    // structured envelope instead of prose, and the descriptions can no longer
    // describe a different surface than the registrations (the previous
    // hand-written list advertised `inspect` as table schema/statistics).
    handler: wrap(async (argv, app) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      const subcommands = argv.subcommands || [];
      const summary = 'Query and manage records in any ServiceNow table.';
      app.ok({
        command: 'records',
        subcommands,
        _formatted: formatCommandList({
          title: summary,
          commands: subcommands,
          footer: 'Run "jsn records <command> --help" for details.',
        }),
      }, { summary });
    }),
  };
}
