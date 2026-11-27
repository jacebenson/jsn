// Read and validate a jsn app project — record format v1 (issue #399).
//
// A project is a plain directory:
//
//   <project>/app.yaml                     project identity + deployment backend
//   <project>/records/<table>/<slug>.json  one record per file
//   <project>/records/<table>/<slug>.js    one record per file, script inline
//   <project>/code/<file>.js               lifted script bodies
//
// A `.js` record keeps the script and the metadata in one file:
//
//   var LaptopUtils = Class.create();
//   LaptopUtils.prototype.isStandard = function (model) { … };
//
//   export default {
//     sys_id: '22222222222222222222222222222222',
//     table: 'sys_script_include',
//     fields: { name: 'LaptopUtils', active: 'true' },
//     script: LaptopUtils,
//   };
//
// Everything above the `export default` statement is the script, byte-for-byte,
// edited and linted as ordinary JavaScript and never executed by the build. The
// default export must be the last statement.
//
// Extraction and the trailing-newline rule (implemented in app-record-js.js):
//
//   script = source.slice(0, start of "export")
//   if (script ends with "\r\n") drop those 2 characters
//   else if (script ends with "\n") drop that 1 character
//
// Nothing else is trimmed, rewritten or re-indented: a BOM, CRLF line endings
// and non-ASCII characters all survive, and a second trailing newline is part
// of the script (that is what "exactly one" means).
//
// `script: LaptopUtils` ships that body and requires the body to declare the
// named symbol at its top level, so renaming the class and forgetting the
// metadata breaks the build. `script: './shared/laptop-utils.js'` reads
// that file's bytes instead (relative to the project root, inside it, and it
// must exist). Any other string is one line of code. A string that looks like
// a path but names no file is an error — it is never silently used as script
// text.
//
// The metadata is parsed, not executed: only the object literal after
// `export default` is evaluated, in an empty `node:vm` context. A function
// value in it is rejected.
//
// `code: { <field>: <path> }` stays exactly what it was for the `.json` form
// (a path relative to the project root), and a record with several code fields
// (a widget's five) names one declaration for one field and paths for the rest.
// Only one
// field may claim the file body.
//
// This module only reads and validates; it never serializes and never touches
// an instance. app-build-update-set.js turns the returned project into the
// update-set export envelope the existing importer already accepts.
//
// Code files are read as UTF-8 and returned verbatim: no BOM stripping, no
// CRLF normalization, no trailing-newline change. Callers can assert byte
// equality by re-encoding the returned text.

import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { AppError } from './errors.js';
import { extractRecordSource, recordSymbolName, topLevelDeclarations } from './app-record-js.js';

export const APP_PROJECT_VERSION = 1;
export const PROJECT_BACKENDS = ['update-set', 'package'];
export const APP_YAML_KEYS = Object.freeze(['version', 'app', 'backend', 'description']);
export const APP_KEYS = Object.freeze(['name', 'scope', 'sys_id', 'version']);
export const RECORD_KEYS = Object.freeze(['sys_id', 'table', 'fields', 'code', 'script']);
// A `.js` record file is metadata only when it ends with one of these.
export const RECORD_EXTENSIONS = Object.freeze(['.json', '.js']);

// Validation failures are a local input problem, not a usage mistake in the
// command line: `jsn app build` exits 1 (not the usage class's exit 2) and
// lists every error at once.
export const PROJECT_ERROR_CODE = 'invalid_project';

const SYS_ID = /^[a-f0-9]{32}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]*$/;
// Field and code keys become XML element names in the payload. ServiceNow
// columns always satisfy this; a name that does not is a project mistake the
// writer would otherwise only discover from the importer contract.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Characters that can appear in a relative path we are willing to read. A
// `script` string that contains a separator and nothing outside this set is
// treated as a path, so a missing file is reported instead of being silently
// emitted as one line of script text.
const PATH_CHARS = /^[A-Za-z0-9._~@+\\/-]+$/;
// The XML 1.0 Char production. Everything else — NUL and the other C0 controls,
// lone surrogates, U+FFFE/U+FFFF — cannot be carried in a document at all, so a
// field or script holding one is refused instead of being stripped or escaped
// into an artifact the importer would reject.
const XML_INVALID = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

