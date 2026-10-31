import { parseArgs } from 'node:util';
import process from 'node:process';

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const names = (x) => typeof x === 'string' ? [x] : (x || []);

/**
 * A repeatable option may be declared either way: `type: 'array'` (this
 * adapter's historic spelling) or `array: true` (the yargs spelling most
 * contributors reach for). Both must accumulate; honoring only the first
 * silently kept the LAST value of `-f a=1 -f b=2` and dropped the rest.
 */
const isArrayOption = (spec) => spec?.type === 'array' || spec?.array === true;
const commandName = (command) => command.trim().split(/\s+/)[0];
const positionSpec = (command) => [...command.matchAll(/([<[])([^>\]]+)[>\]]/g)].map((m) => ({ name: m[2].replace(/\.\.$/, ''), array: m[2].endsWith('..'), required: m[1] === '<' }));

class CommandNode {
  constructor(definition) {
    this.definition = typeof definition === 'string' ? { command: definition } : definition;
    this.name = commandName(this.definition.command || '');
    // A command that lists its canonical name as its own alias publishes one
    // token twice: the registry then has two entries for it and dispatch can
    // resolve it through the alias table instead of the command table. An alias
    // is an ALTERNATE name, so a self-alias is dropped at the source.
    this.aliases = names(this.definition.aliases || this.definition.alias).filter((alias) => alias !== this.name);
    this.children = [];
    this.options = new Map();
    this.positionals = new Map();
    this.middlewares = [];
    this.built = false;
  }

  build() {
    if (this.built) return;
    this.built = true;
    if (typeof this.definition.builder === 'function') this.definition.builder(this.api());
  }

  /**
   * Register a child, replacing any existing registration that claims the same
   * canonical name (or that the new child claims as an alias).
   *
   * yargs semantics are last-registration-wins: a command module re-registers a
   * subcommand to layer a specialized handler over the base one (see
   * `requests show`). Appending instead of replacing left the base registration
   * first in the list and reachable by dispatch/help while the duplicate was
   * invisible to the registry (child counts, inventory, completion).
   *
   * Registration order is preserved (the slot is replaced in place) and the
   * replaced node's aliases are carried over so layered commands keep resolving
   * through the alias that the base registration published.
   *
   * A token must resolve to exactly ONE command. Two registrations can also
   * collide without sharing a canonical name: an alias that another command
   * already published (or already claims as its alias) is the same kind of
   * claim, and registration order decides it — the later registration owns the
   * token and the earlier one stops advertising it. The earlier command keeps
   * its canonical name, so nothing becomes unreachable.
   */
  register(child) {
    const index = this.children.findIndex((existing) => existing.name === child.name
      || existing.aliases.includes(child.name)
      || child.aliases.includes(existing.name));
    if (index === -1) {
      for (const sibling of this.children) {
        sibling.aliases = sibling.aliases.filter((alias) => !child.aliases.includes(alias));
      }
      this.children.push(child);
      return child;
    }
    // Carry the replaced node's aliases over — minus any alias that is now the
    // replacement's own canonical name, which would advertise the command as
    // its own alias.
    child.aliases = [...new Set([...child.aliases, ...this.children[index].aliases])]
      .filter((alias) => alias !== child.name);
    for (const sibling of this.children) {
      if (sibling === this.children[index]) continue;
      sibling.aliases = sibling.aliases.filter((alias) => !child.aliases.includes(alias));
    }
    this.children[index] = child;
    return child;
  }

  api() {
    const node = this;
    return {
      command(definition, builder, handler) {
        node.register(new CommandNode(typeof definition === 'string' ? { command: definition, builder, handler } : definition));
        return this;
      },
      option(name, config = {}) { node.options.set(name, { ...config, name }); return this; },
      options(config = {}) { for (const [name, value] of Object.entries(config)) this.option(name, value); return this; },
      positional(name, config = {}) { node.positionals.set(name, { ...config, name }); return this; },
      demandCommand(count, message) { node.demand = { count, message }; return this; },
      middleware(fn) { node.middlewares.push(...(Array.isArray(fn) ? fn : [fn])); return this; },
      strict() { return this; },
      check() { return this; },
      usage(value) { node.usageText = value; return this; },
      epilogue(value) { node.epilogueText = value; return this; },
      help() { return this; },
    };
  }
}

