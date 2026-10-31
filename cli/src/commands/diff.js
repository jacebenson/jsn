import { declareCapabilities } from '../capabilities.js';
import { errUsage, errUsageHint } from '../errors.js';
import { resolveSession } from '../session.js';
import { resolveRecord } from '../resolve-record.js';

declareCapabilities('diff', {});

const DEFAULT_IGNORED_FIELDS = [
  'sys_created_by',
  'sys_created_on',
  'sys_mod_count',
  'sys_updated_by',
  'sys_updated_on',
];

function profileTarget(app, name, label) {
  const session = resolveSession({ profile: name }, app.config);
  if (session.unknownProfile || !session.profileName) {
    throw errUsageHint(`Unknown ${label} profile "${name}"`, 'Run "jsn auth status" to list configured profiles.');
  }
  if (!session.instance || !session.profile) {
    throw errUsage(`Profile "${name}" has no configured instance URL`);
  }
  return {
    name: session.profileName,
    instance: session.instance,
    profile: session.profile,
    username: session.username || '',
    domain: session.domain || '',
  };
}

function sdkForProfile(app, target) {
  return app.getSDKForProfile(target.instance, {
    profile: target.profile,
    profileName: target.name,
    username: target.username,
    authMethod: target.profile.auth_method,
    domain: target.domain,
  });
}

async function fetchRecord(app, target, table, identifier) {
  try {
    const record = await resolveRecord(sdkForProfile(app, target), {
      table,
      identifier,
      matchField: 'sys_id',
      resource: 'Record',
    });
    return { status: 'found', record };
  } catch (error) {
    if (error?.code === 'not_found') return { status: 'missing', record: null };
    if (error?.code === 'forbidden') return { status: 'forbidden', record: null, error: error.code };
    if (error?.code === 'auth_error') return { status: 'auth_error', record: null, error: error.code };
    return { status: 'error', record: null, error: error?.code || 'error' };
  }
}

function stableValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function equalValue(a, b) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function displayValue(value) {
  if (value && typeof value === 'object' && value.display_value != null) return String(value.display_value);
  if (value == null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fieldDifference(field, status, a, b) {
  return {
    field,
    status,
    ...(a !== undefined ? { a } : {}),
    ...(b !== undefined ? { b } : {}),
  };
}

export function compareRecords(recordA, recordB, ignoredFields = DEFAULT_IGNORED_FIELDS) {
  const ignored = new Set(ignoredFields);
  const fields = [...new Set([
    ...Object.keys(recordA || {}),
    ...Object.keys(recordB || {}),
  ])].filter(field => !ignored.has(field)).sort();
  const differences = [];
  for (const field of fields) {
    const hasA = Object.hasOwn(recordA || {}, field);
    const hasB = Object.hasOwn(recordB || {}, field);
    if (!hasA && hasB) differences.push(fieldDifference(field, 'added', undefined, recordB[field]));
    else if (hasA && !hasB) differences.push(fieldDifference(field, 'missing', recordA[field], undefined));
    else if (!equalValue(recordA[field], recordB[field])) differences.push(fieldDifference(field, 'changed', recordA[field], recordB[field]));
  }
  return differences;
}

export function formatRecordDiff(data) {
  const lines = [
    `Record diff: ${data.table} ${data.identifiers.a}`,
    `A: ${data.profiles.a.name} (${data.existence.a})`,
    `B: ${data.profiles.b.name} (${data.existence.b})`,
    `Status: ${data.status}`,
  ];
  if (data.status === 'error' || data.status === 'forbidden' || data.status === 'auth_error' || data.status === 'missing' || data.status === 'both_missing') return `${lines.join('\n')}\n`;
  lines.push(`Ignored: ${data.ignored_fields.join(', ') || '(none)'}`);
  if (data.differences.length === 0) lines.push('No field differences');
  for (const difference of data.differences) {
    const left = difference.a === undefined ? '(missing)' : displayValue(difference.a);
    const right = difference.b === undefined ? '(missing)' : displayValue(difference.b);
    lines.push(`${difference.status.toUpperCase()} ${difference.field}: ${left} -> ${right}`);
  }
  return `${lines.join('\n')}\n`;
}

function ignoredFields(argv) {
  if (argv['no-ignore']) return [];
  return [...new Set([...DEFAULT_IGNORED_FIELDS, ...(argv.ignore || [])])].sort();
}

export function diffCmd(wrap) {
  return {
    command: 'diff [subcommand]',
    describe: 'Compare records across configured profiles (read-only)',
    builder: (y) => y.command({
      command: 'record',
      describe: 'Compare one record across two profiles',
      builder: (b) => b
        .option('table', { type: 'string', demandOption: true, describe: 'ServiceNow table' })
        .option('sys-id', { type: 'string', demandOption: true, describe: 'Record sys_id or exact identifier' })
        .option('profile-a', { type: 'string', demandOption: true, describe: 'Profile for side A' })
        .option('profile-b', { type: 'string', demandOption: true, describe: 'Profile for side B' })
        .option('ignore', { type: 'string', array: true, default: [], describe: 'Additional field to ignore (repeatable)' })
        .option('no-ignore', { type: 'boolean', default: false, describe: 'Do not ignore system noise fields' }),
      handler: wrap(async (argv, app) => {
        const table = String(argv.table || '').trim();
        const identifier = String(argv['sys-id'] || '').trim();
        if (!table || !identifier) throw errUsage('diff record requires --table and --sys-id');
        if (argv['profile-a'] === argv['profile-b']) throw errUsage('Profile A and profile B must be different');
        const targetA = profileTarget(app, argv['profile-a'], 'profile-a');
        const targetB = profileTarget(app, argv['profile-b'], 'profile-b');
        const [sideA, sideB] = await Promise.all([
          fetchRecord(app, targetA, table, identifier),
          fetchRecord(app, targetB, table, identifier),
        ]);
        const ignored = ignoredFields(argv);
        let status = 'error';
        let differences = [];
        if (sideA.status === 'found' && sideB.status === 'found') {
          differences = compareRecords(sideA.record, sideB.record, ignored);
          status = differences.length ? 'different' : 'equal';
        } else if (sideA.status === 'missing' && sideB.status === 'missing') {
          status = 'both_missing';
        } else if (sideA.status === 'missing' || sideB.status === 'missing') {
          status = 'missing';
        } else if (sideA.status === 'forbidden' || sideB.status === 'forbidden') {
          status = 'forbidden';
        } else if (sideA.status === 'auth_error' || sideB.status === 'auth_error') {
          status = 'auth_error';
        }
        const data = {
          table,
          identifiers: { a: identifier, b: identifier },
          profiles: {
            a: { name: targetA.name, instance: targetA.instance },
            b: { name: targetB.name, instance: targetB.instance },
          },
          existence: { a: sideA.status, b: sideB.status },
          errors: { a: sideA.error || null, b: sideB.error || null },
          ignored_fields: ignored,
          status,
          differences,
          _formatted: formatRecordDiff({
            table,
            identifiers: { a: identifier },
            profiles: dataProfiles(targetA, targetB),
            existence: { a: sideA.status, b: sideB.status },
            ignored_fields: ignored,
            status,
            differences,
          }),
        };
        app.ok(data, { summary: `Record diff ${status}: ${table} ${identifier}` });
      }),
    }),
    handler: wrap(async (_argv, app) => {
      app.ok({ command: 'diff', subcommands: ['record'] }, { summary: 'Use `jsn diff record --help` for details.' });
    }),
  };
}

function dataProfiles(targetA, targetB) {
  return {
    a: { name: targetA.name, instance: targetA.instance },
    b: { name: targetB.name, instance: targetB.instance },
  };
}
