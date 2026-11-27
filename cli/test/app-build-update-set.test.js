// Tests for the update-set writer (cli/src/app-build-update-set.js).
//
// The importer's inspector is the contract: every envelope built here is fed
// back through inspectUpdateSetXML.
//
// Byte fidelity is asserted at the layer that exists in the real path: the
// envelope is parsed as XML, the payload string is taken from it, the payload
// is parsed as XML, and the recovered element text is compared to the original
// file bytes. Script bytes are never compared against a raw payload slice — a
// string comparison would pass on a layer the platform never sees.
//
// The CLI cases spawn bin/jsn.js with a network guard installed via
// NODE_OPTIONS so "local only" is proven, not asserted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';
import { readAppProject } from '../src/app-project.js';
import {
  buildAppUpdateSet, buildUpdateSetDocument, serializeUpdateSetDocument,
  buildRecordPayload, escapeXmlText, updateSetTimestamp, derivedSysId,
} from '../src/app-build-update-set.js';
import { inspectUpdateSetXML } from '../src/update-set-xml.js';
import {
  writeAppProject, happyProjectSpec, cliEnv, TRICKY_SCRIPT, SYS_ID_A, SYS_ID_B, APP_SYS_ID,
  singleFileRecord, singleFileMetadata, sym,
} from './support/app-project-fixtures.js';

const CLI = path.resolve('bin/jsn.js');
const NOW = new Date('2026-11-26T12:34:56Z');

/**
 * A generic envelope reader: the same leaf-field shape inspectUpdateSetXML
 * allows, read back into the document model so the document can be
 * re-serialized. It deliberately does not validate — the inspector owns that.
 */
function readEnvelope(xml) {
  const parser = new SaxesParser();
  const stack = [];
  const sets = [];
  const updates = [];
  let current;
  let root;
  parser.on('opentag', (tag) => {
    stack.push(tag.name);
    if (stack.length === 1) root = { name: tag.name, attributes: { ...tag.attributes } };
    if (stack.length === 2) current = {};
    if (stack.length === 3) current[tag.name] = '';
  });
  const append = (value) => { if (stack.length === 3) current[stack[2]] += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    if (stack.length === 2) (stack[1] === 'sys_remote_update_set' ? sets : updates).push(current);
    stack.pop();
  });
  parser.write(xml).close();
  return { unload_date: root.attributes.unload_date, set: sets[0], members: updates.map(fields => ({ fields })) };
}

/**
 * Field values as the *payload* parser sees them: character references decoded,
 * CDATA (if any) concatenated with text.
 *
 * This is the real path. The payload is XML the platform parses, so anything
 * asserted here is what a consumer actually receives.
 */
function payloadFields(payload) {
  const parser = new SaxesParser();
  const stack = [];
  const fields = {};
  parser.on('opentag', (tag) => {
    stack.push(tag.name);
    if (stack.length === 3) fields[tag.name] = '';
  });
  const append = (value) => { if (stack.length === 3) fields[stack[2]] += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => stack.pop());
  parser.write(payload).close();
  return fields;
}

function buildFixtureProject(t, overrides = {}) {
  const root = writeAppProject(t, happyProjectSpec(overrides));
  return readAppProject(root);
}

/**
 * Run one script body through the whole real path and hand back what a
 * consumer would receive:
 *
 *   record → payload string → envelope XML → parse envelope → payload string
 *   → parse payload → recovered `<script>` text
 *
 * Returns the recovered text, the raw file bytes, and both intermediate
 * strings so a test can assert what the transport looks like as well.
 */
function roundTripScript(t, text) {
  const record = {
    sys_id: SYS_ID_A,
    table: 'sys_script',
    fields: { name: 'Round Trip' },
    code: { script: 'code/rule.js' },
  };
  const root = writeAppProject(t, {
    code: { 'code/rule.js': text },
    records: { 'sys_script/rule': record },
  });
  const project = readAppProject(root);
  const { xml } = buildAppUpdateSet(project, { now: NOW });
  const payload = readEnvelope(xml).members[0].fields.payload;
  return {
    xml,
    payload,
    recovered: payloadFields(payload).script,
    fileBytes: fs.readFileSync(path.join(root, 'code', 'rule.js')),
  };
}

