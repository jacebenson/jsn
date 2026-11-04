// `tables behavior` — extends the existing tables command surface with a
// read-only configuration inventory. See docs/DECISIONS.md.

import { discoverTableBehavior, formatTableBehavior } from '../table-behavior.js';
import { errUsage } from '../errors.js';
import { FormatAuto, FormatStyled } from '../output.js';

function decodeCursorTokens(tokens = []) {
  const cursors = {};
  for (const token of tokens) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    } catch {
      throw errUsage('Invalid cursor token.');
    }
    if (!parsed || typeof parsed.c !== 'string') throw errUsage('Invalid cursor token.');
    cursors[parsed.c] = token;
  }
  return cursors;
}

export function withTableBehavior(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'behavior <table>',
    aliases: ['behaviour'],
    describe: 'Read-only inventory of business rules, client scripts, UI actions and policies for a table (inherited included)',
    builder: (y) => y
      .positional('table', { type: 'string', describe: 'Table name (e.g. incident)' })
      .option('category', {
        alias: ['categories'], type: 'string', array: true,
        describe: 'Limit categories (comma-separated or repeatable): business_rules, client_scripts, ui_actions, ui_policies, data_policies',
      })
      .option('direct-only', { type: 'boolean', default: false, describe: 'Only configuration associated with this exact table; no ancestors or global actions' })
      .option('include-inactive', { type: 'boolean', default: false, describe: 'Include inactive configuration (active-only by default)' })
      .option('name', { type: 'string', describe: 'Filter artifact names with a LIKE match (no encoded-query characters)' })
      .option('limit', { alias: 'l', type: 'number', default: 200, describe: 'Maximum items per category (1-200)' })
      .option('max-bytes', { type: 'number', default: 524288, describe: 'Response size budget in bytes (4096-1048576); oversized pages are omitted whole' })
      .option('cursor', { type: 'string', array: true, describe: 'Continuation token from a category next_cursor; repeatable' })
      .epilogue([
        'Read-only: this inventories configuration with GET requests and never executes scripts or evaluates conditions.',
        'Client requirements (client scripts, UI actions, UI policies) are reported separately from server enforcement (business rules, data policies).',
        'Empty categories describe accessible configuration only; unavailable/unsupported categories are reported separately.',
        'Known artifacts stay directly retrievable: jsn records get --table <source_table> --sys-id <reference.sys_id> --json',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = await discoverTableBehavior(app.sdk, argv.table, {
        categories: argv.category,
        directOnly: argv.directOnly === true,
        includeInactive: argv.includeInactive === true,
        name: argv.name,
        limit: argv.limit,
        maxBytes: argv.maxBytes,
        cursors: decodeCursorTokens(argv.cursor),
      });
      const breadcrumbs = [
        ...data.categories
          .flatMap(section => section.items.slice(0, 1).map(item => ({
            action: 'show',
            cmd: `jsn records get --table ${item.reference.source_table} --sys-id ${item.reference.sys_id} --json`,
            description: `Retrieve ${item.reference.kind} record for ${item.name}`,
          }))),
        { action: 'list', cmd: `jsn tables show ${data.table}`, description: `Show table ${data.table}` },
      ];
      const human = [FormatAuto, FormatStyled].includes(app.output.getFormat());
      app.ok(human ? { ...data, _formatted: formatTableBehavior(data) } : data, {
        summary: `Table behavior: ${data.table} \u2014 ${data.totals.returned} item(s), ${data.totals.direct} direct, ${data.totals.inherited} inherited`,
        breadcrumbs,
      });
    }),
  });
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Table behavior inventory: jsn tables behavior <table> [--direct-only] [--include-inactive]');
  }
  return command;
}
