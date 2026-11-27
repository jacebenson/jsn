// Serialize a validated app project into one update-set export envelope.
//
// The output is the "retrieved update set" XML that `jsn updatesets import`
// already understands: one `<unload>` root, exactly one
// `sys_remote_update_set` row in state `loaded`, and one `sys_update_xml`
// member per project record. `inspectUpdateSetXML` (update-set-xml.js) is the
// contract — this writer runs it over its own output before returning, so a
// project that validates always produces an envelope the importer accepts.
//
// Cell text (fields and lifted scripts) is escaped text character data, not
// CDATA: the payload is parsed as XML by the platform, and XML end-of-line
// normalization would turn a literal CR into LF before any consumer saw it.
// Escaping keeps CR as `&#13;`, which is exempt from that normalization.
//
// Nothing here contacts an instance; the artifact is a local file.

import { createHash } from 'node:crypto';
import { inspectUpdateSetXML } from './update-set-xml.js';
import { AppError } from './errors.js';

// Element order is part of the output format: a document serializes the same
// way every time, and a parsed-then-reserialized document is byte-identical.
export const SET_FIELD_ORDER = Object.freeze([
  'name', 'application', 'application_name', 'application_scope', 'state',
  'remote_sys_id', 'release_date', 'sys_id',
]);
export const MEMBER_FIELD_ORDER = Object.freeze([
  'sys_id', 'name', 'category', 'action', 'application', 'remote_update_set',
  'target_name', 'payload',
]);

const HEX = /^[a-f0-9]{32}$/;

/** ServiceNow export timestamp: `YYYY-MM-DD HH:MM:SS` in UTC. */
export function updateSetTimestamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = part => String(part).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} `
    + `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

/**
 * A deterministic 32-hex sys_id for a value that has no instance identity.
 *
 * Imported rows need their own sys_id; deriving it from the project identity
 * keeps repeated builds of the same project byte-identical and keeps two
 * projects from colliding.
 */
export function derivedSysId(...parts) {
  return createHash('sha1').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Escape text for XML character data. Carriage returns survive as `&#13;`.
 *
 * XML end-of-line normalization rewrites a literal CR (or CRLF) to LF on input,
 * wherever it appears — including inside CDATA. Only a character reference is
 * exempt, so anything that must be byte-exact has to travel this way.
 */
export function escapeXmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

/** Escape a value used inside double quotes. */
export function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;');
}

/**
 * The inert `<record_update>` document for one record, as a plain string.
 *
 * Cell text — including lifted script bodies — is emitted as escaped text
 * character data, never CDATA: the payload is itself XML that the platform
 * parses, and XML normalizes a literal CR inside CDATA to LF before any
 * consumer sees it. Escaped data has no such hazard (`]]>` becomes `]]&gt;`,
 * so the CDATA terminator needs no special case), and a CR stays a `&#13;`
 * character reference all the way through.
 *
 * `payload` is escaped once more when it is placed in the envelope: the
 * inspector reads it as text, never as nested envelope elements.
 */
export function buildRecordPayload(record) {
  const table = record.table;
  const parts = [
    `<record_update table="${escapeXmlAttribute(table)}">`,
    `<${table} action="INSERT_OR_UPDATE">`,
    `<sys_id>${escapeXmlText(record.sys_id)}</sys_id>`,
  ];
  for (const [name, value] of Object.entries(record.fields)) {
    if (name === 'sys_id') continue; // emitted once, from the record identity
    parts.push(`<${name}>${escapeXmlText(value)}</${name}>`);
  }
  for (const [name, entry] of Object.entries(record.code)) {
    parts.push(`<${name}>${escapeXmlText(entry.text)}</${name}>`);
  }
  parts.push(`</${table}>`, '</record_update>');
  return parts.join('');
}

/**
 * A stable fingerprint of everything the set carries.
 *
 * The instance keeps an update set by its sys_id, and `importUpdateSet`
 * answers `already_loaded` for one it already holds. An identity derived only
 * from the app name and scope therefore made a rebuilt set with a changed
 * script unimportable: the target kept the first payload. The fingerprint
 * keeps an identical retry idempotent while a changed build is a new set.
 */