export class LocalCLI {
  constructor(args = []) {
    this.args = [...args];
    this.root = new CommandNode({ command: '' });
    this.root.build = () => {};
    this.root.api = this.root.api.bind(this.root);
    this.middlewares = [];
    this.failHandler = null;
    this.script = 'jsn';
    this.completionCommand = '__completion';
  }

  scriptName(value) { this.script = value; return this; }
  usage(value) { this.root.usageText = value; return this; }
  epilogue(value) { this.root.epilogueText = value; return this; }
  middleware(fn) { this.middlewares.push(...(Array.isArray(fn) ? fn : [fn])); return this; }
  option(name, config) { this.root.options.set(name, { ...config, name }); return this; }
  options(config) { for (const [name, value] of Object.entries(config)) this.option(name, value); return this; }
  command(definition, builder, handler) {
    this.root.register(new CommandNode(typeof definition === 'string' ? { command: definition, builder, handler } : definition));
    return this;
  }
  /**
   * Register the fallback used when a parent command (a node with children) is
   * invoked with no subcommand and declares no handler of its own. Without it
   * those parents exited 0 having printed nothing, which reads as success to a
   * script and as a hang to a human.
   */
  onParentDiscovery(fn) { this.parentDiscovery = fn; return this; }
  demandCommand(count, message) { this.root.demand = { count, message }; return this; }
  completion(name, _description, handler) { this.completionCommand = name; this.completionHandler = handler; return this; }
  help() { this.helpEnabled = true; return this; }
  version() { return this; }
  strictCommands() { this.strictCmd = true; return this; }
  strictOptions() { return this; }
  fail(fn) { this.failHandler = fn; return this; }
  getInternalMethods() {
    const all = this.root.children;
    return { getCommandInstance: () => ({
      getCommands: () => all.flatMap((n) => [n.name, ...n.aliases]),
      getCommandHandlers: () => Object.fromEntries(all.map((n) => [n.name, n.definition.handler])),
    }) };
  }
  showCompletionScript() {
    process.stdout.write(`###-begin-jsn-completions-###\n_jsn_yargs_completions() {\n  local completions=$(jsn --get-yargs-completions "$@")\n  COMPREPLY=( $(compgen -W "$completions" -- "\${COMP_WORDS[COMP_CWORD]}") )\n}\ncomplete -F _jsn_yargs_completions jsn\n###-end-jsn-completions-###\n`);
  }

