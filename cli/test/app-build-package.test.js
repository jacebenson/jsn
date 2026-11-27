// Tests for the native app package backend (cli/src/app-build-package.js and
// cli/src/zip-writer.js).
//
// The assertions are made at the layer a consumer sees: the archive is read
// back from its central directory (sizes and CRCs checked), the inventory
// hashes are recomputed from the stored entry bytes, and a script is compared
// after the update document is parsed out of the archive — never against a raw
// slice of the writer's own output.
//
// Determinism is asserted by rebuilding: the same project and the same clock
// must produce identical bytes, and the clock must be the only thing that
// changes the container.
//
// The CLI cases spawn bin/jsn.js, some with a network guard installed through
// NODE_OPTIONS, so "local only" is proven rather than asserted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';
import { readAppProject } from '../src/app-project.js';
import {
  buildAppPackage, buildInventory, buildRecordXml, buildScopeXml, packageAppSysId,
  packageFileName, recordXmlPath, scopeXmlPath, validatePackageTarget,
  PACKAGE_FORMAT_VERSION,
} from '../src/app-build-package.js';
import { writeZip, crc32, dosTimestamp } from '../src/zip-writer.js';
import {
  writeAppProject, happyProjectSpec, cliEnv, TRICKY_SCRIPT, SIMPLE_INCLUDE,
  SYS_ID_A, SYS_ID_B, APP_SYS_ID, DEFAULT_APP_YAML,
  singleFileRecord, singleFileMetadata, sym,
} from './support/app-project-fixtures.js';

const CLI = path.resolve('bin/jsn.js');
const NOW = new Date('2026-11-26T12:34:56Z');

// The shared fixture app.yaml has no `app.version` (an update set needs none).
// The package backend requires one, so package cases swap in this document.
const PACKAGE_APP_YAML = DEFAULT_APP_YAML.replace('backend: update-set', '  version: 1.0.0\nbackend: package');

// ── readers ──────────────────────────────────────────────────────────────

/**
 * Read an archive through its central directory, verifying the local headers
 * agree and that every entry's CRC matches its bytes.
 *
 * This is the reader contract: an unzip tool finds entries this way, so what is
 * asserted after this function is what a consumer actually receives.
 */
