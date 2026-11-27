// Tests for the app-project record format (cli/src/app-project.js).
//
// Every fixture is a real directory on disk; validation is asserted on the
// aggregated error list, and the command-level cases additionally prove that a
// rejected build leaves no artifact behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readAppProject, validateAppProject } from '../src/app-project.js';
import {
  SYS_ID_A, SYS_ID_B, APP_SYS_ID, DEFAULT_APP_YAML, TRICKY_SCRIPT, SIMPLE_INCLUDE,
  happyProjectSpec, writeAppProject, cliEnv, singleFileRecord, singleFileMetadata, sym, serializeMetadata,
} from './support/app-project-fixtures.js';

const CLI = path.resolve('bin/jsn.js');
const JS_RULE = 'records/sys_script/rule.js';

/** A project holding one single-file record and nothing else. */
function jsProject(body, metadata) {
  return { raw: { [JS_RULE]: singleFileRecord(body, metadata) } };
}

function expectInvalid(root, pattern) {
  return assert.throws(() => readAppProject(root), (error) => {
    assert.equal(error.code, 'invalid_project');
    assert.match(error.message, pattern);
    return true;
  });
}

test('reads app.yaml and every record, resolving each code file', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const project = readAppProject(root);

  assert.deepEqual(project.app, { name: 'Demo App', scope: 'x_1_demo', sys_id: APP_SYS_ID });
  assert.equal(project.backend, 'update-set');
  assert.equal(project.description, 'Demo app for tests');
  assert.deepEqual(project.records.map(record => `${record.table}/${record.slug}`),
    ['sys_script/before-query', 'sys_script_include/demo-helper']);

  const [rule, include] = project.records;
  assert.equal(rule.sys_id, SYS_ID_A);
  assert.deepEqual(rule.fields, { name: 'Before Query', active: true, order: 100, condition: 'active=true' });
  assert.deepEqual(Object.keys(rule.code), ['script']);
  assert.equal(rule.code.script.path, 'code/before-query.js');
  assert.equal(include.sys_id, SYS_ID_B);
  assert.deepEqual(include.fields, { name: 'DemoHelper', api_name: 'x_1_demo.DemoHelper' });
});

test('code text is byte-for-byte: BOM, CRLF, unicode, <, &, and ]]>', (t) => {
  const root = writeAppProject(t, happyProjectSpec());
  const project = readAppProject(root);
  const text = project.records.find(record => record.slug === 'before-query').code.script.text;

  assert.ok(text.startsWith('\uFEFF'), 'the leading BOM is preserved');
  assert.ok(text.includes('\r\n'), 'CRLF line endings are preserved');
  assert.ok(text.includes(']]>'), 'the `]]>` sequence survives as ordinary data');
  assert.ok(text.includes('\u4e2d\u6587 \u00e9'), 'non-ASCII characters are preserved');
  assert.ok(Buffer.from(text, 'utf8').equals(fs.readFileSync(path.join(root, 'code', 'before-query.js'))),
    're-encoding the returned text matches the file bytes');
  assert.equal(text, TRICKY_SCRIPT);
});

test('a trailing newline is neither added nor removed', (t) => {
  const root = writeAppProject(t, { code: { 'code/rule.js': 'no trailing newline' }, records: oneRecord() });
  const project = readAppProject(root);
  assert.equal(project.records[0].code.script.text, 'no trailing newline');
});

test('validation reports every error in one ordered list', (t) => {
  const root = writeAppProject(t, {
    appYaml: 'version: 2\napp:\n  name: ""\n  scope: ""\nbackend: nope\nmystery: 1\n',
    records: {
      'sys_script/before-query': {
        sys_id: 'not-a-sys-id',
        table: 'sys_script',
        fields: { script: 'x' },
        code: { script: 'code/missing.js' },
      },
    },
    raw: { 'records/sys_script/broken.json': '{ nope' },
  });

  const { project, errors } = validateAppProject(root);
  assert.equal(project, null);
  const expected = [
    'app.yaml: unknown key "mystery"',
    'app.yaml: version must be 1',
    'app.yaml: app.name is required',
    'app.yaml: app.scope is required',
    'app.yaml: backend must be one of: update-set, package',
    'records/sys_script/before-query.json: sys_id must be 32 lowercase hexadecimal characters',
    'records/sys_script/before-query.json: field "script" is defined in both fields and code',
    'records/sys_script/before-query.json: code.script file not found: code/missing.js (ENOENT)',
    'records/sys_script/broken.json: invalid JSON',
  ];
  assert.equal(errors.length, expected.length, errors.join('\n'));
  expected.forEach((prefix, index) => {
    assert.ok(errors[index].startsWith(prefix), `${index}: ${errors[index]} does not start with ${prefix}`);
  });

  assert.throws(() => readAppProject(root), (error) => {
    assert.equal(error.code, 'invalid_project');
    assert.equal(error.errors.length, expected.length);
    assert.match(error.message, /^Invalid app project \(9 errors\):/);
    for (const line of errors) assert.ok(error.message.includes(line), `missing: ${line}`);
    return true;
  });
});

