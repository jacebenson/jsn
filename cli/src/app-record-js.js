// Single-file records for record format v1 (issue #399).
//
// A `.js` record keeps the script and the metadata in one file:
//
//   var LaptopUtils = Class.create();
//   LaptopUtils.prototype.isStandard = function (model) {
//     return ['T14', 'X1'].indexOf(model) > -1;
//   };
//
//   export default {
//     sys_id: '22222222222222222222222222222222',
//     table: 'sys_script_include',
//     fields: { name: 'LaptopUtils' },
//     script: LaptopUtils,
//   };
//
// The script is everything above the `export default` statement, byte-for-byte,
// with exactly one trailing CRLF or LF removed. Nothing else is trimmed,
// rewritten or re-indented:
//
//   script = source.slice(0, start of "export")
//   if (script ends with "\r\n") drop those 2 characters
//   else if (script ends with "\n") drop that 1 character
//
// A code field's value is an identifier naming a declaration in this file
// (`script: LaptopUtils`) or a path string (resolved by app-project.js). The
// identifier is checked against the body's top-level declarations, so renaming
// the declaration without updating the metadata is an error.
//
// The default export must be the last statement. A trailing `;` is allowed
// (and is what the writer of the file normally leaves); comments and
// whitespace after it are allowed because they are not statements. Anything
// else after it is an error.
//
// The metadata is read without executing the script. Only the object literal
// after `export default` is evaluated, in an otherwise empty `node:vm` context
// with a short timeout, and the result must be a plain object holding only
// strings, numbers, booleans and plain objects. A function value is rejected.
// An identifier value is not data, so each identifier is bound in that context
// to a unique sentinel symbol and mapped back to a marker after evaluation.
// The script body is never evaluated, imported or `require`d — which is why a
// body may contain anything (comments, `//`, regexes, nested braces, strings
// containing `}`, even the words `export default`) without confusing
// extraction. Extraction uses a small lexer rather than a text search so those
// constructs are skipped the way a JavaScript parser skips them.

import { createContext, runInContext } from 'node:vm';

// Sticky: matched at an explicit lastIndex so no substring is built per token.
const IDENT = /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/uy;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;

// After these keywords a `/` starts a regular expression, not a division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw',
]);

const MAX_METADATA_DEPTH = 16;

function regexAllowed(previous) {
  if (!previous) return true;
  if (previous.type === 'punct') return ![')', ']', '}'].includes(previous.value);
  if (previous.type === 'ident') return REGEX_KEYWORDS.has(previous.value);
  // A number, string, template literal or regex is an operand: `/` divides.
  return false;
}