function readZip(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  assert.notEqual(end, -1, 'the archive ends with an end-of-central-directory record');

  const count = buffer.readUInt16LE(end + 10);
  assert.equal(count, buffer.readUInt16LE(end + 8), 'both entry counts agree');
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `central header ${index} signature`);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name}: local header signature`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    assert.equal(buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength), name,
      `${name}: the local header names the same entry`);
    assert.equal(buffer.readUInt32LE(localOffset + 14), crc, `${name}: local and central CRC agree`);

    const start = localOffset + 30 + localNameLength + localExtraLength;
    const stored = buffer.subarray(start, start + compressedSize);
    const bytes = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(bytes.length, size, `${name}: uncompressed size matches the header`);
    assert.equal(crc32(bytes), crc, `${name}: the stored bytes match the recorded CRC`);

    entries.push({ name, bytes, method, time, date });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, centralOffset + centralSize, 'the central directory is exactly consumed');
  return entries;
}

/** Parse one record_update document into its leaf elements, in document order. */
function parseDocument(xml) {
  const parser = new SaxesParser();
  const stack = [];
  const order = [];
  const values = {};
  const attributes = {};
  let root = null;
  let record = null;

  parser.on('opentag', (tag) => {
    stack.push(tag.name);
    if (stack.length === 1) root = { name: tag.name, attributes: { ...tag.attributes } };
    if (stack.length === 2) record = { name: tag.name, attributes: { ...tag.attributes } };
    if (stack.length === 3) {
      order.push(tag.name);
      values[tag.name] = '';
      attributes[tag.name] = { ...tag.attributes };
    }
  });
  const append = (value) => { if (stack.length === 3) values[stack[2]] += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => stack.pop());
  parser.write(xml).close();
  return { root, record, order, values, attributes, hasCdata: xml.includes('CDATA') };
}

/** A validated project whose app.yaml asks for the package backend. */
function packageProject(t, overrides = {}) {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML, ...overrides }));
  return { root, project: readAppProject(root) };
}

/** Build the entry list and the archive for a project. */
function packageOf(project, now = NOW) {
  const built = buildAppPackage(project, { now });
  const zip = writeZip(built.entries, { now });
  return { ...built, zip, archive: readZip(zip) };
}

/** Entry lookup by archive name. */
function entry(archive, name) {
  const found = archive.find(item => item.name === name);
  assert.ok(found, `expected entry ${name} in ${archive.map(item => item.name).join(', ')}`);
  return found;
}

// ── archive layout ───────────────────────────────────────────────────────

test('the archive holds the inventory first, then the scope, then one update per record', (t) => {
  const { project } = packageProject(t);
  const { entries, inventory, archive } = packageOf(project);

  const expected = [
    '/package_inventory.csv',
    `/scope/sys_app_${APP_SYS_ID}.xml`,
    `/update/sys_script_${SYS_ID_A}.xml`,
    `/update/sys_script_include_${SYS_ID_B}.xml`,
  ];
  // Entry names carry a leading slash, exactly like the reference archive.
  assert.deepEqual(entries.map(item => item.name), expected);
  // The written archive preserves that order in its central directory.
  assert.deepEqual(archive.map(item => item.name), expected);
  assert.equal(entries[0].bytes.toString('utf8'), inventory);
  assert.equal(entries.length, project.records.length + 2);
});

test('the inventory names the build, the app version, the type and one hash per file', (t) => {
  const { project } = packageProject(t);
  const { entries, inventory } = packageOf(project);

  const lines = inventory.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    '#build=x_1_demo',
    '#appVersion=1.0.0',
    '#type=scoped',
    `#version=${PACKAGE_FORMAT_VERSION}`,
  ]);
  assert.equal(PACKAGE_FORMAT_VERSION, '1.0.0');

  const hashed = lines.slice(4).map(line => line.split(';'));
  assert.deepEqual(hashed.map(([name]) => name), [
    `scope/sys_app_${APP_SYS_ID}.xml`,
    `update/sys_script_${SYS_ID_A}.xml`,
    `update/sys_script_include_${SYS_ID_B}.xml`,
  ]);
  for (const [name, hash] of hashed) {
    assert.equal(name.startsWith('/'), false, 'inventory paths carry no leading slash');
    assert.match(hash, /^[a-f0-9]{64}$/);
    // Recompute from the bytes actually stored in the archive.
    const stored = entries.find(item => item.name === `/${name}`);
    assert.ok(stored, `the inventory path ${name} has a matching entry`);
    assert.equal(hash, createHash('sha256').update(stored.bytes).digest('hex'),
      `${name}: the inventory hash is the entry's own SHA-256`);
  }
});

// ── document shape ───────────────────────────────────────────────────────

test('the scope document is the reference sys_app record, byte for byte', (t) => {
  const { project } = packageProject(t);
  const { archive } = packageOf(project);
  const scope = entry(archive, `/scope/sys_app_${APP_SYS_ID}.xml`).bytes.toString('utf8');

  const expected = [
    '<?xml version="1.0"?>',
    '<record_update table="sys_app">',
    '  <sys_app action="INSERT_OR_UPDATE" apply_defaults="true">',
    `    <sys_id>${APP_SYS_ID}</sys_id>`,
    `    <sys_scope display_value="x_1_demo">${APP_SYS_ID}</sys_scope>`,
    `    <sys_update_name>sys_app_${APP_SYS_ID}</sys_update_name>`,
    '    <active>true</active>',
    '    <js_level>es_latest</js_level>',
    '    <licensable>true</licensable>',
    '    <name>Demo App</name>',
    '    <private>false</private>',
    '    <scope>x_1_demo</scope>',
    '    <source>x_1_demo</source>',
    '    <trackable>true</trackable>',
    '    <version>1.0.0</version>',
    '  </sys_app>',
    '</record_update>',
    '',
  ].join('\n');
  assert.equal(scope, expected);
});

