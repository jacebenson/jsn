// Build a native ServiceNow app package (a ZIP) from a validated app project.
//
// The layout matches what `now-sdk build` + `pack` produce, so the artifact can
// be installed with the platform's own "Install from file" path:
//
//   /package_inventory.csv                 manifest: build scope, app version,
//                                          type, format version, and one
//                                          `<path>;<sha256>` line per file
//   /scope/sys_app_<sys_id>.xml            the application record
//   /update/<table>_<sys_id>.xml           one record_update document per record
//
// Entry names carry a leading slash — that is what the reference archive
// contains, and zip-writer writes names verbatim. The inventory lists the same
// paths without it.
//
// Cell text is escaped character data, never CDATA, and every byte of a script
// body travels through `escapeXmlText` — the same helper the update-set writer
// uses. A literal CR would be normalized to LF by any XML parser, so it is
// emitted as `&#13;`; `]]>` needs no special case because `>` is escaped too.
// The result is that a script re-read from the archive is byte-identical to the
// file it came from (BOM, CRLF, unicode and all).
//
// Nothing here contacts an instance. `now` is accepted for contract symmetry
// with the other writers; no entry byte depends on the clock, so the zip
// container (zip-writer) is where the clock actually lands.
//
// The field lists below are also what `jsn app deploy` reads back and compares
// after an install. They are the single description of "what this package
// says", so the writer cannot drift from the verifier: the XML builders consume
// the same lists, and a test asserts the produced documents carry exactly them.

import { createHash } from 'node:crypto';
import { escapeXmlText, escapeXmlAttribute, derivedSysId } from './app-build-update-set.js';
import { errInvalidProject } from './app-project.js';
import { writeZip } from './zip-writer.js';

/** The inventory's `#version` line: the package format, not the app version. */
export const PACKAGE_FORMAT_VERSION = '1.0.0';
export const INVENTORY_PATH = 'package_inventory.csv';
export const SCOPE_DIR = 'scope';
export const UPDATE_DIR = 'update';

// Instances name scopes like `global`, `x_1234_demo` and `sn_vendor_app`.
const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// A version is an identity, not free text: it lands in a filename and in the
// manifest, so path separators and whitespace are refused up front.
const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * The application sys_id a package scopes its records to.
 *
 * A scoped project always names one (app-project requires it). A Global
 * project has no scope record to inherit, so a stable id is derived from the
 * project identity — the same trick the update-set writer uses for ids that
 * have no instance identity, which keeps rebuilds byte-identical.
 */
export function packageAppSysId(app) {
  if (typeof app.sys_id === 'string' && app.sys_id) return app.sys_id;
  return derivedSysId('jsn-app-package', app.scope ?? '', app.name ?? '');
}

/** `scope/sys_app_<sys_id>.xml` — the inventory's path, no leading slash. */
export function scopeXmlPath(app) {
  return `${SCOPE_DIR}/sys_app_${packageAppSysId(app)}.xml`;
}

/** `update/<table>_<sys_id>.xml` — the inventory's path, no leading slash. */
export function recordXmlPath(record) {
  return `${UPDATE_DIR}/${record.table}_${record.sys_id}.xml`;
}

/** Replace anything a filename cannot carry, so a default name stays in `cwd`. */
function fileSegment(value) {
  const cleaned = String(value ?? '').normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 180);
  return cleaned || 'app';
}

/** The default artifact name: `<scope>-<version>.zip`. */
export function packageFileName(app) {
  return `${fileSegment(app.scope)}-${fileSegment(app.version)}.zip`;
}

/**
 * Why this project cannot be packaged, in one ordered list.
 *
 * `readAppProject` already rejects a scoped project without an application
 * sys_id; it does not require `app.version` at all, because an update-set
 * export carries no version. A package does — the version is the app's
 * identity on the target instance and is written into both the scope record and
 * the inventory — so the check lives here and the failures are aggregated the
 * same way the reader aggregates its own.
 *
 * @param {object} project — from readAppProject()
 * @returns {string[]}
 */