/** Skip a body, collecting nothing, and report the tokens a caller asked for. */
class SourceScanner {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.previous = null;
    this.error = null;
  }

  scan(sink) {
    this.code(false, sink);
    return this.error;
  }

  fail(message, at = this.index) {
    if (this.error) return;
    const line = this.source.slice(0, at).split(/\r\n|\r|\n/).length;
    this.error = `${message} (line ${line})`;
    this.index = this.source.length;
  }

  emit(token, sink) {
    this.previous = token;
    sink.push(token);
  }

  /**
   * Scan code until EOF, or — when `inTemplate` — until the `}` that closes
   * the surrounding `${ … }`. Tokens go to `sink` so a template expression's
   * tokens cannot be mistaken for top-level statements.
   */
  code(inTemplate, sink) {
    const source = this.source;
    let braces = 0;
    while (this.index < source.length && !this.error) {
      const start = this.index;
      const char = source[start];
      if (/\s/.test(char)) {
        this.index += 1;
        continue;
      }
      if (char === '/' && source[start + 1] === '/') {
        this.skipLineComment();
        continue;
      }
      if (char === '/' && source[start + 1] === '*') {
        this.skipBlockComment(start);
        continue;
      }
      if (char === '"' || char === "'") {
        this.skipString(char, start, sink);
        continue;
      }
      if (char === '`') {
        this.skipTemplate(start, sink);
        continue;
      }
      if (char === '/' && regexAllowed(this.previous)) {
        this.skipRegex(start, sink);
        continue;
      }
      IDENT.lastIndex = start;
      const ident = IDENT.exec(source);
      if (ident) {
        this.index = start + ident[0].length;
        this.emit({ type: 'ident', value: ident[0], start, end: this.index }, sink);
        continue;
      }
      NUMBER.lastIndex = start;
      const number = NUMBER.exec(source);
      if (number && number[0]) {
        this.index = start + number[0].length;
        this.emit({ type: 'number', value: number[0], start, end: this.index }, sink);
        continue;
      }
      if (char === '{') braces += 1;
      if (inTemplate && char === '}') {
        if (braces === 0) {
          this.index += 1;
          return; // the `}` belongs to the template, not to the code
        }
        braces -= 1;
      }
      this.index += 1;
      this.emit({ type: 'punct', value: char, start, end: this.index }, sink);
    }
    if (inTemplate && !this.error) this.fail('unterminated template expression');
  }

  skipLineComment() {
    const end = this.source.indexOf('\n', this.index);
    this.index = end === -1 ? this.source.length : end;
  }

  skipBlockComment(start) {
    const end = this.source.indexOf('*/', this.index + 2);
    if (end === -1) {
      this.fail('unterminated block comment', start);
      return;
    }
    this.index = end + 2;
  }

  skipString(quote, start, sink) {
    const source = this.source;
    this.index += 1;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === '\\') {
        this.index += 2;
        continue;
      }
      if (char === quote) {
        this.index += 1;
        this.emit({ type: 'string', start, end: this.index }, sink);
        return;
      }
      if (char === '\n' || char === '\r') break;
      this.index += 1;
    }
    this.fail('unterminated string literal', start);
  }

  skipTemplate(start, sink) {
    const source = this.source;
    this.index += 1;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === '\\') {
        this.index += 2;
        continue;
      }
      if (char === '`') {
        this.index += 1;
        this.emit({ type: 'template', start, end: this.index }, sink);
        return;
      }
      if (char === '$' && source[this.index + 1] === '{') {
        this.index += 2;
        this.previous = null; // the expression starts, so `/` is a regex here
        this.code(true, []);
        continue;
      }
      this.index += 1;
    }
    this.fail('unterminated template literal', start);
  }

  skipRegex(start, sink) {
    const source = this.source;
    this.index += 1;
    let inClass = false;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === '\\') {
        this.index += 2;
        continue;
      }
      if (char === '\n' || char === '\r') break;
      if (inClass) {
        if (char === ']') inClass = false;
      } else if (char === '[') {
        inClass = true;
      } else if (char === '/') {
        this.index += 1;
        while (this.index < source.length && /[a-z]/i.test(source[this.index])) this.index += 1;
        this.emit({ type: 'regex', start, end: this.index }, sink);
        return;
      }
      this.index += 1;
    }
    this.fail('unterminated regular expression', start);
  }
}

function tokensOf(source) {
  const tokens = [];
  const error = new SourceScanner(source).scan(tokens);
  return { tokens, error };
}

/** The index of the top-level `export default` keyword pair, or -1. */
function findDefaultExport(tokens) {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
      continue;
    }
    if (depth !== 0 || token.type !== 'ident' || token.value !== 'export') continue;
    const next = tokens[index + 1];
    if (next && next.type === 'ident' && next.value === 'default') return index;
  }
  return -1;
}