const baseRecord = {
  sys_id: SYS_ID_A,
  table: 'sys_script',
  fields: { name: 'Rule' },
  code: { script: 'code/rule.js' },
};
const baseCode = { 'code/rule.js': 'gs.info(1);\n' };
const oneRecord = (patch = {}) => ({ 'sys_script/rule': { ...baseRecord, ...patch } });

const REJECTIONS = [
  {
    label: 'missing app.yaml',
    spec: { appYaml: null, code: baseCode, records: oneRecord() },
    error: /app\.yaml: cannot read app\.yaml \(ENOENT\)/,
  },
  {
    label: 'unreadable app.yaml (a directory)',
    spec: { code: baseCode, records: oneRecord() },
    setup: root => {
      fs.rmSync(path.join(root, 'app.yaml'), { force: true });
      fs.mkdirSync(path.join(root, 'app.yaml'));
    },
    error: /app\.yaml: cannot read app\.yaml \(EISDIR\)/,
  },
  {
    label: 'invalid app.yaml YAML',
    spec: { appYaml: 'version: [unclosed\n', code: baseCode, records: oneRecord() },
    error: /app\.yaml: invalid YAML/,
  },
  {
    label: 'app.yaml is not a mapping',
    spec: { appYaml: '- one\n- two\n', code: baseCode, records: oneRecord() },
    error: /app\.yaml: expected a mapping/,
  },
  {
    label: 'unknown app.yaml key',
    spec: { appYaml: `${DEFAULT_APP_YAML}owner: someone\n`, code: baseCode, records: oneRecord() },
    error: /app\.yaml: unknown key "owner"/,
  },
  {
    label: 'unknown app key',
    spec: { appYaml: DEFAULT_APP_YAML.replace('scope: x_1_demo', 'scope: x_1_demo\n  owner: someone'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: unknown app key "owner"/,
  },
  {
    label: 'version is not 1',
    spec: { appYaml: DEFAULT_APP_YAML.replace('version: 1', 'version: 2'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: version must be 1/,
  },
  {
    label: 'missing app.name',
    spec: { appYaml: DEFAULT_APP_YAML.replace('  name: Demo App\n', '  name: ""\n'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.name is required/,
  },
  {
    label: 'missing app.scope',
    spec: { appYaml: DEFAULT_APP_YAML.replace('  scope: x_1_demo\n', ''), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.scope is required/,
  },
  {
    label: 'invalid app.sys_id',
    spec: { appYaml: DEFAULT_APP_YAML.replace(`  sys_id: ${APP_SYS_ID}`, '  sys_id: NOT-A-SYS-ID'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.sys_id must be 32 lowercase hexadecimal characters/,
  },
  {
    // Issue #399: a scoped app without an application sys_id must not fall
    // back to Global silently.
    label: 'scoped app without app.sys_id',
    spec: {
      appYaml: DEFAULT_APP_YAML.replace(`  sys_id: ${APP_SYS_ID}\n`, ''),
      code: baseCode,
      records: oneRecord(),
    },
    error: /app\.yaml: app\.sys_id is required when app\.scope is "x_1_demo": a scoped app must name its application sys_id \(Global is never an implicit fallback\)/,
  },
  {
    label: 'scoped app with an empty app.sys_id',
    spec: {
      appYaml: DEFAULT_APP_YAML.replace(`  sys_id: ${APP_SYS_ID}`, '  sys_id: ""'),
      code: baseCode,
      records: oneRecord(),
    },
    error: /app\.yaml: app\.sys_id is required when app\.scope is "x_1_demo"/,
  },
  {
    label: 'unknown backend',
    spec: { appYaml: DEFAULT_APP_YAML.replace('backend: update-set', 'backend: bundle'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: backend must be one of: update-set, package/,
  },
  {
    label: 'missing records directory',
    spec: { appYaml: DEFAULT_APP_YAML, code: baseCode, recordsDir: false },
    error: /records: directory is missing or unreadable \(ENOENT\)/,
  },
  {
    label: 'record is not a JSON object',
    spec: { code: baseCode, records: {}, raw: { 'records/sys_script/rule.json': '[]' } },
    error: /records\/sys_script\/rule\.json: expected a JSON object/,
  },
  {
    label: 'unknown record key',
    spec: { code: baseCode, records: oneRecord({ notes: 'extra' }) },
    error: /records\/sys_script\/rule\.json: unknown key "notes"/,
  },
  {
    label: 'invalid record sys_id',
    spec: { code: baseCode, records: oneRecord({ sys_id: SYS_ID_A.toUpperCase() }) },
    error: /records\/sys_script\/rule\.json: sys_id must be 32 lowercase hexadecimal characters/,
  },
  {
    label: 'missing record sys_id',
    spec: { code: baseCode, records: oneRecord({ sys_id: undefined }) },
    error: /records\/sys_script\/rule\.json: sys_id must be 32 lowercase hexadecimal characters/,
  },
  {
    label: 'duplicate sys_id',
    spec: {
      code: baseCode,
      records: { ...oneRecord(), 'sys_script_include/second': { ...baseRecord, table: 'sys_script_include' } },
    },
    error: /records\/sys_script_include\/second\.json: duplicate sys_id a{32} \(already used by records\/sys_script\/rule\.json\)/,
  },
  {
    label: 'missing table',
    spec: { code: baseCode, records: oneRecord({ table: undefined }) },
    error: /records\/sys_script\/rule\.json: table is required/,
  },
  {
    label: 'table does not match the directory',
    spec: { code: baseCode, records: oneRecord({ table: 'sys_script_include' }) },
    error: /records\/sys_script\/rule\.json: table "sys_script_include" does not match its directory records\/sys_script/,
  },
  {
    label: 'invalid table directory name',
    spec: { code: baseCode, records: { 'Sys Script/rule': { ...baseRecord, table: 'Sys Script' } } },
    error: /records\/Sys Script\/rule\.json: table "Sys Script" is not a valid table name/,
  },
  {
    label: 'fields is not an object',
    spec: { code: baseCode, records: oneRecord({ fields: [] }) },
    error: /records\/sys_script\/rule\.json: fields must be an object/,
  },
  {
    label: 'field value is not a scalar',
    spec: { code: baseCode, records: oneRecord({ fields: { payload: { nested: true } } }) },
    error: /records\/sys_script\/rule\.json: field "payload" must be a string, number, or boolean/,
  },
  {
    label: 'invalid field name',
    spec: { code: baseCode, records: oneRecord({ fields: { 'bad name': 'x' } }) },
    error: /records\/sys_script\/rule\.json: field "bad name" is not a valid field name/,
  },
  {
    // A YAML number is not an id; it is reported once, as its own diagnostic.
    label: 'app.sys_id that is not a string',
    spec: { appYaml: DEFAULT_APP_YAML.replace(`  sys_id: ${APP_SYS_ID}`, '  sys_id: 1234'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.sys_id must be 32 lowercase hexadecimal characters/,
  },
  {
    label: 'a field holding a character XML cannot represent',
    spec: { code: baseCode, records: oneRecord({ fields: { name: 'Rule\u0000' } }) },
    error: /records\/sys_script\/rule\.json: field "name" contains U\+0000, which XML cannot represent/,
  },
  {
    // app.name and the normalized app.scope are written into <sys_app>; the
    // scope also becomes the display_value attribute of every record's scope.
    label: 'an app.name holding a character XML cannot represent',
    spec: { appYaml: DEFAULT_APP_YAML.replace('  name: Demo App', '  name: "Demo \\0 App"'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.name contains U\+0000, which XML cannot represent/,
  },
  {
    label: 'an app.scope holding a character XML cannot represent',
    spec: { appYaml: DEFAULT_APP_YAML.replace('  scope: x_1_demo', '  scope: "x_1_\\0demo"'), code: baseCode, records: oneRecord() },
    error: /app\.yaml: app\.scope contains U\+0000, which XML cannot represent/,
  },
  {
    label: 'a code file holding a character XML cannot represent',
    spec: { code: { 'code/rule.js': 'gs.info(1);\u0001' }, records: oneRecord() },
    error: /records\/sys_script\/rule\.json: code\.script contains U\+0001, which XML cannot represent/,
  },
  {
    // app.yaml names the application row, so a record may not claim its id.
    label: 'a record reusing the app sys_id',
    spec: { code: baseCode, records: oneRecord({ sys_id: APP_SYS_ID }) },
    error: new RegExp(`records/sys_script/rule\\.json: duplicate sys_id d{32} \\(already used by app\\.yaml\\)`),
  },
  {
    label: 'field defined in both fields and code',
    spec: { code: baseCode, records: oneRecord({ fields: { name: 'Rule', script: 'stale copy' } }) },
    error: /records\/sys_script\/rule\.json: field "script" is defined in both fields and code/,
  },
  {
    // Both writers emit <sys_id> from the identity; a second one in code would
    // put the element in the payload twice.
    label: 'a code field named sys_id',
    spec: { code: baseCode, records: oneRecord({ code: { sys_id: 'code/rule.js' } }) },
    error: /records\/sys_script\/rule\.json: code\.sys_id is written from the record identity; remove it from the record/,
  },
  {
    label: 'code is not an object',
    spec: { code: baseCode, records: oneRecord({ code: 'code/rule.js' }) },
    error: /records\/sys_script\/rule\.json: code must be an object/,
  },
  {
    label: 'absolute code path',
    spec: { code: baseCode, records: oneRecord({ code: { script: '/etc/passwd.js' } }) },
    error: /records\/sys_script\/rule\.json: code\.script must be relative to the project root, not absolute \(/,
  },
  {
    label: 'code path escapes the project root',
    spec: { code: baseCode, records: oneRecord({ code: { script: '../outside.js' } }) },
    error: /records\/sys_script\/rule\.json: code\.script escapes the project root \(\.\.\/outside\.js\)/,
  },
  {
    label: 'code path is not a .js file',
    spec: { code: { 'code/rule.txt': 'gs.info(1);\n' }, records: oneRecord({ code: { script: 'code/rule.txt' } }) },
    error: /records\/sys_script\/rule\.json: code\.script must point to a \.js file \(code\/rule\.txt\)/,
  },
  {
    label: 'code path is missing',
    spec: { code: {}, records: oneRecord() },
    error: /records\/sys_script\/rule\.json: code\.script file not found: code\/rule\.js \(ENOENT\)/,
  },
  // ── single-file records (`.js` record form) ────────────────────────────
  {
    label: 'a .js record with no default export',
    spec: { raw: { [JS_RULE]: 'var x = 1;\n' } },
    error: /records\/sys_script\/rule\.js: no default export found/,
  },
  {
    label: 'a .js record with code after the default export',
    spec: { raw: { [JS_RULE]: `${singleFileRecord('code;', singleFileMetadata())}var after = 1;\n` } },
    error: /records\/sys_script\/rule\.js: "export default" must be the last statement in the file \(found more code after it\)/,
  },
  {
    label: 'a .js record whose default export is not an object literal',
    spec: { raw: { [JS_RULE]: 'code;\nexport default metadata;\n' } },
    error: /records\/sys_script\/rule\.js: the default export must be an object literal/,
  },
  {
    // The metadata is evaluated as data in an empty context; a value that is
    // not data is refused rather than silently carried around.
    label: 'a .js record with a function value in the metadata',
    spec: { raw: { [JS_RULE]: 'code;\nexport default { script: function () {} };\n' } },
    error: /the default export may hold only strings, numbers, booleans and plain objects: the default export\.script is a function/,
  },
  {
    label: 'a .js record with an array in the metadata',
    spec: { raw: { [JS_RULE]: "code;\nexport default { sys_id: 'a', fields: [] };\n" } },
    error: /the default export may hold only strings, numbers, booleans and plain objects: the default export\.fields is an array/,
  },
  {
    // A getter would run metadata code on the reader's side of the vm boundary.
    label: 'a .js record with an accessor in the metadata',
    spec: { raw: { [JS_RULE]: 'code;\nexport default { get script() { return true; } };\n' } },
    error: /the default export may hold only strings, numbers, booleans and plain objects: the default export\.script is an accessor property/,
  },
  {
    // Both fields name a declaration the body really declares, so the failure
    // is the double claim and nothing else.
    label: 'a .js record that claims the body twice',
    spec: jsProject('var DemoRule = 1;', singleFileMetadata({ code: { client_script: sym('DemoRule') } })),
    error: /records\/sys_script\/rule\.js: fields "client_script" and "script" both claim the file body; only one field may name a declaration/,
  },
  {
    // With no body there is no declaration to name; the name cannot resolve.
    label: 'a .js record that names a declaration in an empty body',
    spec: { raw: { [JS_RULE]: `export default { sys_id: '${SYS_ID_A}', table: 'sys_script', script: DemoRule };\n` } },
    error: /records\/sys_script\/rule\.js: script names "DemoRule", which is not declared at the top level of this file \(found: none\)/,
  },
  {
    // The reason for the rule: renaming the declaration and forgetting the
    // metadata is caught, and the error says what the body does declare.
    label: 'a .js record whose script names a renamed declaration',
    spec: jsProject('var RenamedRule = 1;', singleFileMetadata()),
    error: /records\/sys_script\/rule\.js: script names "DemoRule", which is not declared at the top level of this file \(found: "RenamedRule"\)/,
  },
  {
    label: 'a script path that does not exist',
    spec: jsProject('code;', singleFileMetadata({ script: './shared/laptop-utils.js' })),
    error: /records\/sys_script\/rule\.js: script path does not exist: \.\/shared\/laptop-utils\.js \(a string that looks like a file path must name a file in the project\)/,
  },
  {
    label: 'a script path that escapes the project root',
    spec: jsProject('code;', singleFileMetadata({ script: '../outside.js' })),
    error: /records\/sys_script\/rule\.js: script escapes the project root \(\.\.\/outside\.js\)/,
  },
  {
    label: 'an absolute script path',
    spec: jsProject('code;', singleFileMetadata({ script: '/etc/passwd.js' })),
    error: /records\/sys_script\/rule\.js: script must be relative to the project root, not absolute \(\/etc\/passwd\.js\)/,
  },
  {
    label: 'a script path that is not a .js file',
    spec: {
      raw: {
        [JS_RULE]: singleFileRecord('code;', singleFileMetadata({ script: 'shared/notes.txt' })),
        'shared/notes.txt': 'x\n',
      },
    },
    error: /records\/sys_script\/rule\.js: script path must point to a \.js file \(shared\/notes\.txt\)/,
  },
  {
    label: 'a script path that is a directory',
    spec: jsProject('code;', singleFileMetadata({ script: 'records' })),
    error: /records\/sys_script\/rule\.js: script path is not a file: records/,
  },
  {
    label: 'a boolean script value in a .json record',
    spec: { code: baseCode, records: oneRecord({ code: undefined, script: true }) },
    error: /records\/sys_script\/rule\.json: script must name a declaration in this file, or be a \.js path relative to the project root/,
  },
  {
    label: 'a boolean code value is rejected',
    spec: { code: baseCode, records: oneRecord({ code: { script: true } }) },
    error: /records\/sys_script\/rule\.json: code\.script must name a declaration in this file/,
  },
  {
    label: 'script and code.script in the same record',
    spec: { code: baseCode, records: oneRecord({ script: 'code/rule.js' }) },
    error: /records\/sys_script\/rule\.json: field "script" is defined in both code and script/,
  },
  {
    label: 'fields.script and script in the same record',
    spec: jsProject('code;', singleFileMetadata({ fields: { name: 'Rule', script: 'stale copy' } })),
    error: /records\/sys_script\/rule\.js: field "script" is defined in both fields and script/,
  },
  {
    label: 'an unknown key in a .js record',
    spec: jsProject('code;', singleFileMetadata({ notes: 'extra' })),
    error: /records\/sys_script\/rule\.js: unknown key "notes"/,
  },
  {
    label: 'a .js record whose table does not match its directory',
    spec: jsProject('code;', singleFileMetadata({ table: 'sys_script_include' })),
    error: /records\/sys_script\/rule\.js: table "sys_script_include" does not match its directory records\/sys_script/,
  },
  {
    label: 'a .js record with an invalid sys_id',
    spec: jsProject('code;', singleFileMetadata({ sys_id: 'nope' })),
    error: /records\/sys_script\/rule\.js: sys_id must be 32 lowercase hexadecimal characters/,
  },
  {
    label: 'a script value that is neither a declaration, a path, nor code',
    spec: jsProject('var DemoRule = 1;', singleFileMetadata({ script: 7 })),
    error: /records\/sys_script\/rule\.js: script must name a declaration in this file, or be a \.js path relative to the project root/,
  },
];

for (const rejection of REJECTIONS) {
  test(`rejects ${rejection.label}`, (t) => {
    const root = writeAppProject(t, rejection.spec);
    rejection.setup?.(root);
    expectInvalid(root, rejection.error);
  });
}

test('every rejection fails the CLI with exit 1 and leaves no artifact', (t) => {
  for (const rejection of REJECTIONS) {
    // Each case gets its own directory; node:test's cleanup runs after the test.
    const root = writeAppProject(t, rejection.spec);
    rejection.setup?.(root);
    const out = path.join(root, 'artifact.xml');
    const run = spawnSync(process.execPath, [CLI, 'app', 'build', '--dir', root, '--out', out], {
      encoding: 'utf8',
      timeout: 20000,
      env: cliEnv(root),
    });
    assert.equal(run.status, 1, `${rejection.label}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stderr, rejection.error, rejection.label);
    assert.match(run.stderr, /^Error: Invalid app project \(\d+ errors?\):/m, rejection.label);
    assert.equal(fs.existsSync(out), false, `${rejection.label}: no artifact may be written`);
  }
});

test('an empty code file is valid and reads as an empty string', (t) => {
  const root = writeAppProject(t, {
    appYaml: DEFAULT_APP_YAML,
    code: { 'code/rule.js': '' },
    records: oneRecord(),
  });
  const project = readAppProject(root);
  assert.equal(project.records[0].code.script.text, '');
});

test('app.scope is stored trimmed, the same value the scope check validated', (t) => {
  const root = writeAppProject(t, {
    appYaml: DEFAULT_APP_YAML.replace('  scope: x_1_demo', '  scope: "  x_1_demo  "'),
    code: baseCode,
    records: oneRecord(),
  });
  assert.equal(readAppProject(root).app.scope, 'x_1_demo');
});

test('an explicit global scope needs no app.sys_id (#399)', (t) => {
  // Global is a project target you name, not a value that appears by default.
  const root = writeAppProject(t, {
    appYaml: DEFAULT_APP_YAML
      .replace(`  sys_id: ${APP_SYS_ID}\n`, '')
      .replace('scope: x_1_demo', 'scope: global'),
    code: baseCode,
    records: oneRecord(),
  });
  const project = readAppProject(root);
  assert.deepEqual(project.app, { name: 'Demo App', scope: 'global' });
  assert.equal(Object.hasOwn(project.app, 'sys_id'), false);
});

// ── single-file records ──────────────────────────────────────────────────
//
// One `.js` file per record: the script is the code above the `export default`
// statement, the metadata is that statement. Every case below is a real file
// on disk, so what is asserted is what the reader actually gets.

test('the documented form validates and the script is the body above the export', (t) => {
  const source = `var LaptopUtils = Class.create();
LaptopUtils.prototype.isStandard = function (model) {
  return ['T14', 'X1'].indexOf(model) > -1;
};

export default {
  sys_id: '${SYS_ID_B}',
  table: 'sys_script_include',
  fields: { name: 'LaptopUtils', active: 'true', access: 'package_private' },
  script: LaptopUtils,
};
`;
  const root = writeAppProject(t, { raw: { 'records/sys_script_include/LaptopUtils.js': source } });
  const project = readAppProject(root);

  assert.equal(project.records.length, 1);
  const [record] = project.records;
  assert.equal(record.table, 'sys_script_include');
  assert.equal(record.slug, 'LaptopUtils');
  assert.equal(record.file, 'records/sys_script_include/LaptopUtils.js');
  assert.equal(record.sys_id, SYS_ID_B);
  assert.deepEqual(record.fields, { name: 'LaptopUtils', active: 'true', access: 'package_private' });
  assert.deepEqual(Object.keys(record.code), ['script']);
  assert.equal(record.code.script.path, 'records/sys_script_include/LaptopUtils.js');
  assert.equal(record.code.script.text,
    "var LaptopUtils = Class.create();\n"
    + "LaptopUtils.prototype.isStandard = function (model) {\n"
    + "  return ['T14', 'X1'].indexOf(model) > -1;\n"
    + '};\n');
  // One trailing newline was removed; the blank separator line before the
  // export is what keeps the body ending in exactly one newline.
  assert.equal(record.code.script.text.endsWith('};\n'), true);
  assert.equal(source.startsWith(`${record.code.script.text}\nexport default`), true);
});

test('a named script carries BOM, CRLF, ]]>, <, & and unicode byte for byte', (t) => {
  const root = writeAppProject(t, jsProject(TRICKY_SCRIPT, singleFileMetadata()));
  const [record] = readAppProject(root).records;

  assert.equal(record.code.script.text, TRICKY_SCRIPT);
  assert.ok(record.code.script.text.startsWith('\uFEFF'), 'the leading BOM is preserved');
  assert.ok(record.code.script.text.includes('\r\n'), 'CRLF line endings are preserved');
  assert.ok(record.code.script.text.includes(']]>'), '`]]>` survives as ordinary data');
  assert.ok(record.code.script.text.includes('中文 é'), 'non-ASCII characters are preserved');
  // The body is a byte-exact prefix of the file, separated by one newline.
  const file = fs.readFileSync(path.join(root, JS_RULE)).toString('utf8');
  assert.ok(file.startsWith(`${record.code.script.text}\nexport default`));
});

test('extraction removes exactly one trailing CRLF or LF and nothing else', (t) => {
  // The body declares the name the metadata references, so only the newline
  // rule is under test here.
  const code = 'var DemoRule = 1;';
  const metadata = `{ sys_id: '${SYS_ID_A}', table: 'sys_script', script: DemoRule }`;
  const cases = [
    [`${code}\n`, code, 'one LF'],
    [`${code}\r\n`, code, 'one CRLF'],
    [`${code}\n\n`, `${code}\n`, 'a second LF belongs to the script'],
    [`${code}\r\n\r\n`, `${code}\r\n`, 'a second CRLF belongs to the script'],
    [`${code}\r`, `${code}\r`, 'a lone CR is not a newline the rule removes'],
    [code, code, 'no newline at all'],
  ];
  for (const [body, expected, label] of cases) {
    const root = writeAppProject(t, {
      raw: { [JS_RULE]: `${body}export default ${metadata};\n` },
    });
    assert.equal(readAppProject(root).records[0].code.script.text, expected, label);
  }
});

test('script may name a file inside the project instead of the body', (t) => {
  const root = writeAppProject(t, {
    code: { 'shared/laptop-utils.js': SIMPLE_INCLUDE },
    raw: { [JS_RULE]: singleFileRecord('', singleFileMetadata({ script: './shared/laptop-utils.js' })) },
  });
  const [record] = readAppProject(root).records;
  assert.equal(record.code.script.text, SIMPLE_INCLUDE);
  assert.equal(record.code.script.path, './shared/laptop-utils.js');
});

test('script may be one line of code', (t) => {
  const root = writeAppProject(t,
    jsProject('', singleFileMetadata({ script: 'gs.info("one line");' })));
  const [record] = readAppProject(root).records;
  assert.equal(record.code.script.text, 'gs.info("one line");');
  assert.equal(record.code.script.path, null, 'a one-liner has no file behind it');
});

test('a record with several code fields names one declaration and paths for the rest', (t) => {
  const primary = 'var DemoRule = primary();\n';
  const root = writeAppProject(t, {
    code: {
      'code/widget-server.js': 'server();\n',
      'code/widget-client.js': 'client();\n',
    },
    raw: {
      'records/sp_widget/laptop-widget.js': singleFileRecord(primary, {
        sys_id: SYS_ID_A,
        table: 'sp_widget',
        fields: { name: 'Laptop widget' },
        code: {
          script: sym('DemoRule'),
          server_script: 'code/widget-server.js',
          client_script: 'code/widget-client.js',
        },
      }),
    },
  });
  const [record] = readAppProject(root).records;
  assert.equal(record.code.script.text, primary);
  assert.equal(record.code.server_script.text, 'server();\n');
  assert.equal(record.code.client_script.text, 'client();\n');
});

test('a .js record that only names code paths reads the same as the .json form', (t) => {
  const code = { 'code/rule.js': 'gs.info(1);\n' };
  const metadata = { sys_id: SYS_ID_A, table: 'sys_script', fields: { name: 'Rule' } };
  const jsonRoot = writeAppProject(t, {
    code,
    records: { 'sys_script/rule': { ...metadata, code: { script: 'code/rule.js' } } },
  });
  const jsRoot = writeAppProject(t, {
    code,
    raw: { [JS_RULE]: singleFileRecord('', { ...metadata, code: { script: 'code/rule.js' } }) },
  });

  const fromJson = readAppProject(jsonRoot).records[0];
  const fromJs = readAppProject(jsRoot).records[0];
  assert.deepEqual(fromJs.code, fromJson.code);
  assert.deepEqual(fromJs.fields, fromJson.fields);
  assert.equal(fromJs.sys_id, fromJson.sys_id);
  assert.equal(fromJs.table, fromJson.table);
});

test('a .json record may name its script at the top level too', (t) => {
  const root = writeAppProject(t, {
    code: baseCode,
    records: { 'sys_script/rule': { ...baseRecord, code: undefined, script: 'code/rule.js' } },
  });
  const [record] = readAppProject(root).records;
  assert.deepEqual(record.code, { script: { path: 'code/rule.js', text: 'gs.info(1);\n' } });
});

test('the script may contain comments, regexes, strings and braces without confusing extraction', (t) => {
  const body = [
    '// export default { not: "the metadata" }',
    'var pattern = /export default|\\{|\\}/g;',
    "var text = 'export default }';",
    'var nested = { outer: { inner: "}" } };',
    'var tpl = `a ${{ b: "}" }.b} export default }`;',
    '/* export default } */',
    'function f() { return pattern.test(text) ? nested.outer.inner : text; }',
    '',
  ].join('\n');
  // `pattern` is declared at the top level of this body, so the metadata can
  // name it; the point of the case is that the lexer is not fooled by text.
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('pattern') })));
  const [record] = readAppProject(root).records;

  assert.equal(record.code.script.text, body);
  assert.equal(record.sys_id, SYS_ID_A, 'the real metadata was read, not the text in the script');
  assert.deepEqual(record.fields, { name: 'Rule' });
});

test('the script body is never evaluated, imported or required at build time', (t) => {
  const body = [
    "require('node:fs').writeFileSync('pwned', 'the script body ran');",
    "import('node:fs');",
    "throw new Error('the script body was evaluated');",
    'process.exit(9);',
    'var marker = 1;',
    '',
  ].join('\n');
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('marker') })));
  const [record] = readAppProject(root).records;

  assert.equal(record.code.script.text, body);
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false, 'no side effect from the script');
});

test('a .js record written entirely with CRLF line endings reads the same', (t) => {
  // Windows authoring: every line, including the metadata, ends in CRLF. The
  // rule strips one CRLF, so the script keeps its own CRLF endings.
  const body = 'var DemoRule = 1;\r\nvar x = 1;\r\nif (x < 2) { x = 2; }\r\n';
  const metadata = [
    '{',
    `  sys_id: '${SYS_ID_A}',`,
    "  table: 'sys_script',",
    "  fields: { name: 'Rule' },",
    '  script: DemoRule,',
    '}',
  ].join('\r\n');
  const root = writeAppProject(t, {
    raw: { [JS_RULE]: `${body}\r\nexport default ${metadata};\r\n` },
  });
  const [record] = readAppProject(root).records;
  assert.equal(record.code.script.text, body);
  assert.equal(record.sys_id, SYS_ID_A);
});

// --- review findings on the record reader ---------------------------------

test('a metadata value named like the evaluator keeps its meaning', (t) => {
  // `script: value` used to read the evaluator's own `const value` — a temporal
  // dead zone — and `script: Set` replaced the constructor the walker needs.
  for (const name of ['value', 'Set', 'walk']) {
    const body = `const ${name} = 1;`;
    const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym(name) })));
    assert.equal(readAppProject(root).records[0].code.script.text, body, name);
  }
});

test('a function expression name is not a top-level declaration', (t) => {
  const body = 'const replacement = function OldName() {};';
  const ok = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('replacement') })));
  assert.equal(readAppProject(ok).records[0].code.script.text, body);
  const bad = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('OldName') })));
  expectInvalid(bad, /names "OldName", which is not declared at the top level of this file/);
});

test('an async lead-in only declares when it starts a statement', (t) => {
  // `async function f() {}` declares f; `const run = async function Hidden() {}`
  // declares run and gives the expression a private name.
  const declared = writeAppProject(t, jsProject('async function helper() { return 1; }\n', singleFileMetadata({ script: sym('helper') })));
  assert.equal(readAppProject(declared).records[0].code.script.text, 'async function helper() { return 1; }\n');
  const body = 'const run = async function Hidden() { return 1; };\n';
  expectInvalid(writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('Hidden') }))),
    /names "Hidden", which is not declared at the top level of this file/);
});

test('a declaration after a new line is a new statement (automatic semicolon insertion)', (t) => {
  const body = 'setup()\nfunction helper() { return 1; }\n';
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('helper') })));
  assert.equal(readAppProject(root).records[0].code.script.text, body);
});

test('an identifier named of is not a keyword in front of a division', (t) => {
  // `of` is contextual: `const of = 8; of / 2` divides, and only a for…of
  // header may put a regular expression after it.
  const body = 'var of = 8;\nvar half = of / 2;\n';
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('half') })));
  assert.equal(readAppProject(root).records[0].code.script.text, body);

  const header = 'function each() {\n  for (var item of /re/.exec("x")) {}\n}\n';
  const forOf = writeAppProject(t, jsProject(header, singleFileMetadata({ script: sym('each') })));
  assert.equal(readAppProject(forOf).records[0].code.script.text, header);
});

test('a postfix update leaves an operand, so the next slash divides', (t) => {
  const body = 'var i = 4;\nvar half = i++ / 2;\nvar quarter = --i / 2;\n';
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('half') })));
  assert.equal(readAppProject(root).records[0].code.script.text, body);
});

test('a .js body nothing claims is refused instead of dropped', (t) => {
  // The metadata would ship alone: no field names a declaration and no field
  // points at a .js file, so the code above the export would be lost.
  const root = writeAppProject(t, jsProject('var DemoRule = 1;', singleFileMetadata({ script: undefined })));
  expectInvalid(root, /the script body above "export default" is not used by any field/);
});

test('a quoted string may continue across CRLF after a backslash', (t) => {
  const body = "var s = 'a\\\r\nb';";
  const root = writeAppProject(t, jsProject(body, singleFileMetadata({ script: sym('s') })));
  assert.equal(readAppProject(root).records[0].code.script.text, body);
});

test('a line comment ends at any JavaScript line terminator', (t) => {
  for (const terminator of ['\r', '\u2028', '\u2029']) {
    const source = `var DemoRule = 1;${terminator}// note${terminator}export default ${serializeMetadata(singleFileMetadata())};${terminator}`;
    const root = writeAppProject(t, { raw: { [JS_RULE]: source } });
    // The metadata is found at all, which a comment scan looking only for LF
    // would have swallowed along with everything after it.
    assert.ok(readAppProject(root).records[0].code.script.text.startsWith('var DemoRule'), JSON.stringify(terminator));
  }
});

test('app.sys_id must be a string, not a one-element list that stringifies to one', (t) => {
  const root = writeAppProject(t, {
    appYaml: DEFAULT_APP_YAML.replace(`  sys_id: ${APP_SYS_ID}`, `  sys_id:\n    - ${APP_SYS_ID}`),
  });
  expectInvalid(root, /app\.sys_id must be 32 lowercase hexadecimal characters/);
});