test('an update document carries identity, scope, fields and code in a fixed order', (t) => {
  const { project } = packageProject(t);
  const { archive } = packageOf(project);

  const rule = parseDocument(entry(archive, `/update/sys_script_${SYS_ID_A}.xml`).bytes.toString('utf8'));
  assert.deepEqual(rule.root, { name: 'record_update', attributes: { table: 'sys_script' } });
  assert.deepEqual(rule.record, {
    name: 'sys_script',
    attributes: { action: 'INSERT_OR_UPDATE', apply_defaults: 'true' },
  });
  assert.deepEqual(rule.order,
    ['sys_id', 'sys_scope', 'sys_update_name', 'name', 'active', 'order', 'condition', 'script']);
  assert.equal(rule.values.sys_id, SYS_ID_A);
  assert.equal(rule.values.sys_update_name, `sys_script_${SYS_ID_A}`);
  assert.equal(rule.values.sys_scope, APP_SYS_ID, 'records scope to the application sys_id');
  assert.deepEqual(rule.attributes.sys_scope, { display_value: 'x_1_demo' });
  assert.equal(rule.values.name, 'Before Query');
  assert.equal(rule.values.active, 'true');
  assert.equal(rule.values.order, '100');
  assert.equal(rule.values.condition, 'active=true');
  assert.equal(rule.values.script, TRICKY_SCRIPT);

  const include = parseDocument(entry(archive, `/update/sys_script_include_${SYS_ID_B}.xml`).bytes.toString('utf8'));
  assert.equal(include.values.sys_scope, APP_SYS_ID);
  assert.equal(include.values.script, SIMPLE_INCLUDE);
  assert.equal(include.values.api_name, 'x_1_demo.DemoHelper');
});

test('field and script text is escaped character data, never CDATA', (t) => {
  const { project } = packageProject(t, {
    records: {
      'sys_script/before-query': {
        sys_id: SYS_ID_A,
        table: 'sys_script',
        fields: { name: 'A & B < C "quoted"', active: false, order: 0, condition: 'line one\r\nline two' },
        code: { script: 'code/before-query.js' },
      },
    },
  });
  const { archive } = packageOf(project);
  const xml = entry(archive, `/update/sys_script_${SYS_ID_A}.xml`).bytes.toString('utf8');

  assert.equal(xml.includes('CDATA'), false, 'no CDATA anywhere');
  assert.equal(xml.includes('\r'), false, 'no raw CR survives as a byte');
  assert.ok(xml.includes('<name>A &amp; B &lt; C "quoted"</name>'));
  assert.ok(xml.includes('<condition>line one&#13;\nline two</condition>'));
  assert.ok(xml.includes(']]&gt; framed'), '`]]>` travels as ordinary escaped data');

  const parsed = parseDocument(xml);
  assert.equal(parsed.values.condition, 'line one\r\nline two', 'the parser decodes the reference');
});

// ── byte-exact script transport ──────────────────────────────────────────