/** The token index of the `}` matching the `{` at `open`, or -1. */
function matchingBrace(tokens, open) {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punct') continue;
    if (token.value === '{' || token.value === '(' || token.value === '[') depth += 1;
    else if (token.value === '}' || token.value === ')' || token.value === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Cross-realm plain object: `{}` or `Object.create(null)`, never a Date/Map/array. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

// A metadata value written as a bare identifier names a declaration in the
// record file. It is not data, so it is bound to a unique symbol while the
// literal is evaluated and mapped back to one of these markers afterwards.
const SYMBOL_MARK = Symbol('jsn.recordSymbol');

/** True when `value` is the marker substituted for an identifier value. */
export function isRecordSymbol(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, SYMBOL_MARK);
}

/** The identifier a marker stands for, or null for any other value. */
export function recordSymbolName(value) {
  return isRecordSymbol(value) ? value[SYMBOL_MARK] : null;
}

function describeUnsupported(value, options = {}) {
  const at = options.at || 'the default export';
  const depth = options.depth || 0;
  const seen = options.seen || new Set();
  const symbols = options.symbols || null;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return null;
  if (type === 'number') return Number.isFinite(value) ? null : { at, kind: 'a non-finite number' };
  if (type === 'function') return { at, kind: 'a function' };
  // The sentinels bound for identifier values are not data either, but they
  // are expected: they are mapped back to markers right after this check.
  if (type === 'symbol') return symbols && symbols.has(value) ? null : { at, kind: 'a symbol' };
  if (type !== 'object') return { at, kind: `a ${type}` };
  if (isRecordSymbol(value)) return null;
  if (Array.isArray(value)) return { at, kind: 'an array' };
  if (!isPlainObject(value)) return { at, kind: 'a non-plain object' };
  if (depth >= MAX_METADATA_DEPTH) return { at, kind: 'an object nested too deeply' };
  if (seen.has(value)) return { at, kind: 'a circular reference' };
  seen.add(value);
  // Descriptors, not `Object.entries`: reading a getter would run metadata code
  // on this side of the vm boundary, where the timeout does not apply.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return { at, kind: 'a symbol key' };
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) {
      return { at: `${at}.${key}`, kind: 'an accessor property' };
    }
    const problem = describeUnsupported(descriptor.value, { at: `${at}.${key}`, depth: depth + 1, seen, symbols });
    if (problem) return problem;
  }
  seen.delete(value);
  return null;
}

// After these the identifier is a literal (or the context object itself), not
// a value that can name a declaration.
const LITERAL_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

/**
 * The identifiers used as values inside the metadata literal, in source order.
 *
 * Property keys (`{ script: … }`), member access (`a.b`) and the literal
 * keywords are not values, so they are skipped. Everything else is bound in
 * the metadata context: an identifier that reaches validation as a marker is
 * either a code field (the supported case) or an error.
 */
function literalIdentifiers(tokens, open, close) {
  const names = new Set();
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token.type !== 'ident' || LITERAL_KEYWORDS.has(token.value)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // `object.name` — the property name is not a free identifier.
    if (previous && previous.type === 'punct' && previous.value === '.') continue;
    // `{ name: value }` — a member name followed by its value.
    if (previous && previous.type === 'punct' && ['{', ',', '['].includes(previous.value)
      && next && next.type === 'punct' && next.value === ':') continue;
    names.add(token.value);
  }
  return names;
}

/** One unique sentinel symbol per identifier, used only inside the vm. */
function bindIdentifiers(names) {
  const bindings = new Map();
  for (const name of names) bindings.set(name, Symbol(`jsn.recordSymbol:${name}`));
  return bindings;
}

/** Replace every bound sentinel with the marker that validation understands. */
function substituteSymbols(value, symbols) {
  if (typeof value === 'symbol') return { [SYMBOL_MARK]: symbols.get(value) };
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    result[key] = substituteSymbols(descriptor.value, symbols);
  }
  return result;
}

/**
 * Evaluate the metadata literal in an otherwise empty context.
 *
 * The literal cannot call anything that reaches the host: the context holds no
 * `process`, `require`, `Buffer` or module loader, only the identifier
 * bindings. A timeout bounds a literal that tries to compute for a long time.
 */
