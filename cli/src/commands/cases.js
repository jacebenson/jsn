// End-user case views: list/show/search over the case table the account can
// actually read. Which "case" a person means depends on the installed
// application, so the table is detected (or named explicitly) instead of
// assuming one product's schema. Reads only — every request goes through the
// normal authenticated Table API, so application roles and ACLs decide
// visibility; nothing here widens or bypasses them.
import { AppError, CodeForbidden, errUsage, errUsageHint } from '../errors.js';
import { buildQuerySuffix, formatCommandList, formatRecordForDisplay, getStringField, quoteShellArg, resolveFieldsParam } from '../helpers.js';
import { getRecord, listRecords, recordListParams } from '../records-engine.js';
import { declareCapabilities } from '../capabilities.js';

declareCapabilities('cases', {}); // read-only: no mutating subcommands

const TABLE = /^[a-z][a-z0-9_]*$/i;
const DEFAULT_COLUMNS = ['number', 'short_description', 'state', 'opened_by', 'sys_updated_on'];

// Detection order is presentation policy, not an access claim: each candidate
// is probed with the caller's own credentials.
const CASE_SOURCES = [
  { table: 'sn_customerservice_case', application: 'Customer Service Management', label: 'customer service case' },
  { table: 'sn_hr_core_case', application: 'HR Service Delivery', label: 'HR case' },
];

function sourceFor(table) { return CASE_SOURCES.find(source => source.table === table); }
function requireTableName(table) {
  if (!TABLE.test(table || '')) throw errUsage('--table takes a table name such as sn_customerservice_case or sn_hr_core_case.');
  return table;
}

/** Turn one failed case read into an honest error class. */
function caseReadError(table, error) {
  const status = error?.status;
  if (status === 401) return error; // already normalized by errAPI
  if (status === 403) {
    return new AppError(CodeForbidden, `Access to ${table} is denied for this account (HTTP 403).`,
      'Case visibility follows the application roles and ACLs. Ask an administrator for access, or use a profile that has it.', 403);
  }
  if (status === 400 || status === 404) {
    return new AppError('api_error', `Reading ${table} failed (HTTP ${status}).`,
      'The case application may not be installed, or the query uses a field this table does not have. Try jsn cases tables, then --table with a supported table.', status);
  }
  return error;
}

/** One read-only availability probe. Authentication failures are not a table fact. */
async function probe(app, table) {
  const params = new URLSearchParams({ sysparm_limit: '1', sysparm_fields: 'sys_id', sysparm_display_value: 'false' });
  try {
    await app.sdk.list(table, params);
    return { available: true };
  } catch (error) {
    if (error?.status === 401) throw error;
    if (error?.status === 403) return { available: false, reason: 'denied (HTTP 403)', status: 403 };
    if (error?.status === 400 || error?.status === 404) return { available: false, reason: `not installed (HTTP ${error.status})`, status: error.status };
    throw error;
  }
}

/**
 * Pick the case table to read: --hr and --table are explicit, otherwise probe
 * the known case applications in order and use the first readable one.
 */
async function resolveTable(app, argv) {
  const explicit = argv.hr ? 'sn_hr_core_case' : argv.table === undefined ? undefined : requireTableName(argv.table);
  if (argv.hr && argv.table !== undefined && argv.table !== 'sn_hr_core_case') throw errUsage('Choose --hr or --table, not both.');
  if (explicit) {
    const source = sourceFor(explicit);
    return { table: explicit, application: source?.application ?? null, label: source?.label ?? 'case', source: 'explicit' };
  }
  const attempts = [];
  for (const source of CASE_SOURCES) {
    const probeResult = await probe(app, source.table);
    attempts.push({ ...source, ...probeResult });
    if (probeResult.available) return { ...source, source: 'detected', attempts };
  }
  const summary = attempts.map(a => `${a.table} ${a.reason}`).join('; ');
  if (attempts.some(a => a.status === 403)) {
    throw new AppError(CodeForbidden, `No readable case table for this account: ${summary}.`,
      'Case visibility follows the application roles and ACLs. Ask an administrator for case access, or use a profile that has it.', 403);
  }
  throw errUsageHint(
    `No readable case table on this instance: ${summary}.`,
    'Install a case application (Customer Service Management or HR Service Delivery) and use an account with case access, or name a table explicitly with --table.',
  );
}

async function listCases(app, argv, resolved, query) {
  const columns = argv.columns ? argv.columns.split(',') : DEFAULT_COLUMNS;
  const fields = resolveFieldsParam(columns);
  const ordered = query ? `${query}^ORDERBYDESCsys_updated_on` : 'ORDERBYDESCsys_updated_on';
  const params = recordListParams({ limit: argv.limit, offset: argv.offset, fields, query: ordered });
  let records;
  try {
    records = await listRecords(app.sdk, { table: resolved.table, params, displayValues: argv.displayValues });
  } catch (error) {
    throw caseReadError(resolved.table, error);
  }
  const displayRecords = fields && !argv.displayValues ? records.map(r => formatRecordForDisplay(r, columns)) : records;
  const breadcrumbs = [
    { action: 'search', cmd: `jsn cases search "<text>"${argv.hr ? ' --hr' : ''}`, description: 'Search cases' },
  ];
  if (records.length === argv.limit) {
    breadcrumbs.push({ action: 'next', cmd: `jsn cases list --limit ${argv.limit} --offset ${argv.offset + argv.limit}${buildQuerySuffix(argv.query)}`, description: 'Next page' });
  }
  if (argv.offset > 0) {
    breadcrumbs.push({ action: 'prev', cmd: `jsn cases list --limit ${argv.limit} --offset ${Math.max(0, argv.offset - argv.limit)}${buildQuerySuffix(argv.query)}`, description: 'Previous page' });
  }
  app.ok({
    table: resolved.table,
    application: resolved.application,
    table_source: resolved.source,
    count: records.length,
    columns,
    records: displayRecords,
    pagination: { limit: argv.limit, offset: argv.offset },
    context: { instance_url: app.getEffectiveInstance() },
  }, { summary: `${records.length} ${resolved.table}(s)`, breadcrumbs });
}