test('script text is byte-exact through the archive and back', (t) => {
  // Each case is a real file on disk. The assertion is on the text recovered
  // after the update document is parsed out of the zip.
  const cases = {
    'CRLF with BOM, <, &, ]]>, unicode': TRICKY_SCRIPT,
    'lone CR (not followed by LF)': 'one\rtwo\rthree',
    'mixed CRLF, LF and lone CR': 'a\r\nb\nc\rd',
    'no trailing newline': 'gs.info(1);',
    'trailing newline present': 'gs.info(1);\n',
    'empty file': '',
  };

  for (const [label, text] of Object.entries(cases)) {
    const root = writeAppProject(t, {
      appYaml: PACKAGE_APP_YAML,
      code: { 'code/rule.js': text },
      records: {
        'sys_script/rule': {
          sys_id: SYS_ID_A, table: 'sys_script', fields: { name: 'Rule' },
          code: { script: 'code/rule.js' },
        },
      },
    });
    const project = readAppProject(root);
    const { archive } = packageOf(project);

    const xml = entry(archive, `/update/sys_script_${SYS_ID_A}.xml`).bytes.toString('utf8');
    const parsed = parseDocument(xml);
    assert.equal(parsed.hasCdata, false, `${label}: no CDATA`);
    assert.equal(xml.includes('\r'), false, `${label}: the document holds no raw CR`);
    assert.equal(parsed.values.script, text, `${label}: the recovered script equals the file text`);
    assert.ok(Buffer.from(parsed.values.script, 'utf8').equals(fs.readFileSync(path.join(root, 'code/rule.js'))),
      `${label}: the recovered text re-encodes to the original file bytes`);
  }
});

test('a script authored in the single-file .js form travels the same way', (t) => {
  const root = writeAppProject(t, {
    appYaml: PACKAGE_APP_YAML,
    raw: { 'records/sys_script/rule.js': singleFileRecord(TRICKY_SCRIPT, singleFileMetadata()) },
  });
  const project = readAppProject(root);
  const { archive } = packageOf(project);
  const parsed = parseDocument(entry(archive, `/update/sys_script_${SYS_ID_A}.xml`).bytes.toString('utf8'));

  assert.equal(parsed.values.script, TRICKY_SCRIPT);
  assert.ok(parsed.values.script.startsWith('\uFEFF'), 'the BOM survives');
  assert.ok(parsed.values.script.includes('\r\n'), 'CRLF survives');
  assert.ok(parsed.values.script.includes(']]>'), '`]]>` survives');
  assert.ok(parsed.values.script.includes('中文 é'), 'unicode survives');
});

// ── determinism ──────────────────────────────────────────────────────────

test('a rebuild of an unchanged project is byte-identical', (t) => {
  const { project } = packageProject(t);
  const first = packageOf(project);
  const second = packageOf(project);

  assert.ok(first.zip.equals(second.zip), 'the archives are the same bytes');
  assert.deepEqual(first.entries.map(item => item.name), second.entries.map(item => item.name));
  first.entries.forEach((item, index) => {
    assert.ok(item.bytes.equals(second.entries[index].bytes), `${item.name}: entry bytes are stable`);
  });

  // The only clock-dependent field is the DOS timestamp, and it is a pure
  // function of the injected clock.
  assert.deepEqual(dosTimestamp(NOW), { date: 23930, time: 25692 });
  for (const item of first.archive) {
    assert.equal(item.date, 23930, `${item.name}: DOS date comes from the injected clock`);
    assert.equal(item.time, 25692, `${item.name}: DOS time comes from the injected clock`);
  }

  // A different clock changes the container and nothing else.
  const later = packageOf(project, new Date('2027-01-02T03:04:05Z'));
  assert.equal(later.zip.equals(first.zip), false, 'the timestamp is what moves');
  assert.deepEqual(later.entries.map(item => item.bytes), first.entries.map(item => item.bytes),
    'entry bytes do not depend on the clock');
});

test('the archive is deflated, self-describing, and CRC-checked', (t) => {
  const { project } = packageProject(t);
  const { archive, zip } = packageOf(project);

  assert.equal(zip.subarray(0, 4).readUInt32LE(0), 0x04034b50, 'the archive starts with a local header');
  for (const item of archive) {
    assert.equal(item.method, 8, `${item.name}: deflated`);
    assert.equal(item.name.startsWith('/'), true, `${item.name}: the entry name keeps its leading slash`);
  }
});

// ── the two record forms ─────────────────────────────────────────────────