export function contentFingerprint(records) {
  const canonical = records.map(record => [
    record.table,
    record.sys_id,
    Object.entries(record.fields ?? {}).map(([name, value]) => [name, String(value)]),
    Object.entries(record.code ?? {}).map(([name, entry]) => [name, entry.text]),
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function uniqueSysId(seed, used) {
  let attempt = 0;
  for (;;) {
    const candidate = attempt === 0 ? derivedSysId(seed) : derivedSysId(seed, String(attempt));
    if (HEX.test(candidate) && !used.has(candidate)) return candidate;
    attempt += 1;
  }
}

/**
 * The `<application>` reference for the set and for every member.
 *
 * Issue #399 makes Global an explicit project target: a scoped app must name
 * its application sys_id, so there is no implicit fallback here. Validation
 * rejects a scoped project without one; reaching this throw means a caller
 * bypassed validation, not a project problem.
 */
function applicationReference(app) {
  if (app.sys_id) return app.sys_id;
  if (app.scope === 'global') return 'global';
  throw new AppError('writer_error',
    `app.scope "${app.scope}" has no app.sys_id`,
    'A scoped app must name its application sys_id; Global is never an implicit fallback. '
    + 'This is a jsn defect, not a project problem. Nothing was written.');
}

/**
 * Build the envelope document model (no XML text yet).
 *
 * @param {object} project — from readAppProject()
 * @param {{now?: Date}} [options]
 * @returns {{unload_date: string, set: object, members: Array<{fields: object}>}}
 */
export function buildUpdateSetDocument(project, { now = new Date() } = {}) {
  const timestamp = updateSetTimestamp(now);
  const name = project.app.name;
  const application = applicationReference(project.app);
  // Content-scoped identity: a changed build gets a new set, an identical one
  // keeps its id and stays idempotent on re-import.
  const fingerprint = contentFingerprint(project.records);
  const setSysId = derivedSysId('jsn-app-set', project.app.scope, name, 'retrieved', fingerprint);
  const remoteSysId = derivedSysId('jsn-app-set', project.app.scope, name, 'source', fingerprint);
  const used = new Set([setSysId]);

  const members = project.records.map(record => {
    // Member ids carry the export identity too: a renamed app changes the set
    // ids, and members seeded only by record identity would already exist.
    const memberId = uniqueSysId(`jsn-app-member:${fingerprint}:${record.table}:${record.sys_id}`, used);
    used.add(memberId);
    return {
      fields: {
        sys_id: memberId,
        name: `${record.table}_${record.sys_id}`,
        category: 'customer',
        action: 'INSERT_OR_UPDATE',
        application,
        remote_update_set: setSysId,
        target_name: `${record.table}_${record.sys_id}`,
        payload: buildRecordPayload(record),
      },
    };
  });

  return {
    unload_date: timestamp,
    set: {
      name,
      application,
      application_name: name,
      application_scope: project.app.scope,
      state: 'loaded',
      remote_sys_id: remoteSysId,
      release_date: timestamp,
      sys_id: setSysId,
    },
    members,
  };
}

/** Serialize an envelope document model to XML text. */
export function serializeUpdateSetDocument(document) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<unload unload_date="${escapeXmlAttribute(document.unload_date)}">`,
    '  <sys_remote_update_set action="INSERT_OR_UPDATE">'];
  for (const key of SET_FIELD_ORDER) {
    const value = document.set?.[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`    <${key}>${escapeXmlText(value)}</${key}>`);
  }
  lines.push('  </sys_remote_update_set>');
  for (const member of document.members) {
    lines.push('  <sys_update_xml action="INSERT_OR_UPDATE">');
    for (const key of MEMBER_FIELD_ORDER) {
      const value = member.fields?.[key];
      if (value === undefined || value === null || value === '') continue;
      lines.push(`    <${key}>${escapeXmlText(value)}</${key}>`);
    }
    lines.push('  </sys_update_xml>');
  }
  lines.push('</unload>', '');
  return lines.join('\n');
}

/**
 * Build and self-check one update-set export envelope for a project.
 *
 * @param {object} project — from readAppProject()
 * @param {{now?: Date}} [options]
 * @returns {{xml: string, document: object, inspection: object}}
 */
export function buildAppUpdateSet(project, { now = new Date() } = {}) {
  const document = buildUpdateSetDocument(project, { now });
  const xml = serializeUpdateSetDocument(document);
  try {
    return { xml, document, inspection: inspectUpdateSetXML(xml) };
  } catch (error) {
    // A validated project can only reach this through a writer defect: the
    // importer contract rejected output this module produced.
    throw new AppError('writer_error',
      `Generated update set XML failed the importer contract: ${error.message}`,
      'This is a jsn defect, not a project problem. Nothing was written.',
      0, error);
  }
}