test('builds one envelope the importer accepts, with one member per record', (t) => {
  const project = buildFixtureProject(t);
  const { xml, inspection, document } = buildAppUpdateSet(project, { now: NOW });

  // The inspector is the contract; it reads names, ids, states and payloads.
  assert.equal(inspection.name, 'Demo App');
  assert.equal(inspection.state, 'loaded');
  assert.equal(inspection.count, 2);
  assert.deepEqual(inspection.summary, [
    { table: 'sys_script', action: 'INSERT_OR_UPDATE', count: 1 },
    { table: 'sys_script_include', action: 'INSERT_OR_UPDATE', count: 1 },
  ]);
  assert.deepEqual(inspection.members.map(member => member.name), [
    `sys_script_${SYS_ID_A}`,
    `sys_script_include_${SYS_ID_B}`,
  ]);

  // Set identity: derived, stable, and a loaded retrieved set.
  assert.deepEqual(document.set, {
    name: 'Demo App',
    application: APP_SYS_ID,
    application_name: 'Demo App',
    application_scope: 'x_1_demo',
    state: 'loaded',
    remote_sys_id: derivedSysId('jsn-app-set', 'x_1_demo', 'Demo App', 'source'),
    release_date: '2026-11-26 12:34:56',
    sys_id: derivedSysId('jsn-app-set', 'x_1_demo', 'Demo App', 'retrieved'),
  });
  assert.equal(document.unload_date, '2026-11-26 12:34:56');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<unload unload_date="2026-11-26 12:34:56">\n/);
  assert.equal((xml.match(/<sys_remote_update_set /g) || []).length, 1);
  assert.equal((xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">/g) || []).length, 2);

  // Member metadata links every row back to the set.
  for (const member of inspection.members) {
    assert.notEqual(member.sys_id, document.set.sys_id);
    assert.equal(member.action, 'INSERT_OR_UPDATE');
  }
  for (const member of document.members) {
    assert.equal(member.fields.category, 'customer');
    assert.equal(member.fields.remote_update_set, document.set.sys_id);
    assert.equal(member.fields.application, APP_SYS_ID);
    assert.equal(member.fields.target_name, member.fields.name);
    assert.match(member.fields.sys_id, /^[a-f0-9]{32}$/);
  }
  assert.equal(new Set(document.members.map(member => member.fields.sys_id)).size, 2);
});

test('the payload describes the record, its fields, and its script as escaped text', (t) => {
  const project = buildFixtureProject(t);
  const payload = buildRecordPayload(project.records[0]);
  assert.match(payload, /^<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE">/);
  assert.ok(payload.includes(`<sys_id>${SYS_ID_A}</sys_id>`));
  assert.ok(payload.includes('<name>Before Query</name>'));
  assert.ok(payload.includes('<active>true</active>'));
  assert.ok(payload.includes('<order>100</order>'));
  assert.ok(payload.includes('<condition>active=true</condition>'));
  // The script is escaped character data: CR is `&#13;`, `<` is `&lt;`, `&` is
  // `&amp;`, and `]]>` needs no special case because `>` is escaped too.
  assert.ok(payload.includes(`<script>${escapeXmlText(TRICKY_SCRIPT)}</script>`));
  assert.equal(payload.includes('CDATA'), false, 'no CDATA anywhere in the payload');
  assert.ok(payload.includes(']]&gt; framed'), ']]> travels as ordinary escaped data');
  assert.equal(payload.includes('\r'), false, 'no raw CR in the payload string');
  assert.ok(payload.endsWith('</sys_script></record_update>'));

  const { xml } = buildAppUpdateSet(project, { now: NOW });
  // The payload is escaped text in the envelope, never nested elements.
  assert.ok(xml.includes('&lt;record_update table="sys_script"&gt;'));
  assert.ok(!xml.includes('<record_update'));
  assert.equal(xml.includes('CDATA'), false, 'no CDATA in the envelope either');
  // Two levels of escaping: the payload's own `&#13;` is text in the envelope.
  assert.ok(xml.includes('&amp;#13;'), 'CR survives as a reference inside the escaped payload');
});

test('a re-serialized envelope is byte-identical and still inspects', (t) => {
  const project = buildFixtureProject(t);
  const { xml } = buildAppUpdateSet(project, { now: NOW });

  const parsed = readEnvelope(xml);
  const again = serializeUpdateSetDocument(parsed);
  assert.equal(again, xml);
  assert.deepEqual(inspectUpdateSetXML(again), inspectUpdateSetXML(xml));

  // And the re-serialized payload still carries the script bytes exactly,
  // measured after the payload is parsed (the layer the platform sees).
  const payload = parsed.members[0].fields.payload;
  assert.equal(payloadFields(payload).script, TRICKY_SCRIPT);
});

test('script text round-trips through the parsed payload, not the payload string', (t) => {
  // Each case is a real file on disk; the assertion is on the text recovered
  // after parsing the envelope and then parsing the payload.
  const cases = {
    'CRLF with BOM, <, &, ]]>, unicode, trailing newline': TRICKY_SCRIPT,
    'lone CR (not followed by LF)': 'one\rtwo\rthree',
    'mixed CRLF, LF and lone CR': 'a\r\nb\nc\rd',
    'no trailing newline': 'gs.info(1);',
    'trailing newline present': 'gs.info(1);\n',
    'empty file': '',
  };

  for (const [label, text] of Object.entries(cases)) {
    const { payload, recovered, fileBytes, xml } = roundTripScript(t, text);
    assert.equal(payload.includes('CDATA'), false, `${label}: payload holds no CDATA`);
    assert.equal(xml.includes('\r'), false, `${label}: the envelope text holds no raw CR`);
    assert.equal(recovered, text, `${label}: recovered text equals the file text`);
    assert.ok(Buffer.from(recovered, 'utf8').equals(fileBytes),
      `${label}: recovered text re-encodes to the original file bytes`);
  }

  // A trailing newline is a difference, not decoration: adding one changes the
  // recovered text.
  const withNewline = roundTripScript(t, 'gs.info(1);\n').recovered;
  const withoutNewline = roundTripScript(t, 'gs.info(1);').recovered;
  assert.notEqual(withNewline, withoutNewline);
  assert.equal(withNewline.length - withoutNewline.length, 1);
});

test('field values are escaped and typed values stay literal', (t) => {
  const project = buildFixtureProject(t, {
    records: {
      'sys_script/before-query': {
        sys_id: SYS_ID_A,
        table: 'sys_script',
        fields: {
          name: 'A & B < C "quoted"',
          active: false,
          order: 0,
          condition: 'line one\r\nline two',
        },
        code: { script: 'code/before-query.js' },
      },
    },
  });
  const payload = buildRecordPayload(project.records[0]);
  assert.ok(payload.includes('<name>A &amp; B &lt; C "quoted"</name>'));
  assert.ok(payload.includes('<active>false</active>'));
  assert.ok(payload.includes('<order>0</order>'));
  assert.ok(payload.includes('<condition>line one&#13;\nline two</condition>'));

  const { xml } = buildAppUpdateSet(project, { now: NOW });
  const recovered = readEnvelope(xml).members[0].fields.payload;
  assert.equal(payloadFields(recovered).condition, 'line one\r\nline two',
    'the payload parser decodes the character reference, not lose it');
});

test('a project with app.sys_id references that scope and keeps ids deterministic', (t) => {
  const sysId = 'c'.repeat(32);
  const spec = happyProjectSpec();
  spec.appYaml = spec.appYaml.replace(`  sys_id: ${APP_SYS_ID}`, `  sys_id: ${sysId}`);
  const project = buildFixtureProject(t, spec);

  const first = buildAppUpdateSet(project, { now: NOW });
  const second = buildAppUpdateSet(project, { now: NOW });
  assert.equal(first.xml, second.xml, 'the same project and timestamp serialize identically');
  assert.equal(first.document.set.application, sysId);
  assert.ok(first.document.members.every(member => member.fields.application === sysId));

  const later = buildAppUpdateSet(project, { now: new Date('2026-12-01T00:00:00Z') });
  assert.notEqual(later.xml, first.xml);
  assert.equal(later.document.set.application, sysId);
  assert.match(first.xml, new RegExp(`<application>${sysId}</application>`));
});

test('timestamps and derived ids are stable, lowercase, ServiceNow-shaped', () => {
  assert.equal(updateSetTimestamp(new Date('2026-01-02T03:04:05Z')), '2026-01-02 03:04:05');
  assert.match(derivedSysId('a', 'b'), /^[a-f0-9]{32}$/);
  assert.equal(derivedSysId('a', 'b'), derivedSysId('a', 'b'));
  assert.notEqual(derivedSysId('a', 'b'), derivedSysId('a', 'c'));
  assert.equal(buildUpdateSetDocument({ app: { name: 'X', scope: 'global' }, records: [] }, { now: NOW }).members.length, 0);
});

test('Global is only reachable as an explicit scope, never as a fallback (#399)', () => {
  // An explicit `scope: global` needs no sys_id and serializes as Global.
  const globalDocument = buildUpdateSetDocument(
    { app: { name: 'Global App', scope: 'global' }, records: [] }, { now: NOW });
  assert.equal(globalDocument.set.application, 'global');

  // A scoped app without a sys_id has no application to reference. The writer
  // refuses instead of silently claiming Global.
  assert.throws(
    () => buildUpdateSetDocument({ app: { name: 'Scoped App', scope: 'x_1_demo' }, records: [] }, { now: NOW }),
    (error) => {
      assert.equal(error.code, 'writer_error');
      assert.match(error.message, /app\.scope "x_1_demo" has no app\.sys_id/);
      return true;
    },
  );
});

// ── single-file records ──────────────────────────────────────────────────

test('a single-file record builds the same envelope as the equivalent .json record', (t) => {
  const metadata = {
    sys_id: SYS_ID_A,
    table: 'sys_script',
    fields: { name: 'Before Query', active: true, order: 100, condition: 'active=true' },
  };
  const jsonRoot = writeAppProject(t, {
    code: { 'code/before-query.js': TRICKY_SCRIPT },
    records: { 'sys_script/before-query': { ...metadata, code: { script: 'code/before-query.js' } } },
  });
  const jsRoot = writeAppProject(t, {
    raw: {
      'records/sys_script/before-query.js':
        singleFileRecord(TRICKY_SCRIPT, { ...metadata, script: sym('DemoRule') }),
    },
  });

  const fromJson = buildAppUpdateSet(readAppProject(jsonRoot), { now: NOW });
  const fromJs = buildAppUpdateSet(readAppProject(jsRoot), { now: NOW });
  assert.equal(fromJs.xml, fromJson.xml, 'the two forms serialize to the same bytes');
  assert.deepEqual(fromJs.inspection, fromJson.inspection);
  assert.deepEqual(fromJs.document, fromJson.document);
});

test('a named script reaches the parsed payload byte for byte', (t) => {
  // The assertion is on the text recovered after the envelope is parsed and
  // then the payload is parsed — the layer a consumer actually sees.
  const root = writeAppProject(t, {
    raw: { 'records/sys_script/rule.js': singleFileRecord(TRICKY_SCRIPT, singleFileMetadata()) },
  });
  const { xml } = buildAppUpdateSet(readAppProject(root), { now: NOW });
  const payload = readEnvelope(xml).members[0].fields.payload;
  const recovered = payloadFields(payload).script;

  assert.equal(recovered, TRICKY_SCRIPT);
  assert.ok(recovered.startsWith('\uFEFF'), 'the BOM survives');
  assert.ok(recovered.includes('\r\n'), 'CRLF survives');
  assert.ok(recovered.includes(']]>'), '`]]>` survives');
  assert.ok(recovered.includes('中文 é'), 'unicode survives');

  const file = fs.readFileSync(path.join(root, 'records/sys_script/rule.js'));
  assert.ok(Buffer.from(recovered, 'utf8').equals(file.subarray(0, Buffer.byteLength(recovered, 'utf8'))),
    'the recovered text is a byte-exact prefix of the record file');
  assert.equal(payload.includes('CDATA'), false, 'no CDATA was introduced');
});

test('script as a path and as a one-liner reach the payload too', (t) => {
  const pathRoot = writeAppProject(t, {
    code: { 'shared/laptop-utils.js': 'gs.info("from a file");\n' },
    raw: {
      'records/sys_script_include/laptop-utils.js': singleFileRecord('',
        { sys_id: SYS_ID_B, table: 'sys_script_include', fields: { name: 'LaptopUtils' },
          script: './shared/laptop-utils.js' }),
    },
  });
  const pathPayload = readEnvelope(
    buildAppUpdateSet(readAppProject(pathRoot), { now: NOW }).xml).members[0].fields.payload;
  assert.equal(payloadFields(pathPayload).script, 'gs.info("from a file");\n');

  const inlineRoot = writeAppProject(t, {
    raw: {
      'records/sys_script/rule.js': singleFileRecord('',
        singleFileMetadata({ script: 'gs.info("a one-liner");' })),
    },
  });
  const inlinePayload = readEnvelope(
    buildAppUpdateSet(readAppProject(inlineRoot), { now: NOW }).xml).members[0].fields.payload;
  assert.equal(payloadFields(inlinePayload).script, 'gs.info("a one-liner");');
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-guard-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const guard = path.join(scratch, 'network-guard.mjs');
  fs.writeFileSync(guard, NETWORK_GUARD);
  const marker = path.join(scratch, 'network-guard.log');
  return {
    marker,
    env: cliEnv(root, {
      NODE_OPTIONS: `--import ${pathToFileURL(guard).href}`,
      JSN_NET_GUARD_FILE: marker,
      // A black-hole instance: any instance call would fail *and* be recorded.
      SERVICENOW_INSTANCE_URL: 'http://127.0.0.1:1',
    }),
  };
}

test('jsn app build --out - --json emits the envelope and never takes a network path', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const { marker, env } = guardedEnv(t, root);

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', '-', '--json'], {
    encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'installed\n',
    'the guard loaded and no HTTP transport was attempted');

  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(Object.keys(envelope.data).sort(), [
    'app', 'backend', 'bytes', 'out', 'scope', 'update_set', 'updates', 'written_to_instance', 'xml',
  ]);
  assert.equal(envelope.data.app, 'Demo App');
  assert.equal(envelope.data.scope, 'x_1_demo');
  assert.equal(envelope.data.backend, 'update-set');
  assert.equal(envelope.data.updates, 2);
  assert.equal(envelope.data.out, null);
  assert.equal(envelope.data.written_to_instance, false);
  assert.deepEqual(Object.keys(envelope.data.update_set).sort(), ['name', 'remote_sys_id', 'state', 'sys_id']);
  assert.equal(envelope.data.bytes, Buffer.byteLength(envelope.data.xml, 'utf8'));
  assert.equal(inspectUpdateSetXML(envelope.data.xml).count, 2);
});

test('jsn app build --out - prints raw XML and nothing else', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', '-'], {
    encoding: 'utf8', timeout: 30000, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), run.stdout.slice(0, 80));
  assert.equal(run.stdout.includes('written to any instance'), false);
  assert.equal(inspectUpdateSetXML(run.stdout).count, 2);
});

