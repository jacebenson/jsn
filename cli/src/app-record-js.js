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
// After these a `(` opens a statement condition, so the matching `)` allows a
// regular expression to follow: `if (x) /re/.test(y)`.
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
// `of` is not here: it is an identifier outside a `for (… of …)` header, and
// `const of = 8; of / 2` divides. The scanner marks the token instead.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw',
]);


function regexAllowed(previous) {
  if (!previous) return true;
  if (previous.type === 'punct') {
    // `)` closing an `if`/`while`/`for`/... condition is followed by a statement,
    // not by an operand: `if (x) /re/.test(y)` starts a regular expression.
    if (previous.value === ')' && previous.control === true) return true;
    // An update (`i++`, `--i`) always leaves an operand behind it, so a `/`
    // that follows one divides: `i++ / 2`.
    if (previous.value === '++' || previous.value === '--') return false;
    return ![')', ']', '}'].includes(previous.value);
  }
  if (previous.type === 'ident') {
    // `of` starts a regular expression only as the operator of a for…of header.
    if (previous.value === 'of') return previous.forOf === true;
    return REGEX_KEYWORDS.has(previous.value);
  }
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
    // Whether a line terminator was passed since the last token: automatic
    // semicolon insertion needs to know where a statement ended.
    this.lineBreak = false;
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
    token.newlineBefore = this.lineBreak === true;
    this.lineBreak = false;
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
    // What each open `(` belongs to: null, or the control keyword whose
    // condition it opens (`for (… of …)` needs the difference).
    const parens = [];
    let pendingControl = null;
    while (this.index < source.length && !this.error) {
      const start = this.index;
      const char = source[start];
      if (/\s/.test(char)) {
        if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') this.lineBreak = true;
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
        // `obj.if()` names a property, not a control statement: the `(` after it
        // is a call, so a `/` following the `)` divides rather than starting a
        // regular expression. Read the previous token before this one replaces it.
        const property = this.previous !== null && this.previous.type === 'punct' && this.previous.value === '.';
        this.index = start + ident[0].length;
        const token = { type: 'ident', value: ident[0], start, end: this.index };
        // `of` is a keyword only as the operator of a `for (… of …)` header, so
        // only there may a `/` after it start a regular expression.
        if (ident[0] === 'of' && parens.length > 0 && parens[parens.length - 1] === 'for') token.forOf = true;
        pendingControl = !property && CONTROL_KEYWORDS.has(ident[0]) ? ident[0] : null;
        this.emit(token, sink);
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
      // `++` and `--` are one token: `i++ / 2` divides, and two single `+`
      // characters would leave the `/` looking like the start of a regex.
      if ((char === '+' || char === '-') && source[start + 1] === char) {
        this.index = start + 2;
        pendingControl = null;
        this.emit({ type: 'punct', value: char + char, start, end: this.index }, sink);
        continue;
      }
      this.index += 1;
      const token = { type: 'punct', value: char, start, end: this.index };
      if (char === '(') {
        parens.push(pendingControl);
        pendingControl = null;
      } else if (char === ')') {
        token.control = Boolean(parens.pop());
      } else if (!/^\s$/.test(char)) {
        pendingControl = null;
      }
      this.emit(token, sink);
    }
    if (inTemplate && !this.error) this.fail('unterminated template expression');
  }

  skipLineComment() {
    // A `//` comment ends at any JavaScript line terminator, not just LF:
    // CR, U+2028 and U+2029 end one too, and searching for LF would swallow
    // the `export default` below a comment ending with one of them.
    const source = this.source;
    let end = this.index;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r'
      && source[end] !== '\u2028' && source[end] !== '\u2029') end += 1;
    this.index = end;
  }

  skipBlockComment(start) {
    const end = this.source.indexOf('*/', this.index + 2);
    if (end === -1) {
      this.fail('unterminated block comment', start);
      return;
    }
    // A comment spanning lines leaves a line break behind it for ASI purposes.
    if (/[\r\n\u2028\u2029]/.test(this.source.slice(this.index, end + 2))) this.lineBreak = true;
    this.index = end + 2;
  }

  skipString(quote, start, sink) {
    const source = this.source;
    this.index += 1;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === '\\') {
        // A backslash before CRLF is one line continuation: skip both newline
        // characters, or the LF is left behind and rejected as an unescaped
        // line break in a string.
        this.index += source[this.index + 1] === '\r' && source[this.index + 2] === '\n' ? 3 : 2;
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
// A metadata value written as a bare identifier names a declaration in the
// record file. Identifiers are bound to unique sentinels inside the context and
// come back as this marker object, so the host never touches a vm object.
const SYMBOL_MARK = '__jsn_symbol__';

/** True when `value` is the marker substituted for an identifier value. */
export function isRecordSymbol(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value[SYMBOL_MARK] === 'string' && Object.keys(value).length === 1;
}

export function recordSymbolName(value) {
  return isRecordSymbol(value) ? value[SYMBOL_MARK] : null;
}

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
  for (const name of names) bindings.set(name, Symbol(name));
  return bindings;
}

/** Replace every bound sentinel with the marker that validation understands. */
/**
 * Evaluate the metadata literal and validate it **inside** the bounded context.
 *
 * The value never crosses back as an object: the snippet walks it, rejects
 * anything that is not plain data, and returns JSON. Host code only parses
 * that string, so a Proxy trap, an accessor or an enormous ownKeys array runs
 * under the timeout instead of hanging the build on the host thread.
 */