/** `U+0001` for the first character XML cannot represent, or null when all can. */
function invalidXmlCharacter(text) {
  const match = XML_INVALID.exec(text);
  return match ? `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : null;
}

/** One aggregated, ordered validation failure. */
export function errInvalidProject(errors) {
  const list = [...errors];
  const noun = list.length === 1 ? 'error' : 'errors';
  const error = new AppError(PROJECT_ERROR_CODE,
    `Invalid app project (${list.length} ${noun}):\n${list.map(item => `  - ${item}`).join('\n')}`,
    'Fix the listed files and re-run "jsn app build". Nothing was written.');
  error.errors = list;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneLine(message) {
  return String(message || '').split('\n')[0].trim();
}

/** Relative, forward-slash path or null when it escapes the project root. */
function insideRoot(root, target) {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join('/');
}

function readUtf8(file) {
  // Buffer.toString('utf8') keeps a leading BOM and every original byte of a
  // valid UTF-8 file, which is exactly what lifted script bodies need — but it
  // replaces a malformed byte with U+FFFD, silently shipping different bytes
  // than the author wrote. Decode strictly and let the caller report the file.
  const bytes = fs.readFileSync(file);
  try {
    // ignoreBOM keeps the BOM in the string, as Buffer.toString('utf8') does.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error('the file is not valid UTF-8'), { code: 'EINVALIDUTF8' });
  }
}

/**
 * A `script` string that names a file we cannot read looks like a path.
 *
 * Existence is checked first, so this only decides what to do when nothing is
 * there: a path-shaped string is an error, anything else is script text.
 */
function looksLikePath(value) {
  if (path.isAbsolute(value)) return true;
  if (/^\.\.?[\\/]/.test(value)) return true;
  if (/\.(?:js|cjs|mjs)$/i.test(value)) return true;
  return /[\\/]/.test(value) && PATH_CHARS.test(value);
}

/**
 * Read a project and collect every validation error, in a stable order.
 *
 * @param {string} [dir] — project directory (default '.')
 * @returns {{ project: object|null, errors: string[] }}
 */
export function validateAppProject(dir = '.') {
  const root = path.resolve(dir);
  const errors = [];
  const project = { root, app: {}, backend: '', description: '', records: [] };

  const appYamlFile = path.join(root, 'app.yaml');
  let doc;
  let yamlFailed = false;
  try {
    const text = readUtf8(appYamlFile);
    try {
      doc = loadYaml(text);
    } catch (error) {
      yamlFailed = true;
      errors.push(`app.yaml: invalid YAML (${oneLine(error.message)})`);
    }
  } catch (error) {
    yamlFailed = true;
    errors.push(`app.yaml: cannot read app.yaml (${error.code || oneLine(error.message)})`);
  }

  if (!yamlFailed && !isPlainObject(doc)) {
    errors.push('app.yaml: expected a mapping with version, app, backend and description');
    doc = null;
  }

  if (doc) {
    for (const key of Object.keys(doc)) {
      if (!APP_YAML_KEYS.includes(key)) errors.push(`app.yaml: unknown key "${key}"`);
    }
    if (doc.version !== APP_PROJECT_VERSION) errors.push(`app.yaml: version must be ${APP_PROJECT_VERSION}`);

    if (!isPlainObject(doc.app)) {
      errors.push('app.yaml: app must be a mapping with name and scope');
    } else {
      for (const key of Object.keys(doc.app)) {
        if (!APP_KEYS.includes(key)) errors.push(`app.yaml: unknown app key "${key}"`);
      }
      if (typeof doc.app.name !== 'string' || !doc.app.name.trim()) errors.push('app.yaml: app.name is required');
      if (typeof doc.app.scope !== 'string' || !doc.app.scope.trim()) errors.push('app.yaml: app.scope is required');
      if (doc.app.sys_id !== undefined && (typeof doc.app.sys_id !== 'string' || !SYS_ID.test(doc.app.sys_id))) {
        errors.push('app.yaml: app.sys_id must be 32 lowercase hexadecimal characters');
      }
      // Issue #399: Global is an explicit project target, never the implicit
      // fallback for a scoped app. Without the application sys_id the writer
      // would have to invent one, and the set would silently claim Global.
      const scope = typeof doc.app.scope === 'string' ? doc.app.scope.trim() : '';
      // Both values land in the <sys_app> document (the scope also in an
      // attribute), so a character XML cannot carry is refused here rather than
      // escaped into an artifact the importer would reject.
      for (const [label, text] of [['name', doc.app.name], ['scope', scope]]) {
        const invalid = typeof text === 'string' ? invalidXmlCharacter(text) : null;
        if (invalid) errors.push(`app.yaml: app.${label} contains ${invalid}, which XML cannot represent`);
      }
      // Only a string is an application sys_id. Coercing a rejected value would
      // satisfy the presence check below with something that is not an id, so a
      // YAML number or boolean stays one diagnostic, not two.
      const sysId = typeof doc.app.sys_id === 'string' ? doc.app.sys_id.trim() : '';
      if (scope && scope !== 'global' && !sysId) {
        errors.push(`app.yaml: app.sys_id is required when app.scope is "${scope}": `
          + 'a scoped app must name its application sys_id (Global is never an implicit fallback)');
      }
      project.app = {
        ...(typeof doc.app.name === 'string' ? { name: doc.app.name } : {}),
        ...(typeof doc.app.scope === 'string' ? { scope } : {}),
        ...(typeof doc.app.sys_id === 'string' ? { sys_id: doc.app.sys_id } : {}),
        ...(doc.app.version !== undefined ? { version: doc.app.version } : {}),
      };
    }

    if (!PROJECT_BACKENDS.includes(doc.backend)) {
      errors.push(`app.yaml: backend must be one of: ${PROJECT_BACKENDS.join(', ')}`);
    } else {
      project.backend = doc.backend;
    }
    if (typeof doc.description === 'string') project.description = doc.description;
  }

  const recordsDir = path.join(root, 'records');
  let tables = [];
  try {
    tables = fs.readdirSync(recordsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    errors.push(`records: directory is missing or unreadable (${error.code || oneLine(error.message)})`);
  }

  const seenSysIds = new Map();
  // app.yaml names an application row, and that row has an id like any other: a
  // record reusing it would ship two definitions of the same sys_id.
  if (project.app.sys_id) seenSysIds.set(project.app.sys_id, 'app.yaml');
  for (const table of tables) {
    const tableDir = path.join(recordsDir, table);
    let files;
    try {
      files = fs.readdirSync(tableDir)
        .filter(name => RECORD_EXTENSIONS.some(extension => name.endsWith(extension)))
        .sort();
    } catch (error) {
      errors.push(`records/${table}: directory is unreadable (${error.code || oneLine(error.message)})`);
      continue;
    }
    for (const file of files) {
      const record = validateRecord({ root, table, tableDir, file, errors, seenSysIds });
      if (record) project.records.push(record);
    }
  }

  return { project: errors.length ? null : project, errors };
}

function validateRecord(context) {
  return context.file.endsWith('.js')
    ? validateSingleFileRecord(context)
    : validateJsonRecord(context);
}

function validateJsonRecord({ root, table, tableDir, file, errors, seenSysIds }) {
  const filePath = path.join(tableDir, file);
  const display = `records/${table}/${file}`;
  let raw;
  try {
    const text = readUtf8(filePath);
    try {
      raw = JSON.parse(text);
    } catch (error) {
      errors.push(`${display}: invalid JSON (${oneLine(error.message)})`);
      return null;
    }
  } catch (error) {
    errors.push(`${display}: cannot read file (${error.code || oneLine(error.message)})`);
    return null;
  }
  if (!isPlainObject(raw)) {
    errors.push(`${display}: expected a JSON object`);
    return null;
  }
  return assembleRecord({ root, table, file, display, raw, errors, seenSysIds, body: null });
}

function validateSingleFileRecord({ root, table, tableDir, file, errors, seenSysIds }) {
  const display = `records/${table}/${file}`;
  let source;
  try {
    source = readUtf8(path.join(tableDir, file));
  } catch (error) {
    errors.push(`${display}: cannot read file (${error.code || oneLine(error.message)})`);
    return null;
  }

  const extracted = extractRecordSource(source);
  if (!extracted.ok) {
    errors.push(`${display}: ${extracted.error}`);
    return null;
  }
  return assembleRecord({
    root, table, file, display, raw: extracted.metadata, errors, seenSysIds, body: extracted.body,
  });
}

/**
 * Validate one record's metadata and resolve every code field to its text.
 *
 * `body` is the script above the default export for a `.js` record, and null
 * for a `.json` record (which has no file body to claim).
 */
function assembleRecord({ root, table, file, display, raw, errors, seenSysIds, body }) {
  for (const key of Object.keys(raw)) {
    if (!RECORD_KEYS.includes(key)) errors.push(`${display}: unknown key "${key}"`);
  }

  const sysId = raw.sys_id;
  if (typeof sysId !== 'string' || !SYS_ID.test(sysId)) {
    errors.push(`${display}: sys_id must be 32 lowercase hexadecimal characters`);
  } else if (seenSysIds.has(sysId)) {
    errors.push(`${display}: duplicate sys_id ${sysId} (already used by ${seenSysIds.get(sysId)})`);
  } else {
    seenSysIds.set(sysId, display);
  }

  if (typeof raw.table !== 'string' || !raw.table) {
    errors.push(`${display}: table is required`);
  } else if (raw.table !== table) {
    errors.push(`${display}: table "${raw.table}" does not match its directory records/${table}`);
  } else if (!TABLE_NAME.test(table)) {
    errors.push(`${display}: table "${table}" is not a valid table name`);
  }

  const fields = raw.fields === undefined ? {} : raw.fields;
  if (!isPlainObject(fields)) errors.push(`${display}: fields must be an object`);

  const fieldEntries = isPlainObject(fields) ? Object.entries(fields) : [];
  for (const [name, value] of fieldEntries) {
    if (!FIELD_NAME.test(name)) errors.push(`${display}: field "${name}" is not a valid field name`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      errors.push(`${display}: field "${name}" must be a string, number, or boolean`);
    } else if (typeof value === 'string') {
      const invalid = invalidXmlCharacter(value);
      if (invalid) errors.push(`${display}: field "${name}" contains ${invalid}, which XML cannot represent`);
    }
  }

  const resolved = resolveCodeFields({ root, display, raw, fields: isPlainObject(fields) ? fields : {},
    errors, allowBody: body !== null, body: body || '', declarations: body ? topLevelDeclarations(body) : [] });

  const claims = resolved.filter(entry => entry.body).map(entry => entry.name);
  // A `.js` record ships the body above `export default` only when a field
  // names a declaration in it. With neither a claim nor a path elsewhere, the
  // code would be dropped and the metadata shipped alone, so refuse it here.
  if (body !== null && body.trim() !== '' && claims.length === 0 && resolved.length === 0) {
    errors.push(`${display}: the script body above "export default" is not used by any field `
      + '(name a declaration with script or code.<field>, or point that field at a .js file)');
  }
  if (claims.length > 1) {
    errors.push(`${display}: fields ${claims.map(name => `"${name}"`).join(' and ')} `
      + 'both claim the file body; only one field may name a declaration');
  }
  if (claims.length === 1 && body === '') {
    errors.push(`${display}: field "${claims[0]}" names a declaration but the script body is empty `
      + '(there is no code above "export default")');
  }
  for (const entry of resolved) {
    if (entry.body) entry.text = body ?? '';
  }
  for (const entry of resolved) {
    if (typeof entry.text !== 'string') continue;
    const invalid = invalidXmlCharacter(entry.text);
    if (invalid) errors.push(`${display}: code.${entry.name} contains ${invalid}, which XML cannot represent`);
  }

  return {
    table,
    slug: file.slice(0, -path.extname(file).length),
    file: display,
    sys_id: typeof sysId === 'string' ? sysId : '',
    fields: isPlainObject(fields) ? { ...fields } : {},
    code: Object.fromEntries(resolved.map(entry => [entry.name, { path: entry.path, text: entry.text }])),
  };
}

/**
 * Resolve `code` and `script` to one entry per code field.
 *
 * `code.<field>` is a path, or in a `.js` record the name of a declaration in
 * the file body (`code.script: LaptopUtils`), the same named-declaration form
 * `script` uses. `script` is sugar for the field named `script` and
 * additionally accepts one line of code.
 */
function resolveCodeFields({ root, display, raw, fields, errors, allowBody, body, declarations }) {
  const resolved = [];
  const names = new Set();

  const code = raw.code === undefined ? {} : raw.code;
  const codeIsObject = isPlainObject(code);
  if (!codeIsObject) errors.push(`${display}: code must be an object`);

  if (codeIsObject) {
    for (const [name, value] of Object.entries(code)) {
      if (!FIELD_NAME.test(name)) errors.push(`${display}: field "${name}" is not a valid field name`);
      // Both writers emit <sys_id> from the record identity, so a code field of
      // that name would put the element in the payload twice.
      if (name === 'sys_id') {
        errors.push(`${display}: code.sys_id is written from the record identity; remove it from the record`);
        continue;
      }
      if (Object.hasOwn(fields, name)) {
        errors.push(`${display}: field "${name}" is defined in both fields and code`);
      }
      names.add(name);
      const symbol = recordSymbolName(value);
      if (symbol) {
        const problem = checkClaimedSymbol({ display, label: `code.${name}`, symbol,
          allowBody, body, declarations });
        if (problem) errors.push(problem);
        else resolved.push({ name, path: display, text: null, body: true, symbol });
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`${display}: code.${name} must name a declaration in this file, `
          + 'or be a .js path relative to the project root');
        continue;
      }
      const entry = resolveCodePath({ root, display, label: `code.${name}`, value, errors });
      if (entry) resolved.push({ name, ...entry });
    }
  }

  if (raw.script === undefined) return resolved;

  const name = 'script';
  if (names.has(name)) {
    errors.push(`${display}: field "script" is defined in both code and script`);
  } else if (Object.hasOwn(fields, name)) {
    errors.push(`${display}: field "script" is defined in both fields and script`);
  }
  names.add(name);

  const scriptSymbol = recordSymbolName(raw.script);
  if (scriptSymbol) {
    const problem = checkClaimedSymbol({ display, label: 'script', symbol: scriptSymbol,
      allowBody, body, declarations });
    if (problem) errors.push(problem);
    else resolved.push({ name, path: display, text: null, body: true, symbol: scriptSymbol });
    return resolved;
  }

  if (typeof raw.script !== 'string' || !raw.script.trim()) {
    errors.push(`${display}: script must name a declaration in this file, `
      + 'or be a .js path relative to the project root');
    return resolved;
  }
  const entry = resolveScriptValue({ root, display, value: raw.script, errors });
  if (entry) resolved.push({ name, ...entry });
  return resolved;
}

/**
 * A code field that names a declaration: only a `.js` record has a body, and
 * the body must declare that exact name, so a rename cannot silently detach the
 * metadata from the code.
 */
function checkClaimedSymbol({ display, label, symbol, allowBody, body, declarations }) {
  if (!allowBody) {
    return `${display}: ${label} names "${symbol}", but a .json record has no script body `
      + '(the body is the code above the default export in a .js record)';
  }
  if (!declarations.includes(symbol)) {
    const found = declarations.length ? declarations.map(name => `"${name}"`).join(', ') : 'none';
    return `${display}: ${label} names "${symbol}", which is not declared at the top level of `
      + `this file (found: ${found})`;
  }
  if (body.trim() === '') {
    return `${display}: ${label} names "${symbol}" but the script body is empty`;
  }
  return null;
}

/** A `code.<field>` value: a path relative to the project root, always. */
/**
 * The real path of `candidate` when it is inside the real project root, else null.
 *
 * `insideRoot()` compares written paths, which a symlink in the project can
 * escape: `code/x.js -> ~/.aws/credentials` passes the lexical check and then
 * `readFileSync` follows the link. Resolve both the file and the root before
 * reading anything the build embeds in an artifact.
 */
function containedRealPath(root, candidate) {
  let realFile;
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(realRoot, realFile);
  // A parent segment is ".." alone or ".." followed by a separator; a file
  // legitimately named "..notes.js" inside the root must not be refused.
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return realFile;
}

function resolveCodePath({ root, display, label, value, errors }) {
  if (path.isAbsolute(value)) {
    errors.push(`${display}: ${label} must be relative to the project root, not absolute (${value})`);
    return null;
  }
  const resolvedPath = path.resolve(root, value);
  const inside = insideRoot(root, resolvedPath);
  if (inside === null) {
    errors.push(`${display}: ${label} escapes the project root (${value})`);
    return null;
  }
  if (path.extname(resolvedPath) !== '.js') {
    errors.push(`${display}: ${label} must point to a .js file (${value})`);
    return null;
  }
  try {
    if (!fs.statSync(resolvedPath).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const realFile = containedRealPath(root, resolvedPath);
    if (realFile === null) {
      errors.push(`${display}: ${label} resolves outside the project root through a link (${value})`);
      return null;
    }
    // Read the path containment was proved for, not the written one: a link
    // swapped between the check and the read would otherwise carry the build
    // outside the project. `realFile` has no links left to follow.
    return { path: value, text: readUtf8(realFile) };
  } catch (error) {
    errors.push(`${display}: ${label} file not found: ${inside} (${error.code || oneLine(error.message)})`);
    return null;
  }
}

/**
 * A top-level `script` value: an existing file's bytes, or one line of code.
 *
 * A string that resolves to an existing file is a path. A string that looks
 * like a path and does not resolve to a file is an error — never script text.
 */
function resolveScriptValue({ root, display, value, errors }) {
  if (path.isAbsolute(value)) {
    errors.push(`${display}: script must be relative to the project root, not absolute (${value})`);
    return null;
  }
  const resolvedPath = path.resolve(root, value);
  const inside = insideRoot(root, resolvedPath);
  if (inside === null) {
    errors.push(`${display}: script escapes the project root (${value})`);
    return null;
  }

  let stats = null;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    // nothing exists at that path; a string may still be one line of code
  }

  if (stats) {
    const realFile = containedRealPath(root, resolvedPath);
    if (realFile === null) {
      errors.push(`${display}: script resolves outside the project root through a link (${value})`);
      return null;
    }
    if (!stats.isFile()) {
      errors.push(`${display}: script path is not a file: ${inside}`);
      return null;
    }
    if (path.extname(resolvedPath) !== '.js') {
      errors.push(`${display}: script path must point to a .js file (${value})`);
      return null;
    }
    // A file can pass both checks and still fail the read (EACCES). Report it
    // with the other project errors instead of throwing out of validation. The
    // read uses the canonical path containment was proved for, never the link.
    try {
      return { path: value, text: readUtf8(realFile) };
    } catch (error) {
      errors.push(`${display}: script cannot be read (${error.code || oneLine(error.message)})`);
      return null;
    }
  }

  if (looksLikePath(value)) {
    errors.push(`${display}: script path does not exist: ${value} `
      + '(a string that looks like a file path must name a file in the project)');
    return null;
  }
  return { path: null, text: value };
}

/**
 * Read a project and throw one aggregated error when anything is invalid.
 *
 * @param {string} [dir] — project directory (default '.')
 * @returns {object} project: { root, app, backend, description, records }
 *   Each record carries `fields` and `code` ({ field: { path, text } }).
 */
export function readAppProject(dir = '.') {
  const { project, errors } = validateAppProject(dir);
  if (errors.length) throw errInvalidProject(errors);
  return project;
}