test('a .json-form and a .js-form project produce the same package', (t) => {
  const metadata = { sys_id: SYS_ID_A, table: 'sys_script', fields: { name: 'Rule', active: true } };

  const jsonRoot = writeAppProject(t, {
    appYaml: PACKAGE_APP_YAML,
    code: { 'code/rule.js': TRICKY_SCRIPT },
    records: { 'sys_script/rule': { ...metadata, code: { script: 'code/rule.js' } } },
  });
  const jsRoot = writeAppProject(t, {
    appYaml: PACKAGE_APP_YAML,
    raw: {
      'records/sys_script/rule.js': singleFileRecord(TRICKY_SCRIPT, { ...metadata, script: sym('DemoRule') }),
    },
  });

  const fromJson = packageOf(readAppProject(jsonRoot));
  const fromJs = packageOf(readAppProject(jsRoot));

  assert.deepEqual(fromJs.entries.map(item => item.name), fromJson.entries.map(item => item.name));
  fromJson.entries.forEach((item, index) => {
    assert.ok(item.bytes.equals(fromJs.entries[index].bytes), `${item.name}: the two forms agree byte for byte`);
  });
  assert.equal(fromJs.inventory, fromJson.inventory);
  assert.ok(fromJs.zip.equals(fromJson.zip), 'the whole archive is identical');
});

// ── validation ───────────────────────────────────────────────────────────

/** A minimal valid project object, for validation cases that never touch disk. */
function bareProject(app) {
  return { app, records: [], backend: 'package', description: '', root: '/nowhere' };
}

test('a packageable project reports no problems', () => {
  assert.deepEqual(validatePackageTarget(bareProject({ name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version: '1.0.0' })), []);
  // Global needs no application sys_id: an id is derived from the identity.
  assert.deepEqual(validatePackageTarget(bareProject({ name: 'Demo', scope: 'global', version: '1.0.0' })), []);
});

const PACKAGE_REJECTIONS = [
  {
    label: 'a missing app.version',
    app: { name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID },
    error: /app\.yaml: app\.version is required for the package backend/,
  },
  {
    label: 'a blank app.version',
    app: { name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version: '   ' },
    error: /app\.yaml: app\.version is required for the package backend/,
  },
  {
    label: 'a non-string app.version',
    app: { name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version: 1 },
    error: /app\.yaml: app\.version 1 is not a packageable version/,
  },
  {
    label: 'an app.version with a path separator',
    app: { name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version: '1.0/../0' },
    error: /app\.yaml: app\.version "1\.0\/\.\.\/0" is not a packageable version/,
  },
  {
    label: 'a missing app.scope',
    app: { name: 'Demo', version: '1.0.0' },
    error: /app\.yaml: app\.scope is required to package an app/,
  },
  {
    label: 'an app.scope that is not a scope name',
    app: { name: 'Demo', scope: 'not a scope', sys_id: APP_SYS_ID, version: '1.0.0' },
    error: /app\.yaml: app\.scope "not a scope" is not a valid scope name/,
  },
  {
    label: 'a scoped app with no app.sys_id',
    app: { name: 'Demo', scope: 'x_1_demo', version: '1.0.0' },
    error: /app\.yaml: app\.sys_id is required when app\.scope is "x_1_demo"/,
  },
  {
    // Every problem is reported at once, not one per run.
    label: 'several problems at once',
    app: { name: 'Demo', scope: 'bad scope' },
    error: /app\.scope "bad scope" is not a valid scope name[\s\S]*app\.version is required/,
    also: /app\.version is required[\s\S]*app\.sys_id is required when app\.scope is "bad scope"/,
  },
];

for (const rejection of PACKAGE_REJECTIONS) {
  test(`rejects ${rejection.label}`, () => {
    const project = bareProject(rejection.app);
    const errors = validatePackageTarget(project);
    assert.ok(errors.length > 0, 'at least one problem is reported');
    assert.match(errors.join('\n'), rejection.error);
    if (rejection.also) assert.match(errors.join('\n'), rejection.also);

    assert.throws(() => buildAppPackage(project, { now: NOW }), (error) => {
      assert.equal(error.code, 'invalid_project');
      assert.match(error.message, /^Invalid app project \(\d+ errors?\):/);
      assert.match(error.message, rejection.error);
      return true;
    });
  });
}