// Names that cannot appear in a parameter list. A literal holding one of these
// is not data — `{ script: function () {} }` and `{ get script() {} }` are
// rejected below — so those literals keep the global-binding path.
const RESERVED_BINDINGS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function evaluateMetadata(literal, bindings) {
  const sandbox = Object.create(null);
  const names = [...bindings.keys()];
  // Each record identifier reaches the literal as a parameter of the arrow that
  // evaluates it, so a name such as `value` or `Set` cannot collide with the
  // walker's own locals or with the intrinsics it uses: a `const value` in the
  // same scope put `script: value` in a temporal dead zone, and binding `Set`
  // as a global replaced the constructor `new Set()` needs.
  const byParameter = names.length > 0 && names.every(name => !RESERVED_BINDINGS.has(name));
  if (byParameter) {
    names.forEach((name, index) => { sandbox[`__jsn_id_${index}`] = bindings.get(name); });
  } else {
    for (const [name, sentinel] of bindings) sandbox[name] = sentinel;
  }
  const call = byParameter
    ? `((${names.join(', ')}) => (${literal}))(${names.map((_, index) => `__jsn_id_${index}`).join(', ')})`
    : `(${literal})`;
  const snippet = `(() => {
   try {
    const defaultExport = ${call};
    const MARK = '${SYMBOL_MARK}';
    const MAX_DEPTH = 16;
    const seen = new Set();
    const walk = (v, depth, at) => {
      if (v === null) return null;
      const t = typeof v;
      if (t === 'string' || t === 'boolean') return v;
      if (t === 'number') {
        if (!Number.isFinite(v)) throw new Error(at + ' is a non-finite number');
        return v;
      }
      if (t === 'symbol') { const m = {}; m[MARK] = String(v.description || ''); return m; }
      if (t === 'function') throw new Error(at + ' is a function');
      if (t !== 'object') throw new Error(at + ' is a ' + t);
      if (Array.isArray(v)) throw new Error(at + ' is an array');
      const proto = Object.getPrototypeOf(v);
      if (!(proto === null || Object.getPrototypeOf(proto) === null)) throw new Error(at + ' is a non-plain object');
      if (depth >= MAX_DEPTH) throw new Error(at + ' is an object nested too deeply');
      if (seen.has(v)) throw new Error(at + ' is a circular reference');
      seen.add(v);
      const out = Object.create(null);
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string') throw new Error(at + ' has a symbol key');
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d) throw new Error(at + '.' + key + ' is not readable');
        if (d.get || d.set) throw new Error(at + '.' + key + ' is an accessor property');
        out[key] = walk(d.value, depth + 1, at + '.' + key);
      }
      seen.delete(v);
      return out;
    };
    return JSON.stringify(walk(defaultExport, 0, 'the default export'));
   } catch (thrown) {
    // Convert the error inside the bounded context. Reading .message of a
    // vm-thrown value on the host would run project code (a getter, a Proxy
    // trap) after the timeout has already returned.
    let detail;
    try { detail = String(thrown && thrown.message).split('\\n')[0]; } catch (_) { detail = 'evaluation raised an unreadable value'; }
    throw detail;
   }
  })()`;
  try {
    // `afterEvaluate` runs microtasks the metadata scheduled inside the same
    // timeout, so a promise chain cannot keep working after the call returns.
    const json = runInContext(snippet, createContext(sandbox, { microtaskMode: 'afterEvaluate' }),
      { timeout: 1000, displayErrors: false });
    return { ok: true, metadata: JSON.parse(json) };
  } catch (thrown) {
    // A string here is what the snippet re-threw. Anything else is the VM's own
    // error (a syntax error or the timeout), which this code created, so its
    // message is safe to read.
    const detail = typeof thrown === 'string'
      ? thrown
      : String((thrown && thrown.message) || 'evaluation did not complete').split('\n')[0];
    // Keep the established wording for "this is not data" refusals; the walk
    // builds them from the value's own path.
    if (detail.startsWith('the default export')) {
      return { ok: false, error: 'the default export may hold only strings, numbers, booleans and '
        + `plain objects: ${detail}` };
    }
    return { ok: false, error: `cannot read the default export: ${detail}` };
  }
}
const DECLARATION_KEYWORDS = new Set(['var', 'let', 'const', 'function', 'class']);
// A `function` or `class` only declares a top-level name when it starts a
// statement. `const replacement = function OldName() {}` declares `replacement`
// alone; `OldName` is a function expression's own name, not a binding above.
const STATEMENT_LEAD_INS = new Set(['export', 'default', 'async']);

function startsStatement(tokens, index) {
  const previous = tokens[index - 1];
  if (!previous) return true;
  const afterLineBreak = tokens[index].newlineBefore === true;
  if (previous.type === 'punct') {
    if (previous.value === ';' || previous.value === '{' || previous.value === '}') return true;
    // Automatic semicolon insertion: `setup()` on its own line is a complete
    // expression statement, so the `function` below it declares a new name.
    return afterLineBreak && (previous.value === ')' || previous.value === ']');
  }
  if (previous.type !== 'ident') return afterLineBreak;
  // `async` is a lead-in only when it starts a statement itself: in
  // `const run = async function Hidden() {}` it does not, so `Hidden` is a
  // function expression's own name and not a top-level declaration.
  if (previous.value === 'async') return startsStatement(tokens, index - 1);
  return STATEMENT_LEAD_INS.has(previous.value) || afterLineBreak;
}

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
/**
 * True when `source` holds at least one executable token.
 *
 * Comments and whitespace alone tokenize to nothing, so a metadata-only record
 * with a header comment above its export is not mistaken for unused code.
 */
export function hasCode(source) {
  const { tokens, error } = tokensOf(source);
  return !error && tokens.length > 0;
}

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
    if ((token.value === 'function' || token.value === 'class') && !startsStatement(tokens, index)) continue;
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
  const metadata = evaluated.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: false, error: 'the default export must be a plain object' };
  }
  return { ok: true, metadata, body, literal };
}