  _lookup(list, value) { return list.find((n) => n.name === value || n.aliases.includes(value)); }
  _knownOptions(nodes) {
    const map = new Map();
    for (const node of [this.root, ...nodes]) for (const [name, spec] of node.options) {
      map.set(name, spec); for (const alias of names(spec.alias)) map.set(alias, spec);
    }
    return map;
  }
  _findPath(args) {
    const path = [], nodes = [this.root], consumed = new Set(), discoveryConsumed = new Set(); let i = 0;
    while (i < args.length) {
      const token = args[i];
      if (token === '--') break;
      if (token.startsWith('-')) {
        const key = token.replace(/^-+/, '').split('=')[0];
        const spec = this._knownOptions(path).get(key);
        if (!token.includes('=') && (!spec || spec.type !== 'boolean') && args[i + 1] && !args[i + 1].startsWith('-')) {
          discoveryConsumed.add(i + 1);
          i++;
        }
        discoveryConsumed.add(i);
        i++; continue;
      }
      const node = this._lookup(nodes[nodes.length - 1].children, token);
      if (!node) break;
      consumed.add(i);
      path.push(node); nodes.push(node); node.build(); i++;
    }
    return {
      path,
      commandArgs: args.filter((_, index) => !consumed.has(index)),
      discoveryConsumed: new Set([...consumed, ...discoveryConsumed]),
    };
  }
  _optionConfig(path) { return this._knownOptions(path); }
  _specFor(options, key, value) {
    return options.get(key) || [...options.values()].find((spec) => spec.name === key || names(spec.alias).includes(key))
      || { name: key, type: typeof value === 'boolean' ? 'boolean' : 'string' };
  }
  /**
   * Assign one parsed value to argv.
   *
   * `validate: false` (tolerant mode, used by parseGlobalOptions) skips the
   * choice/number checks so a value that will be thrown away anyway cannot
   * abort a parse whose only purpose is reading the global output flags.
   */
  _assign(argv, key, value, spec, opts = {}) {
    const validate = opts.validate !== false;
    const actual = spec?.name || key;
    const values = isArrayOption(spec) ? (Array.isArray(value) ? value : [value]) : [value];
    if (validate && spec?.choices && values.some((item) => !spec.choices.includes(item))) {
      this._fail(`Invalid value for --${actual}: ${value}. Choose from: ${spec.choices.join(', ')}`);
      return false;
    }
    if (validate && spec?.type === 'number' && values.some((item) => item === '' || !Number.isFinite(Number(item)))) {
      this._fail(`Invalid number for --${actual}: ${value}`);
      return false;
    }
    const converted = spec?.type === 'boolean'
      ? (value === 'true' ? true : value === 'false' ? false : value)
      : spec?.type === 'number' ? Number(value) : value;
    if (isArrayOption(spec)) argv[actual] = [...(argv[actual] || []), ...values];
    else argv[actual] = converted;
    argv[camel(actual)] = argv[actual];
    for (const alias of names(spec?.alias)) argv[alias] = argv[actual];
  }
  _parseOptions(args, path, opts = {}) {
    const options = this._optionConfig(path);
    const defs = {};
    for (const [key, spec] of options) defs[key] = {
      type: spec.type === 'number' || isArrayOption(spec) ? 'string' : (spec.type || 'boolean'),
      multiple: isArrayOption(spec),
    };
    args = args.map((arg) => {
      if (/^-[^-]=/.test(arg)) return `--${arg.slice(1)}`;
      if (!arg.startsWith('--no-')) return arg;
      const [key, rawValue] = arg.slice(5).split('=', 2);
      const spec = this._specFor(options, key);
      if (spec.type !== 'boolean') return arg;
      const value = rawValue === undefined ? 'false' : rawValue === 'false' ? 'true' : 'false';
      return `--${key}=${value}`;
    });
    for (const [key, spec] of options) for (const alias of names(spec.alias)) if (!defs[alias]) defs[alias] = defs[key];
    let parsed;
    try { parsed = parseArgs({ args, options: defs, allowPositionals: true, strict: false, tokens: true }); }
    catch (err) { this._fail(err.message, err); return { values: {}, positionals: [] }; }
    const argv = { _: path.map((n) => n.name) };
    for (const [key, value] of Object.entries(parsed.values)) {
      const spec = this._specFor(options, key, value);
      if (this._assign(argv, key, value, spec, opts) === false) return null;
    }
    for (const [key, spec] of options) if (argv[spec.name] === undefined && spec.default !== undefined) this._assign(argv, key, spec.default, spec, opts);
    return { values: argv, positionals: parsed.positionals };
  }