test('a self-referencing app.version is reported, never thrown', () => {
  const version = [];
  version.push(version);
  const errors = validatePackageTarget(bareProject({ name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version })).join('\n');
  assert.match(errors, /app\.yaml: app\.version of type sequence is not a packageable version/);
});

test('an unusable clock is refused before anything is built', (t) => {
  const { project } = packageProject(t);
  assert.throws(() => buildAppPackage(project, { now: new Date('not a date') }), (error) => {
    assert.equal(error.code, 'invalid_project');
    assert.match(error.message, /the injected clock is not a valid date/);
    return true;
  });
});

test('a Global project packages with a derived application sys_id', (t) => {
  const root = writeAppProject(t, {
    appYaml: DEFAULT_APP_YAML
      .replace(`  sys_id: ${APP_SYS_ID}\n`, '')
      .replace('scope: x_1_demo', 'scope: global')
      .replace('backend: update-set', '  version: 2.1.0\nbackend: package'),
    code: { 'code/rule.js': 'gs.info(1);\n' },
    records: {
      'sys_script/rule': {
        sys_id: SYS_ID_A, table: 'sys_script', fields: { name: 'Rule' }, code: { script: 'code/rule.js' },
      },
    },
  });
  const project = readAppProject(root);
  assert.deepEqual(validatePackageTarget(project), []);

  const { project: scoped } = packageProject(t);
  const derived = packageAppSysId(project.app);
  assert.match(derived, /^[a-f0-9]{32}$/);
  assert.equal(derived, packageAppSysId(project.app), 'the derived id is stable');
  assert.notEqual(derived, packageAppSysId(scoped.app), 'two projects do not collide');

  const { entries, inventory, archive } = packageOf(project);
  assert.deepEqual(entries.map(item => item.name), [
    '/package_inventory.csv',
    `/scope/sys_app_${derived}.xml`,
    `/update/sys_script_${SYS_ID_A}.xml`,
  ]);
  assert.ok(inventory.includes('#build=global'));
  assert.ok(inventory.includes('#type=global'), 'the inventory names the scope class honestly');
  const recordXml = parseDocument(entry(archive, `/update/sys_script_${SYS_ID_A}.xml`).bytes.toString('utf8'));
  assert.equal(recordXml.values.sys_scope, derived);
  assert.deepEqual(recordXml.attributes.sys_scope, { display_value: 'global' });
});

test('the default artifact name is <scope>-<version>.zip and cannot escape the directory', (t) => {
  const { project } = packageProject(t);
  assert.equal(packageFileName(project.app), 'x_1_demo-1.0.0.zip');
  // Even a value that skipped validation is reduced to one safe path segment.
  assert.equal(packageFileName({ scope: '../evil', version: '1.0.0' }), 'evil-1.0.0.zip');
  assert.equal(packageFileName({ scope: 'x', version: 'a/b' }), 'x-a-b.zip');
});