export function validatePackageTarget(project) {
  const errors = [];
  const app = project?.app;
  if (!app || typeof app !== 'object') {
    return ['app: the project has no app identity to package'];
  }

  const scope = typeof app.scope === 'string' ? app.scope.trim() : '';
  if (!scope) {
    errors.push('app.yaml: app.scope is required to package an app');
  } else if (!SCOPE_NAME.test(scope)) {
    errors.push(`app.yaml: app.scope "${scope}" is not a valid scope name `
      + '(letters, digits, "_", "." and "-" only)');
  }

  if (app.version === undefined || app.version === null
    || (typeof app.version === 'string' && app.version.trim() === '')) {
    errors.push('app.yaml: app.version is required for the package backend '
      + '(a packaged app carries a version on the target instance)');
  } else if (typeof app.version !== 'string' || !VERSION_NAME.test(app.version.trim())) {
    errors.push(`app.yaml: app.version ${JSON.stringify(app.version)} is not a packageable version `
      + '(expected a string like "1.0.0": letters, digits, ".", "_", "+" and "-", with no spaces or path separators)');
  }

  const sysId = typeof app.sys_id === 'string' ? app.sys_id.trim() : '';
  if (scope && scope !== 'global' && !sysId) {
    errors.push(`app.yaml: app.sys_id is required when app.scope is "${scope}": `
      + 'a scoped package must name the application sys_id its records scope to');
  }

  return errors;
}

/**
 * The `<sys_app>` element's fields, in document order.
 *
 * This is the description of the application row the package installs — and
 * therefore exactly what a deploy reads back and compares. Values are the text
 * the XML carries (`true`, `es_latest`, …), not JavaScript types: the instance
 * column holds text, so comparing text keeps readback honest.
 *
 * @param {object} project
 * @returns {Array<{name: string, value: string}>}
 */
export function scopeVerificationFields(project) {
  const app = project.app;
  const sysId = packageAppSysId(app);
  return [
    { name: 'sys_id', value: String(sysId) },
    // Write instructions, not readable attributes: the instance stores the scope
    // as `scope` and does not echo a sys_update_name on sys_app, so comparing
    // these two on readback would report a disagreement on every successful
    // install. They stay in the document and out of the comparison.
    { name: 'sys_scope', value: String(sysId), verify: false },
    { name: 'sys_update_name', value: `sys_app_${sysId}`, verify: false },
    { name: 'active', value: 'true' },
    { name: 'js_level', value: 'es_latest' },
    { name: 'licensable', value: 'true' },
    { name: 'name', value: String(app.name ?? '') },
    { name: 'private', value: 'false' },
    { name: 'scope', value: String(app.scope) },
    { name: 'source', value: String(app.scope) },
    { name: 'trackable', value: 'true' },
    { name: 'version', value: String(app.version) },
  ];
}

/**
 * One record's fields, in document order: identity and scope reference first,
 * then the record's authored fields, then its code fields.
 *
 * Same contract as scopeVerificationFields: this is what the XML writes and
 * what a deploy compares. Code values keep their exact text, so a readback
 * comparison is byte-for-byte.
 *
 * @param {object} record — from readAppProject()
 * @param {object} app
 * @returns {Array<{name: string, value: string, code?: boolean}>}
 */
export function recordVerificationFields(record, app) {
  const fields = [
    { name: 'sys_id', value: String(record.sys_id) },
    { name: 'sys_scope', value: String(packageAppSysId(app)) },
    { name: 'sys_update_name', value: `${record.table}_${record.sys_id}` },
  ];
  for (const [name, value] of Object.entries(record.fields ?? {})) {
    if (name === 'sys_id') continue; // emitted once, from the record identity
    fields.push({ name, value: String(value) });
  }
  for (const [name, entry] of Object.entries(record.code ?? {})) {
    fields.push({ name, value: String(entry.text), code: true });
  }
  return fields;
}

/** The `<sys_app>` document: the application record the package installs. */
export function buildScopeXml(project) {
  const app = project.app;
  const lines = [
    '<?xml version="1.0"?>',
    '<record_update table="sys_app">',
    '  <sys_app action="INSERT_OR_UPDATE" apply_defaults="true">',
  ];
  for (const field of scopeVerificationFields(project)) {
    // The one field that also carries the scope's name for a human reader.
    lines.push(field.name === 'sys_scope'
      ? `    <sys_scope display_value="${escapeXmlAttribute(app.scope)}">${escapeXmlText(field.value)}</sys_scope>`
      : `    <${field.name}>${escapeXmlText(field.value)}</${field.name}>`);
  }
  lines.push('  </sys_app>', '</record_update>', '');
  return lines.join('\n');
}