  /**
   * Resolve the global options from raw tokens WITHOUT dispatching a command and
   * without failing.
   *
   * The format middleware never runs when parsing fails, so the parse-time
   * failure renderer has to know the format the caller asked for. Rather than
   * re-scanning argv with a second, approximate tokenizer (any `--json`
   * anywhere, first `--format` wins, no option termination, no value
   * consumption, no `--no-` negation), it asks the SAME parser the successful
   * path uses. Tolerant mode keeps a value error (`--format xml`, the very
   * failure being rendered) from aborting the resolution.
   *
   * Returns null when the tokens cannot be parsed at all — the caller then
   * falls back to the pipe/TTY default, exactly as it did before.
   */
  parseGlobalOptions(args) {
    const saved = this.failHandler;
    this.failHandler = null; // errors here are not the failure being reported
    try {
      const { path, commandArgs } = this._findPath(args);
      const parsed = this._parseOptions(commandArgs, path, { validate: false });
      return parsed ? parsed.values : null;
    } catch {
      return null;
    } finally {
      this.failHandler = saved;
    }
  }
  _fail(message, error) {
    if (this.failHandler) return this.failHandler(message, error);
    throw error || new Error(message);
  }
  /**
   * Describe the registered command surface: root commands (canonical name,
   * aliases, describe, child names) and the global option declarations.
   *
   * This is the single source both the grouped root help and the machine
   * discovery output are generated from, so neither can drift away from the
   * commands that actually exist. Builders run here (idempotently) because a
   * parent's children are only registered when its builder is invoked.
   */
  commandRegistry() {
    const visible = (node) => node.name !== this.completionCommand && !node.definition.hidden;
    const serialize = (node) => {
      node.build();
      return {
        name: node.name,
        command: node.definition.command || node.name,
        aliases: [...node.aliases],
        description: node.definition.describe || '',
        subcommands: node.children.filter(visible).map((child) => child.name),
        discovery: node.definition.discovery || null,
        help: `jsn ${node.name} --help`,
        actions: node.children.filter(visible).map((child) => ({
          name: child.name,
          description: child.definition.describe || '',
          help: `jsn ${node.name} ${child.name} --help`,
        })),
      };
    };
    return {
      commands: this.root.children.filter(visible).map(serialize),
      options: [...this.root.options.values()].map((spec) => ({
        name: spec.name,
        alias: names(spec.alias),
        description: spec.description || spec.describe || '',
        choices: spec.choices || [],
        type: spec.type || 'boolean',
      })),
    };
  }

  /** Structured child signatures for a parent node, built on demand. */
  subcommandsOf(node) {
    return node.children
      .filter((child) => child.name !== this.completionCommand && !child.definition.hidden)
      .map((child) => {
        child.build();
        return {
          name: child.name,
          command: child.definition.command || child.name,
          aliases: [...child.aliases],
          description: child.definition.describe || '',
        };
      });
  }