test('the helpers agree with the entry list they are used to build', (t) => {
  const { project } = packageProject(t);
  assert.equal(scopeXmlPath(project.app), `scope/sys_app_${APP_SYS_ID}.xml`);
  assert.equal(recordXmlPath(project.records[0]), `update/sys_script_${SYS_ID_A}.xml`);
  assert.equal(buildScopeXml(project).split('\n')[1], '<record_update table="sys_app">');
  assert.ok(buildRecordXml(project.records[0], project.app).startsWith('<?xml version="1.0"?>\n<record_update table="sys_script">'));
  const inventory = buildInventory({ app: project.app, files: [{ name: 'a.xml', bytes: Buffer.from('x') }] });
  assert.match(inventory, /^#build=x_1_demo\n#appVersion=1\.0\.0\n#type=scoped\n#version=1\.0\.0\na\.xml;[a-f0-9]{64}\n$/);
});

// ── CLI ──────────────────────────────────────────────────────────────────

const NETWORK_GUARD = `
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
const marker = process.env.JSN_NET_GUARD_FILE;
fs.writeFileSync(marker, 'installed\\n');
const deny = () => {
  fs.appendFileSync(marker, 'network\\n');
  throw new Error('network access is not allowed in this local-only proof');
};
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;
`;

function guardedEnv(t, root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-guard-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const guard = path.join(scratch, 'network-guard.mjs');
  fs.writeFileSync(guard, NETWORK_GUARD);
  const marker = path.join(scratch, 'network-guard.log');
  return {
    marker,
    env: cliEnv(root, {
      NODE_OPTIONS: `--import ${pathToFileURL(guard).href}`,
      JSN_NET_GUARD_FILE: marker,
      SERVICENOW_INSTANCE_URL: 'http://127.0.0.1:1',
    }),
  };
}

test('jsn app build --backend package writes an installable zip and never takes a network path', (t) => {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-out-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const out = path.join(outDir, 'demo.zip');
  const { marker, env } = guardedEnv(t, root);

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--backend', 'package',
    '--out', out, '--json'], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'installed\n', 'the guard loaded and no transport was attempted');

  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(Object.keys(envelope.data).sort(), [
    'app', 'backend', 'bytes', 'deploy_hint', 'entries', 'out', 'records', 'scope',
    'version', 'written_to_instance',
  ]);
  assert.equal(envelope.data.app, 'Demo App');
  assert.equal(envelope.data.scope, 'x_1_demo');
  assert.equal(envelope.data.version, '1.0.0');
  assert.equal(envelope.data.backend, 'package');
  assert.equal(envelope.data.records, 2);
  assert.equal(envelope.data.entries, 4);
  assert.equal(envelope.data.written_to_instance, false);
  assert.equal(envelope.data.out, out);
  assert.match(envelope.data.deploy_hint, /Install demo\.zip on the target instance/);
  assert.match(envelope.data.deploy_hint, /Nothing was written to any instance/);

  const archive = readZip(fs.readFileSync(out));
  assert.equal(envelope.data.bytes, fs.statSync(out).size);
  assert.equal(archive.length, envelope.data.entries);
  assert.deepEqual(archive.map(item => item.name), [
    '/package_inventory.csv',
    `/scope/sys_app_${APP_SYS_ID}.xml`,
    `/update/sys_script_${SYS_ID_A}.xml`,
    `/update/sys_script_include_${SYS_ID_B}.xml`,
  ]);
});

test('jsn app build --backend package defaults --out to <scope>-<version>.zip', (t) => {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-default-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--backend', 'package', '--json'], {
    encoding: 'utf8', timeout: 30000, cwd: outDir, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);

  const artifact = path.join(outDir, 'x_1_demo-1.0.0.zip');
  assert.ok(fs.existsSync(artifact), `expected ${artifact} in ${fs.readdirSync(outDir).join(', ')}`);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.data.out, artifact);
  assert.equal(readZip(fs.readFileSync(artifact)).length, 4);
});

test('jsn app build honours the app.yaml package backend without a flag', (t) => {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-yaml-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--styled'], {
    encoding: 'utf8', timeout: 30000, cwd: outDir, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(path.join(outDir, 'x_1_demo-1.0.0.zip')));
  assert.ok(run.stdout.includes('Packaged app "Demo App" 1.0.0'), run.stdout);
  assert.ok(run.stdout.includes('Nothing was written to any instance.'), run.stdout);
});

test('jsn app build --get extracts package data and leaves the artifact in place', (t) => {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-get-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const out = path.join(outDir, 'app.zip');

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', out,
    '--backend', 'package', '--get', 'data.entries'], { encoding: 'utf8', timeout: 30000, env: cliEnv(root) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '4');
  assert.ok(fs.existsSync(out));
});

