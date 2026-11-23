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

const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim();
const filler = new Set(['a', 'an', 'the', 'my', 'is', 'are', 'what', 'which', 'show', 'me', 'please', 'for', 'of', 'to']);
const quote = value => /^[a-zA-Z0-9_./:<>=-]+$/.test(value) && !value.includes('=<') ? value : `'${value.replaceAll("'", "'\\''")}'`;

// Task/example args are argv tokens owned by that action, never shell code.
// Fill only parser-declared required inputs, and reject stale/hidden flags.
function invocationArgs(entry, suffix) {
  if (entry.parent) return suffix.length ? null : [...entry.path, '--help'];
  if (entry.hiddenRequired) return null;
  const options = new Map(entry.options.flatMap(spec => [spec.token || spec.name, ...(Array.isArray(spec.alias) ? spec.alias : spec.alias ? [spec.alias] : [])].map(name => [name, spec])));
  const positional = [], flags = [], supplied = new Set();
  for (let i = 0; i < suffix.length; i++) {
    const token = suffix[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    // Long options require --; the parser treats -mode as short bundles.
    if (!token.startsWith('--') && !/^-[^-](?:=|$)/.test(token)) return null;
    const name = token.replace(/^-+/, '').split('=')[0];
    const spec = options.get(name) || (name.startsWith('no-') && options.get(name.slice(3))?.type === 'boolean' ? options.get(name.slice(3)) : null);
    if (!spec) return null;
    supplied.add(spec.name);
    flags.push(token);
    let value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
    if (spec.type && spec.type !== 'boolean' && value === undefined) {
      value = suffix[++i];
      if (value === undefined || value.startsWith('--')) return null;
      flags.push(value);
    }
    if (value !== undefined && !value.includes('<')) {
      if (spec.choices && !spec.choices.includes(value)) return null;
      if (spec.type === 'number' && (value === '' || !Number.isFinite(Number(value)))) return null;
      if (spec.type === 'boolean' && !['true', 'false'].includes(value)) return null;
    }
  }
  for (const position of entry.positions.slice(positional.length)) {
    if (position.required) positional.push(`<${position.name}>`);
  }
  for (const spec of entry.options) {
    if (spec.demandOption && !supplied.has(spec.name)) {
      flags.push(`--${spec.token || spec.name}`);
      if (spec.type !== 'boolean') flags.push(`<${spec.name}>`);
    }
  }
  return [...entry.path, ...positional, ...flags];
}

export function rankedDiscoveries(registry, { query = '', table = '', limit = 5 } = {}) {
  const normalized = normalize(query);
  const words = normalized.split(' ').filter(word => word && !filler.has(word));
  const matches = text => words.length > 0 && words.every(word => normalize(text).includes(word));
  const candidates = [];
  for (const entry of registry.entries || []) {
    if (table && entry.table !== table) continue;
    const add = (score, suffix, description, match) => {
      const args = invocationArgs(entry, suffix);
      if (!args) return;
      const invocation = `jsn ${args.map(quote).join(' ')}`;
      candidates.push({ score, invocation, args, description, help: entry.help, match,
        required: [...new Set(args.flatMap(arg => arg.match(/<[^>]+>/g) || []))],
      });
    };
    if (!normalized) {
      if (entry.path.length === 1) add(1, [], entry.description, 'group');
      continue;
    }
    for (const task of entry.tasks) {
      const exact = task.phrases.some(phrase => normalize(phrase) === normalized);
      if (!task.hidden && (exact || task.phrases.some(matches))) add(exact ? 400 : 350, task.args || [], task.description, 'task');
    }
    for (const example of entry.examples) {
      if (!example.hidden && matches(`${example.description} ${(example.args || []).join(' ')}`)) {
        add(275, example.args || [], example.description, 'example');
      }
    }
    if (!entry.parent) for (const option of entry.options) {
      if (matches(`${option.name} ${[].concat(option.alias || []).join(' ')} ${option.describe || option.description || ''}`)) {
        add(250, [`--${option.token || option.name}`, ...(option.type && option.type !== 'boolean' ? [`<${option.name}>`] : [])],
          option.describe || option.description || entry.description, 'option');
      }
    }
    if (matches(`${entry.path.join(' ')} ${entry.aliases.join(' ')} ${entry.description}`)) {
      add(entry.parent ? 100 : 200, [], entry.description, entry.parent ? 'group' : 'action');
    } else if (matches(`${entry.group} ${entry.table}`)) add(50, [], entry.description, 'group');
  }
  candidates.sort((a, b) => b.score - a.score || (a.invocation < b.invocation ? -1 : a.invocation > b.invocation ? 1 : 0));
  const seen = new Set();
  return candidates.filter(result => !seen.has(result.invocation) && seen.add(result.invocation))
    .slice(0, limit).map(({ score: _score, ...result }) => result);
}

export function discoverCmd(wrap, getRegistry) {
  return {
    command: 'discover [query]',
    describe: 'Find commands by words in their names, aliases, descriptions, or configured table',
    summary: 'Find commands by task word or table',
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
        'Ranked suggestions use local task phrases, action/option help and registered examples; exact task phrases rank first, with stable ties and at most 5 results.',
        'Suggestions never run commands. Replace every <placeholder> before use; discovery does not infer record IDs or authorize writes.',
        'Compatibility: data.commands retains legacy unranked group matching unchanged. Additive data.results contains ranked action suggestions.',
        'Use --json --get data.results for ranked suggestions, or --json --get data.commands for legacy matches.',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      const registry = getRegistry(argv);
      const search = { query: argv.query, table: argv.table };
      const commands = discoverCommands(registry, search);
      const results = rankedDiscoveries(registry, search);
      const lines = results.flatMap(result => [
        result.invocation,
        `  ${result.description}`,
        `  Help: ${result.help}${result.required.length ? `; required: ${result.required.join(', ')}` : ''}`,
      ]);
      // Exact-table discovery keeps its existing configured-view details.
      if (argv.table) lines.push(...commands.flatMap(command => [
        `${command.name}: ${command.description}`,
        ...(command.discovery ? [
          `  Table: ${command.discovery.table}; default columns: ${command.discovery.defaultColumns.join(', ')}`,
          ...command.discovery.benefits.map(benefit => `  ${benefit}`),
        ] : []),
        `  ${command.help}`,
        ...(command.actions || []).map(action => `  ${action.help} — ${action.description}`),
      ]));
      if (!lines.length) lines.push('No registered matches. Try fewer words or use generic records for any accessible table: jsn records list --help');
      app.ok({ commands, results, _formatted: lines.join('\n') }, {
        summary: `${results.length} ranked suggestion(s); ${commands.length} legacy matching command(s). Use jsn discover --help for guidance by intent.`,
      });
    }),
  };
}