  _help(node, path = []) {
    if (!path.length && this.rootHelpRenderer) {
      process.stdout.write(this.rootHelpRenderer() + "\n");
      return;
    }
    const lines = [node.usageText || `Usage: ${this.script} ${path.join(' ') || '<command>'}`];
    if (node.definition.describe) lines.push(`\n${node.definition.describe}`);
    const children = node.children.filter(n => n.name !== this.completionCommand && !n.definition.hidden);
    if (children.length) lines.push('\nCommands:\n' + children.map((n) => `  ${n.definition.command}  ${n.definition.describe || ''}`).join('\n'));
    if (node.options.size) lines.push('\nOptions:\n' + [...node.options].map(([name, s]) => `  --${name}${s.alias ? `, -${names(s.alias).join(', -')}` : ''}  ${s.describe || s.description || ''}`).join('\n'));
    if (node.epilogueText) lines.push(`\n${node.epilogueText}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  async parse() {
    if (this.args.includes('--get-yargs-completions')) {
      const prefix = this.args.at(-1) || '';
      let completionArgs = this.args.slice(this.args.indexOf('--get-yargs-completions') + 1, -1);
      if (completionArgs[0] === this.script) completionArgs = completionArgs.slice(1);
      const { path } = this._findPath(completionArgs);
      const node = path.at(-1) || this.root;
      node.build();
      const argv = { _: path.map((n) => n.name) };
      const completionFilter = (callback) => {
        const values = [...node.children].filter((n) => n.name !== this.completionCommand && !n.definition.hidden)
          .flatMap((n) => path.length ? [n.name] : [n.name, ...n.aliases]);
        const opts = [...this._optionConfig(path)].map(([name]) => `--${name}`);
        callback(null, [...new Set([...values, ...opts])]);
      };
      const finish = (values) => process.stdout.write([...new Set(values || [])]
        .filter((x) => x.startsWith(prefix) || prefix.startsWith('-') && x.startsWith(prefix)).join('\n') + '\n');
      if (this.completionHandler) {
        this.completionHandler(prefix, argv, completionFilter, finish);
      } else {
        completionFilter((err, values) => finish(values));
      }
      return;
    }
    if (this.args[0] === 'help') {
      const target = this._findPath(this.args.slice(1));
      if (this.args.length === 1 || target.path.length) {
        const node = target.path.at(-1) || this.root;
        node.build();
        this._help(node, target.path.map((n) => n.name));
        return;
      }
    }
    const { path, commandArgs, discoveryConsumed } = this._findPath(this.args);
    const node = path.at(-1) || this.root;
    node.build();
    if (commandArgs.includes('--help') || commandArgs.includes('-h')) { this._help(node, path.map((n) => n.name)); return; }
    const firstWord = this.args.find((arg, index) => !discoveryConsumed.has(index) && !arg.startsWith('-'));
    if (this.strictCmd && !path.length && firstWord && !this._lookup(this.root.children, firstWord)) {
      return this._fail(`Unknown command: ${firstWord}`);
    }
    if (this.strictCmd && path.length && node.children.length && firstWord
      && !node.definition.defaultPositionals && !this._lookup(node.children, firstWord)) {
      return this._fail(`Unknown command: ${firstWord}`);
    }
    if (!path.length && this.root.demand) return this._fail(this.root.demand.message);
    const parsed = this._parseOptions(commandArgs, path);
    if (!parsed) return;
    const argv = parsed.values;
    // A parent command's own children are registry-derived, so a default
    // handler can list exactly what is registered instead of repeating a
    // hand-written list that drifts (see the records parent, which advertised
    // an `inspect` description the registration disagreed with).
    if (node.children.length) argv.subcommands = this.subcommandsOf(node);
    const specs = [...this._optionConfig(path).values()];
    const positions = positionSpec(node.definition.command || '').map((position) => ({
      ...position, ...node.positionals.get(position.name), name: position.name,
    }));
    let positionalIndex = 0;
    for (const position of positions) {
      if (position.array) {
        const values = parsed.positionals.slice(positionalIndex);
        if (values.length) argv[position.name] = values;
        positionalIndex = parsed.positionals.length;
      } else if (parsed.positionals[positionalIndex] !== undefined) argv[position.name] = parsed.positionals[positionalIndex++];
    }
    for (const spec of specs) if (spec.demandOption && argv[spec.name] === undefined) return this._fail(`Missing required argument: --${spec.name}`);
    for (const pos of positions) if (pos.required && argv[pos.name] === undefined) return this._fail(`Missing required argument: ${pos.name}`);
    for (const middleware of this.middlewares) await middleware(argv);
    for (const commandNode of path) for (const middleware of commandNode.middlewares) await middleware(argv);
    if (node.definition.handler) await node.definition.handler(argv);
    // A parent with no handler of its own used to fall through and exit 0
    // with no output — indistinguishable from a command that ran and found
    // nothing. The registered discovery hook (cli.js) prints the child
    // surface instead: a JSON envelope in machine mode, a list for humans.
    else if (path.length && argv.subcommands?.length && this.parentDiscovery) {
      await this.parentDiscovery(argv, { path: path.map((n) => n.name), subcommands: argv.subcommands });
    } else if (node.demand?.count && !path.length) return this._fail(node.demand.message);
  }
}

export function yargs(args = []) { return new LocalCLI(args); }
export function hideBin(argv) { return argv.slice(2); }
export default yargs;