test('the package backend refuses --out - without writing anything', (t) => {
  const root = writeAppProject(t, happyProjectSpec({ appYaml: PACKAGE_APP_YAML }));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-stdout-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--backend', 'package', '--out', '-'], {
    encoding: 'utf8', timeout: 30000, cwd: outDir, env: cliEnv(root),
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(`${run.stdout}${run.stderr}`, /--out - is not supported/);
  assert.deepEqual(fs.readdirSync(outDir), [], 'nothing was written');
});

test('a project that cannot be packaged fails the CLI with exit 1 and leaves no artifact', (t) => {
  // app.yaml without app.version: the reader accepts it, the package backend
  // does not, and the refusal is the aggregated project error (exit 1).
  for (const appYaml of [
    PACKAGE_APP_YAML.replace('  version: 1.0.0\n', ''),
    PACKAGE_APP_YAML.replace('  version: 1.0.0', '  version: "1.0/0"'),
  ]) {
    const root = writeAppProject(t, happyProjectSpec({ appYaml }));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-pkg-bad-'));
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
    const out = path.join(outDir, 'app.zip');

    const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', out,
      '--backend', 'package'], { encoding: 'utf8', timeout: 30000, env: cliEnv(root) });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Error: Invalid app project \(1 error\):/);
    assert.match(run.stderr, /app\.version/);
    assert.deepEqual(fs.readdirSync(outDir), [], 'no artifact and no temp file may survive');
  }
});

test('the package backend is registered local-only, and only deploy is a mutation', async () => {
  const { buildCLI } = await import('../src/cli.js');
  const { collectCapabilities, noInstanceCommands, mutationPaths } = await import('../src/capabilities.js');
  const { isMutationCommand } = await import('../src/mutations.js');
  buildCLI([]);

  assert.equal(collectCapabilities().get('app').noInstance, true);
  assert.ok(noInstanceCommands().has('app'));
  // `build` reads a project and writes a local file; `deploy` installs it.
  assert.equal(isMutationCommand({ _: ['app', 'build'], backend: 'package' }), false);
  assert.equal(isMutationCommand({ _: ['app', 'deploy'] }), true);
  assert.deepEqual(mutationPaths().filter(pattern => pattern[0] === 'app'), [['app', 'deploy']]);
});

test('refuses the identity fields the package writer generates', () => {
  const project = {
    app: { name: 'Demo', scope: 'x_1_demo', sys_id: APP_SYS_ID, version: '1.0.0' },
    records: [{
      file: 'records/sys_script/rule.js', table: 'sys_script', sys_id: SYS_ID_A,
      fields: { name: 'Rule', sys_scope: 'global' },
      // `code` is emitted after the generated elements, so a reserved name there
      // would put the same element in the payload twice, exactly like `fields`.
      code: { sys_id: { path: null, text: 'x' }, sys_scope: { path: null, text: 'y' }, sys_update_name: { path: null, text: 'z' } },
    }],
  };
  const errors = validatePackageTarget(project).join('\n');
  // Two <sys_scope> elements, or two record ids, make a readback impossible.
  assert.match(errors, /fields\.sys_scope is written by the package backend/);
  assert.match(errors, /code\.sys_id is written by the package backend/);
  assert.match(errors, /code\.sys_scope is written by the package backend/);
  assert.match(errors, /code\.sys_update_name is written by the package backend/);
});

test('refuses surrounding whitespace in the identity it writes', () => {
  const project = { app: { name: 'Demo', scope: ' global ', sys_id: APP_SYS_ID, version: ' 1.0.0 ' }, records: [] };
  const errors = validatePackageTarget(project).join('\n');
  assert.match(errors, /app\.scope must not have leading or trailing whitespace/);
  assert.match(errors, /app\.version must not have leading or trailing whitespace/);
});