function listOptions(y) {
  return y
    .option('table', { type: 'string', describe: 'Case table to read (default: detected from installed case applications)' })
    .option('hr', { type: 'boolean', default: false, describe: 'Read the HR case table (sn_hr_core_case)' })
    .option('query', { type: 'string', describe: 'Encoded query (e.g. "active=true")' })
    .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
    .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' })
    .option('offset', { alias: 'o', type: 'number', default: 0, describe: 'Offset' })
    .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' });
}

function showOptions(y) {
  return y
    .option('table', { type: 'string', describe: 'Case table to read (default: detected from installed case applications)' })
    .option('hr', { type: 'boolean', default: false, describe: 'Read the HR case table (sn_hr_core_case)' })
    .option('display-values', { type: 'string', choices: ['raw', 'display', 'both'], describe: 'Reference values: raw, display or both' });
}

function requireText(text) {
  if (typeof text !== 'string' || !text.trim()) throw errUsage('Provide nonempty search text.');
  if (text.includes('^')) throw errUsage('Search text cannot contain ^ (it separates encoded-query terms).');
  return text.trim();
}

export function casesCmd(wrap) {
  return {
    command: 'cases [subcommand]',
    aliases: ['case'],
    describe: 'List, show or search service and HR cases visible to the connected account',
    builder: (yargs) => yargs
      .command({
        command: 'list',
        aliases: ['ls'],
        describe: 'List cases the connected account can read',
        builder: listOptions,
        handler: wrap(async (argv, app) => {
          const resolved = await resolveTable(app, argv);
          await listCases(app, argv, resolved, argv.query || '');
        }),
      })
      .command({
        command: 'search <text>',
        describe: 'Search case number and short description',
        builder: y => listOptions(y).positional('text', { type: 'string' }),
        handler: wrap(async (argv, app) => {
          const text = requireText(argv.text);
          const resolved = await resolveTable(app, argv);
          await listCases(app, argv, resolved, `numberLIKE${text}^ORshort_descriptionLIKE${text}`);
        }),
      })
      .command({
        command: 'show <number>',
        aliases: ['get'],
        describe: 'Show one case by number',
        builder: showOptions,
        handler: wrap(async (argv, app) => {
          const resolved = await resolveTable(app, argv);
          let record;
          try {
            record = await getRecord(app.sdk, { table: resolved.table, identifier: argv.number, matchField: 'number', displayValues: argv.displayValues, resource: resolved.label });
          } catch (error) {
            throw caseReadError(resolved.table, error);
          }
          record._context = { instance_url: app.getEffectiveInstance(), table: resolved.table };
          app.ok(record, {
            summary: `${resolved.label.charAt(0).toUpperCase() + resolved.label.slice(1)} ${getStringField(record, 'number') || argv.number}`,
            breadcrumbs: [
              { action: 'list', cmd: `jsn cases list${argv.hr ? ' --hr' : argv.table ? ` --table ${quoteShellArg(argv.table)}` : ''}`, description: 'Back to cases' },
            ],
          });
        }),
      })
      .command({
        command: 'tables',
        describe: 'Report which case applications this instance exposes to the account',
        handler: wrap(async (argv, app) => {
          const sources = [];
          for (const source of CASE_SOURCES) {
            const probeResult = await probe(app, source.table);
            sources.push({ ...source, ...probeResult });
          }
          app.ok({ sources, available: sources.filter(s => s.available).map(s => s.table) },
            { summary: sources.filter(s => s.available).length ? `Case tables: ${sources.filter(s => s.available).map(s => s.table).join(', ')}` : 'No readable case table found',
              breadcrumbs: [{ action: 'list', cmd: 'jsn cases list', description: 'List cases' }] });
        }),
      })
      .epilogue([
        'Default table: the first readable case application (Customer Service Management, then HR Service Delivery).',
        'Use --hr for sn_hr_core_case or --table <name> for any case table you can read; jsn cases tables reports each one.',
        'Reads use the caller\'s own credentials and ACLs. Self-service scoping is a query, not a bypass, and field names differ per application:',
        '  jsn cases list --query "opened_by=javascript:gs.getUserID()" --hr',
        'Nothing here changes a case; use the application UI or records update for case work.',
      ].join('\n')),
    handler: wrap(async (argv, app) => app.ok({ subcommands: argv.subcommands || [],
      _formatted: formatCommandList({ title: 'Cases', commands: argv.subcommands || [] }) },
    { summary: 'Cases: list, show and search service or HR cases visible to the connected account',
      breadcrumbs: [{ action: 'list', cmd: 'jsn cases list' + (argv.profile ? ` --profile ${quoteShellArg(argv.profile)}` : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : ''), description: 'List visible cases' }] })),
  };
}