/**
 * One `<record_update>` document for a record.
 *
 * Element order is fixed by recordVerificationFields. A reserialization of the
 * same project is therefore byte-identical.
 */
export function buildRecordXml(record, app) {
  const table = record.table;
  const lines = [
    '<?xml version="1.0"?>',
    `<record_update table="${escapeXmlAttribute(table)}">`,
    `  <${table} action="INSERT_OR_UPDATE" apply_defaults="true">`,
  ];
  for (const field of recordVerificationFields(record, app)) {
    lines.push(field.name === 'sys_scope'
      ? `    <sys_scope display_value="${escapeXmlAttribute(app.scope)}">${escapeXmlText(field.value)}</sys_scope>`
      : `    <${field.name}>${escapeXmlText(field.value)}</${field.name}>`);
  }
  lines.push(`  </${table}>`, '</record_update>', '');
  return lines.join('\n');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The manifest. Header order and spelling are the reference artifact's; the
 * checksums are over the exact bytes stored in the archive, so a consumer can
 * verify an entry without trusting the writer.
 *
 * @param {{app: object, files: Array<{name: string, bytes: Buffer}>}} input
 * @returns {string}
 */
export function buildInventory({ app, files }) {
  const type = app.scope === 'global' ? 'global' : 'scoped';
  const lines = [
    `#build=${app.scope}`,
    `#appVersion=${app.version}`,
    `#type=${type}`,
    `#version=${PACKAGE_FORMAT_VERSION}`,
  ];
  for (const file of files) {
    lines.push(`${file.name};${sha256(file.bytes)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build the package: the archive entries, and the inventory text they carry.
 *
 * Entries are ordered inventory-first, then the scope record, then one update
 * document per project record in the reader's stable order (tables and files
 * sorted). The clock does not reach an entry, so an unchanged project always
 * produces the same entry bytes.
 *
 * @param {object} project — from readAppProject()
 * @param {{now?: Date}} [options]
 * @returns {{entries: Array<{name: string, bytes: Buffer}>, inventory: string}}
 */
export function buildAppPackage(project, { now = new Date() } = {}) {
  const errors = validatePackageTarget(project);
  if (errors.length) throw errInvalidProject(errors);

  // Fail on an unusable clock here rather than after the caller has started
  // writing, so "nothing was written" stays true for every rejection.
  const clock = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(clock.getTime())) {
    throw errInvalidProject(['build: the injected clock is not a valid date']);
  }

  const app = project.app;
  const files = [
    { name: scopeXmlPath(app), bytes: Buffer.from(buildScopeXml(project), 'utf8') },
    ...project.records.map(record => ({
      name: recordXmlPath(record),
      bytes: Buffer.from(buildRecordXml(record, app), 'utf8'),
    })),
  ];

  const inventory = buildInventory({ app, files });
  const entries = [
    // Every archive entry carries the leading slash, the inventory included.
    { name: `/${INVENTORY_PATH}`, bytes: Buffer.from(inventory, 'utf8') },
    ...files.map(file => ({ name: `/${file.name}`, bytes: file.bytes })),
  ];
  return { entries, inventory };
}

/**
 * The artifact bytes: entries, manifest text and the zip container.
 *
 * `jsn app build --backend package` writes this zip, and `jsn app deploy`
 * uploads it. Both call this one function, so the deployed archive is the
 * artifact the build command produces — not a second assembly of the same
 * parts that could drift.
 *
 * @param {object} project — from readAppProject()
 * @param {{now?: Date}} [options]
 * @returns {{entries: Array<{name: string, bytes: Buffer}>, inventory: string, zip: Buffer}}
 */
export function buildPackageZip(project, { now = new Date() } = {}) {
  const built = buildAppPackage(project, { now });
  return { ...built, zip: writeZip(built.entries, { now }) };
}