test('jsn app build writes the artifact, names the promotion commands, and says nothing reached an instance', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-out-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  // No --out: the artifact is auto-named in the working directory.
  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--styled'], {
    encoding: 'utf8', timeout: 30000, cwd: outDir, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);
  const artifact = path.join(outDir, 'Demo-App.xml');
  assert.ok(fs.existsSync(artifact), `expected ${artifact}`);
  assert.equal(inspectUpdateSetXML(fs.readFileSync(artifact, 'utf8')).count, 2);

  assert.ok(run.stdout.includes(artifact), run.stdout);
  // The emitted command quotes the path only when the shell needs it, so a
  // Windows path (backslashes) arrives quoted and a POSIX temp path does not.
  const emitted = run.stdout.replaceAll("'", '');
  assert.ok(emitted.includes(`jsn updatesets import ${artifact}`), run.stdout);
  assert.ok(run.stdout.includes('Nothing was written to any instance.'), run.stdout);
});

test('jsn app build honours --get and leaves no file behind on a rejected build', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-get-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', path.join(outDir, 'app.xml'), '--get', 'data.updates'], {
    encoding: 'utf8', timeout: 30000, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '2');
  assert.ok(fs.existsSync(path.join(outDir, 'app.xml')));
});

test('jsn app build accepts the single-file record form end to end', (t) => {
  const body = "var LaptopUtils = Class.create();\n"
    + 'LaptopUtils.prototype.isStandard = function (model) {\n'
    + "  return ['T14', 'X1'].indexOf(model) > -1;\n"
    + '};\n';
  const source = `${body}\nexport default {\n`
    + `  sys_id: '${SYS_ID_A}',\n`
    + "  table: 'sys_script_include',\n"
    + "  fields: { name: 'LaptopUtils', active: 'true', access: 'package_private' },\n"
    + '  script: LaptopUtils,\n'
    + '};\n';
  const root = writeAppProject(t, {
    raw: { 'records/sys_script_include/LaptopUtils.js': source },
  });

  const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', '-', '--json'], {
    encoding: 'utf8', timeout: 30000, env: cliEnv(root),
  });
  assert.equal(run.status, 0, run.stderr);

  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.data.updates, 1);
  const inspection = inspectUpdateSetXML(envelope.data.xml);
  assert.equal(inspection.count, 1);
  const payload = readEnvelope(envelope.data.xml).members[0].fields.payload;
  const fields = payloadFields(payload);
  assert.equal(fields.name, 'LaptopUtils');
  assert.equal(fields.active, 'true');
  assert.equal(fields.access, 'package_private');
  assert.equal(fields.script, body);
});