function evaluateMetadata(literal, bindings) {
  const sandbox = Object.create(null);
  for (const [name, sentinel] of bindings) sandbox[name] = sentinel;
  try {
    return { ok: true, value: runInContext(`(${literal}\n)`, createContext(sandbox), {
      timeout: 1000,
      displayErrors: false,
    }) };
  } catch (error) {
    return { ok: false, error: `cannot read the default export: ${String(error && error.message).split('\n')[0]}` };
  }
}

const DECLARATION_KEYWORDS = new Set(['var', 'let', 'const', 'function', 'class']);

/**
 * Names declared at the top level of a script body, in source order.
 *
 * A code field that names a declaration (`script: LaptopUtils`) is only
 * meaningful when the body declares that exact name, so renaming the class and
 * forgetting the metadata breaks the build. The recognised forms are the
 * documented ones: `var`, `let`, `const`, `function` or `class` immediately
 * followed by the name, at brace/paren/bracket depth zero. Names declared
 * inside a function, block or class body are not top-level.
 */
export function topLevelDeclarations(source) {
  const { tokens, error } = tokensOf(source);
  if (error) return [];
  const names = [];
  const seen = new Set();
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
      continue;
    }
    if (depth !== 0 || token.type !== 'ident' || !DECLARATION_KEYWORDS.has(token.value)) continue;
    const name = tokens[index + 1];
    if (!name || name.type !== 'ident' || seen.has(name.value)) continue;
    seen.add(name.value);
    names.push(name.value);
  }
  return names;
}

/**
 * Extract the metadata and script body of a single-file `.js` record.
 *
 * @param {string} source — the record file's text, exactly as read
 * @returns {{ok: true, metadata: object, body: string, literal: string}
 *   | {ok: false, error: string}}
 */
export function extractRecordSource(source) {
  const { tokens, error } = tokensOf(source);
  if (error) return { ok: false, error: `invalid JavaScript: ${error}` };

  const found = findDefaultExport(tokens);
  if (found === -1) {
    return {
      ok: false,
      error: 'no default export found: the record metadata must be an '
        + '"export default { … }" statement at the end of the file',
    };
  }

  const open = tokens[found + 2];
  if (!open || open.type !== 'punct' || open.value !== '{') {
    return { ok: false, error: 'the default export must be an object literal ("export default { … }")' };
  }

  const close = matchingBrace(tokens, found + 2);
  if (close === -1) {
    return { ok: false, error: 'the default export object literal is not closed' };
  }

  const rest = tokens.slice(close + 1);
  const trailingSemicolonOnly = rest.length === 0
    || (rest.length === 1 && rest[0].type === 'punct' && rest[0].value === ';');
  if (!trailingSemicolonOnly) {
    return {
      ok: false,
      error: '"export default" must be the last statement in the file '
        + '(found more code after it)',
    };
  }

  const exportStart = tokens[found].start;
  let body = source.slice(0, exportStart);
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n')) body = body.slice(0, -1);

  const literal = source.slice(open.start, tokens[close].end);
  const bindings = bindIdentifiers(literalIdentifiers(tokens, found + 2, close));
  const evaluated = evaluateMetadata(literal, bindings);
  if (!evaluated.ok) return evaluated;
  if (!isPlainObject(evaluated.value)) {
    return { ok: false, error: 'the default export must be a plain object' };
  }
  const unsupported = describeUnsupported(evaluated.value, { symbols: new Set(bindings.values()) });
  if (unsupported) {
    return {
      ok: false,
      error: 'the default export may hold only strings, numbers, booleans and plain objects: '
        + `${unsupported.at} is ${unsupported.kind}`,
    };
  }

  const reverse = new Map([...bindings].map(([name, sentinel]) => [sentinel, name]));
  return { ok: true, metadata: substituteSymbols(evaluated.value, reverse), body, literal };
}
