import { declareCapabilities } from '../capabilities.js';

declareCapabilities('discover', { noInstance: true, skipDailyChecks: true });

// The live registrations supply names, descriptions, aliases, actions, and
// factory configuration. No separate inventory of table commands lives here.
export function discoverCommands(registry, { query = '', table = '' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return registry.commands.filter(command => {
    const metadata = command.discovery;
    if (table && metadata?.table !== table) return false;
    const haystack = [command.name, ...command.aliases, command.description,
      metadata?.table, ...(metadata?.benefits || []),
      ...(command.actions || []).map(action => `${action.name} ${action.description}`)].join(' ').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export function discoverCmd(wrap, getRegistry) {
  return {
    command: 'discover [query]',
    describe: 'Find commands by words in their names, aliases, descriptions, or configured table',
    builder: y => y
      .positional('query', { type: 'string', describe: 'Search words (quote multiple words)' })
      .option('table', { type: 'string', describe: 'Find specialized commands configured for this exact table' })
      .epilogue([
        'Choose by intent:',
        '  Cross-table tasks: jsn records list --table task --query "active=true" --json',
        '  Custom tables: jsn records list --table x_example_record --limit 5 --json',
        '  Table-specific defaults and views: jsn discover --table incident',
        '  Rich request views (attachments and variables): jsn requests show --help',
        '  Raw endpoints when needed: jsn rest --help',
        'Generic records supports any accessible table; specialized commands provide configured defaults and table-specific behavior.',
        'Discovery matches registered text; try fewer words if there are no matches.',
        'Use --json for structured results or --json --get data.commands for only matches.',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      const commands = discoverCommands(getRegistry(), { query: argv.query, table: argv.table });
      const lines = commands.flatMap(command => [
        `${command.name}: ${command.description}`,
        ...(command.discovery ? [
          `  Table: ${command.discovery.table}; default columns: ${command.discovery.defaultColumns.join(', ')}`,
          ...command.discovery.benefits.map(benefit => `  ${benefit}`),
        ] : []),
        `  ${command.help}`,
        ...(command.actions || []).map(action => `  ${action.help} — ${action.description}`),
      ]);
      if (!commands.length) lines.push('No registered matches. Try fewer words or use generic records for any accessible table: jsn records list --help');
      app.ok({ commands, _formatted: lines.join('\n') }, {
        summary: `${commands.length} matching command(s). Use jsn discover --help for guidance by intent.`,
      });
    }),
  };
}