test('an unknown backend is refused explicitly, never silently downgraded to update-set', (t) => {
  // `package` is implemented (cli/test/app-build-package.test.js); a backend
  // this build does not know must still fail as a usage error, not fall back to
  // the update-set writer.
  const root = writeAppProject(t, happyProjectSpec());
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-package-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const out = path.join(outDir, 'app.xml');

  for (const backend of ['bundle', 'zip']) {
    const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', out,
      '--backend', backend], { encoding: 'utf8', timeout: 30000, env: cliEnv(root) });
    assert.equal(run.status, 2, run.stderr);
    // A piped run renders usage failures as the machine envelope on stdout,
    // where the quotes around the name are JSON-escaped.
    const output = `${run.stdout}${run.stderr}`;
    assert.match(output, /Unknown backend/, output);
    assert.ok(output.includes(backend), `${backend} is named in the refusal: ${output}`);
    assert.match(output, /Supported: update-set, package/, output);
    assert.equal(fs.existsSync(out), false);
  }
});

test('jsn app build is registered local-only and is not a mutation', async () => {
  const { buildCLI } = await import('../src/cli.js');
  const { collectCapabilities, noInstanceCommands, mutationPaths } = await import('../src/capabilities.js');
  const { isMutationCommand } = await import('../src/mutations.js');
  buildCLI([]);

  const app = collectCapabilities().get('app');
  // Building is local-only; deploying installs a package and is a mutation.
  assert.equal(app.noInstance, true);
  assert.deepEqual(app.mutationSubcommands, ['deploy']);
  assert.ok(noInstanceCommands().has('app'));
  assert.deepEqual(mutationPaths().filter(pattern => pattern[0] === 'app'), [['app', 'deploy']]);
  assert.equal(isMutationCommand({ _: ['app', 'build'] }), false);
  assert.equal(isMutationCommand({ _: ['app', 'deploy'] }), true);
});
