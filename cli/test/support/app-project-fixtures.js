// Fixtures for the app-project format tests (issue #399).
//
// A project is a real directory, so every fixture is written under a fresh
// temporary directory that the test removes on completion. Nothing here reads
// or writes a ServiceNow instance.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYS_ID_A = 'a'.repeat(32);
export const SYS_ID_B = 'b'.repeat(32);
// A scoped app must name its application sys_id (issue #399): Global is never
// the implicit fallback, so the happy-path project is a scoped app with one.
export const APP_SYS_ID = 'd'.repeat(32);

export const DEFAULT_APP_YAML = [
  'version: 1',
  'app:',
  '  name: Demo App',
  '  scope: x_1_demo',
  `  sys_id: ${APP_SYS_ID}`,
  'backend: update-set',
  'description: Demo app for tests',
  '',
].join('\n');

// One script body carrying every byte hazard the envelope must preserve:
// a leading BOM, CRLF line endings, `<`, `&`, the `]]>` sequence, and
// non-ASCII characters.
export const TRICKY_SCRIPT = '\uFEFFvar DemoRule = function (current) {\r\n'
  + 'var gr = current.addQuery("active", "true");\r\n'
  + 'if (1 < 2 && gr.hasNext()) { gs.info("]]> framed"); }\r\n'
  + '// \u4e2d\u6587 \u00e9\r\n'
  + '};\r\n';

export const SIMPLE_RULE = '// rule\r\ncurrent.setValue("x", "1 & 2");\r\n';
export const SIMPLE_INCLUDE = 'var DemoHelper = Class.create();\nDemoHelper.prototype.initialize = function () {};\n';

/**
 * A code-field value that must be emitted as a bare identifier rather than a
 * JSON string: `script: sym('DemoRule')` writes `script: DemoRule,`.
 */
export class SymbolRef {
  constructor(name) {
    this.name = name;
  }
}

/** Reference a top-level declaration in the record file. */
export function sym(name) {
  return new SymbolRef(name);
}

const SYMBOL_PLACEHOLDER = '__jsn_symbol__:';

export function serializeMetadata(value) {
  const json = JSON.stringify(value, (key, item) => (
    item instanceof SymbolRef ? `${SYMBOL_PLACEHOLDER}${item.name}` : item
  ), 2);
  return json.replace(/"__jsn_symbol__:([A-Za-z_$][\w$]*)"/g, '$1');
}

/**
 * A single-file record: the script, one blank line, then the metadata.
 *
 * The blank line is the convention the docs show; extraction removes exactly
 * one trailing newline, so the blank line is what makes the recovered script
 * equal `body` exactly.
 */
export function singleFileRecord(body, metadata) {
  return `${body}\nexport default ${serializeMetadata(metadata)};\n`;
}

/** The metadata for a one-script record whose body is the file above the export. */
export function singleFileMetadata(patch = {}) {
  return {
    sys_id: SYS_ID_A,
    table: 'sys_script',
    fields: { name: 'Rule' },
    script: sym('DemoRule'),
    ...patch,
  };
}

/** The happy-path fixture: one business rule with a lifted script and one Script Include. */
export function happyProjectSpec(overrides = {}) {
  return {
    ...overrides,
    appYaml: Object.hasOwn(overrides, 'appYaml') ? overrides.appYaml : DEFAULT_APP_YAML,
    code: {
      'code/before-query.js': TRICKY_SCRIPT,
      'code/demo-helper.js': SIMPLE_INCLUDE,
      ...(overrides.code ?? {}),
    },
    records: {
      'sys_script/before-query': {
        sys_id: SYS_ID_A,
        table: 'sys_script',
        fields: { name: 'Before Query', active: true, order: 100, condition: 'active=true' },
        code: { script: 'code/before-query.js' },
      },
      'sys_script_include/demo-helper': {
        sys_id: SYS_ID_B,
        table: 'sys_script_include',
        fields: { name: 'DemoHelper', api_name: 'x_1_demo.DemoHelper' },
        code: { script: 'code/demo-helper.js' },
      },
      ...(overrides.records ?? {}),
    },
  };
}

/**
 * Write a project directory.
 *
 * @param {object} t — node:test context (registers cleanup)
 * @param {object} spec
 * @param {string|null} [spec.appYaml] — null omits app.yaml
 * @param {Record<string, string|Buffer>} [spec.code] — relative path → bytes
 * @param {Record<string, object>} [spec.records] — `<table>/<slug>` → JSON object
 * @param {Record<string, string>} [spec.raw] — relative path → raw file contents
 * @param {boolean} [spec.recordsDir] — false omits the records/ directory
 * @returns {string} project root
 */
export function writeAppProject(t, {
  appYaml = DEFAULT_APP_YAML,
  code = {},
  records = {},
  raw = {},
  recordsDir = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-app-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (appYaml !== null) fs.writeFileSync(path.join(root, 'app.yaml'), appYaml);
  if (recordsDir) fs.mkdirSync(path.join(root, 'records'), { recursive: true });
  for (const [relative, contents] of Object.entries({ ...code, ...raw })) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  for (const [key, record] of Object.entries(records)) {
    const separator = key.indexOf('/');
    const table = key.slice(0, separator);
    const slug = key.slice(separator + 1);
    const file = path.join(root, 'records', table, `${slug}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  return root;
}

/** Environment for a spawned CLI run that cannot reach an instance or a profile. */
export function cliEnv(root, extra = {}) {
  return {
    ...process.env,
    HOME: path.join(root, '.home'),
    XDG_CONFIG_HOME: path.join(root, '.config'),
    JSN_DATA_HOME: path.join(root, '.jsn'),
    JSN_NO_PROMPTS: '1',
    JSN_NO_VERSION_CHECK: '1',
    JSN_NO_SKILL_CHECK: '1',
    // A developer or CI shell that exports this would let a child resolve an
    // instance with no profile, and the no-instance test would test nothing.
    SERVICENOW_INSTANCE_URL: '',
    ...extra,
  };
}
