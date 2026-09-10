import { parseArgs } from 'node:util';
import process from 'node:process';

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const names = (x) => typeof x === 'string' ? [x] : (x || []);
const commandName = (command) => command.trim().split(/\s+/)[0];
const positionSpec = (command) => [...command.matchAll(/([<[])([^>\]]+)[>\]]/g)].map((m) => ({ name: m[2], required: m[1] === '<' }));

class CommandNode {
  constructor(definition) {
    this.definition = typeof definition === 'string' ? { command: definition } : definition;
    this.name = commandName(this.definition.command || '');
    this.aliases = names(this.definition.aliases || this.definition.alias);
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

  api() {
    const node = this;
    return {
      command(definition, builder, handler) {
        node.children.push(new CommandNode(typeof definition === 'string' ? { command: definition, builder, handler } : definition));
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
  middleware(fn) { this.middlewares.push(...(Array.isArray(fn) ? fn : [fn])); return this; }
  option(name, config) { this.root.options.set(name, { ...config, name }); return this; }
  options(config) { for (const [name, value] of Object.entries(config)) this.option(name, value); return this; }
  command(definition, builder, handler) {
    const node = new CommandNode(typeof definition === 'string' ? { command: definition, builder, handler } : definition);
    this.root.children.push(node);
    return this;
  }
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
  _assign(argv, key, value, spec) {
    const actual = spec?.name || key;
    const values = spec?.type === 'array' ? (Array.isArray(value) ? value : [value]) : [value];
    if (spec?.choices && values.some((item) => !spec.choices.includes(item))) {
      this._fail(`Invalid value for --${actual}: ${value}. Choose from: ${spec.choices.join(', ')}`);
      return false;
    }
    if (spec?.type === 'number' && values.some((item) => item === '' || !Number.isFinite(Number(item)))) {
      this._fail(`Invalid number for --${actual}: ${value}`);
      return false;
    }
    const converted = spec?.type === 'boolean'
      ? (value === 'true' ? true : value === 'false' ? false : value)
      : spec?.type === 'number' ? Number(value) : value;
    if (spec?.type === 'array') argv[actual] = [...(argv[actual] || []), ...values];
    else argv[actual] = converted;
    argv[camel(actual)] = argv[actual];
    for (const alias of names(spec?.alias)) argv[alias] = argv[actual];
  }
  _parseOptions(args, path) {
    const options = this._optionConfig(path);
    const defs = {};
    for (const [key, spec] of options) defs[key] = {
      type: spec.type === 'number' || spec.type === 'array' ? 'string' : (spec.type || 'boolean'),
      multiple: spec.type === 'array',
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
      if (this._assign(argv, key, value, spec) === false) return null;
    }
    for (const [key, spec] of options) if (argv[spec.name] === undefined && spec.default !== undefined) this._assign(argv, key, spec.default, spec);
    return { values: argv, positionals: parsed.positionals };
  }
  _fail(message, error) {
    if (this.failHandler) return this.failHandler(message, error);
    throw error || new Error(message);
  }
  _help(node, path = []) {
    const lines = [node.usageText || `Usage: ${this.script} ${path.join(' ') || '<command>'}`];
    if (node.definition.describe) lines.push(`\n${node.definition.describe}`);
    if (node.children.length) lines.push('\nCommands:\n' + node.children.filter((n) => n.name !== this.completionCommand).map((n) => `  ${n.definition.command}  ${n.definition.describe || ''}`).join('\n'));
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
        const values = [...node.children].filter((n) => n.name !== this.completionCommand)
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
      && !this._lookup(node.children, firstWord)) {
      return this._fail(`Unknown command: ${firstWord}`);
    }
    if (!path.length && this.root.demand) return this._fail(this.root.demand.message);
    const parsed = this._parseOptions(commandArgs, path);
    if (!parsed) return;
    const argv = parsed.values;
    const specs = [...this._optionConfig(path).values()];
    const positions = positionSpec(node.definition.command || '').map((position) => ({
      ...position, ...node.positionals.get(position.name), name: position.name,
    }));
    parsed.positionals.forEach((value, i) => { if (positions[i]) argv[positions[i].name] = value; });
    for (const spec of specs) if (spec.demandOption && argv[spec.name] === undefined) return this._fail(`Missing required argument: --${spec.name}`);
    for (const pos of positions) if (pos.required && argv[pos.name] === undefined) return this._fail(`Missing required argument: ${pos.name}`);
    for (const middleware of this.middlewares) await middleware(argv);
    for (const commandNode of path) for (const middleware of commandNode.middlewares) await middleware(argv);
    if (node.definition.handler) await node.definition.handler(argv);
    else if (node.demand?.count && !path.length) return this._fail(node.demand.message);
  }
}

export function yargs(args = []) { return new LocalCLI(args); }
export function hideBin(argv) { return argv.slice(2); }
export default yargs;
