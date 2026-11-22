import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the actual lint configuration without adding an ESLint dependency.
// The repository already runs ESLint through npm exec (npx).
function lintCases(name, cases) {
  test(name, async t => {
    for (const [kind, entries] of Object.entries(cases)) {
      for (const [index, entry] of entries.entries()) {
        const code = typeof entry === 'string' ? entry : entry.code;
        await t.test(`${kind} ${index + 1}: ${code}`, () => {
          assert.ok(process.env.npm_execpath, 'Run via npm test or npm exec -- node --test');
          const result = spawnSync(process.execPath, [process.env.npm_execpath, 'exec', '--', 'eslint', '--stdin', '--stdin-filename', 'test/esm-path-case.js', '--format', 'json'], {
            cwd: fileURLToPath(new URL('../', import.meta.url)), input: code, encoding: 'utf8', timeout: 30000,
          });
          assert.ifError(result.error);
          assert.ok(result.status === 0 || result.status === 1, result.stderr);
          const messages = JSON.parse(result.stdout)[0].messages;
          assert.equal(messages.filter(message => message.fatal).length, 0, result.stdout);
          const diagnostics = messages.filter(message => message.ruleId === 'local/portable-esm-paths');
          assert.deepEqual(diagnostics.map(message => message.messageId), kind === 'valid' ? [] : entry.errors.map(error => error.messageId));
          for (const diagnostic of diagnostics) assert.match(diagnostic.message,
            diagnostic.messageId === 'filePath' ? /fileURLToPath\(url\)/ : /pathToFileURL\(path\)\.href/);
        });
      }
    }
  });
}
const imports = `import path from 'node:path'; import { spawnSync } from 'node:child_process';`;
lintCases('portable-esm-paths', {
  valid: [
    `${imports} spawnSync(process.execPath, ['--import', 'file:///C:/guard.mjs', path.join('bin', 'cli.js')]);`,
    `${imports} spawnSync(process.execPath, ['--import', 'node:fs', 'cli.js']);`,
    `${imports} spawnSync(process.execPath, ['--import', 'data:text/javascript,', 'cli.js']);`,
    `${imports} spawnSync(process.execPath, ['--import', 'some-package', 'cli.js']);`,
    `${imports} spawnSync(process.execPath, ['--import', new URL('./guard.js', import.meta.url).href]);`,
    `${imports} import { pathToFileURL } from 'node:url'; spawnSync(process.execPath, ['--import', pathToFileURL(path.resolve('guard.js')).href]);`,
    `${imports} spawnSync(process.execPath, [path.resolve('cli.js'), '--import', '/ordinary-argument']);`,
    `${imports} spawnSync('other-cli', ['--import', path.resolve('guard.js')]);`,
    `import('./relative.js'); import('package'); import('file:///tmp/a.js');`,
    `${imports} const guard = unknown(); import(guard);`,
    `${imports} function run(path) { return import(path.resolve('a')); }`,
    `${imports} const guard = path.resolve('a'); function run(guard) { return import(guard); }`,
    `${imports} path.resolve('/tmp/file');`,
    `const env = { NODE_OPTIONS: '--import=some-package' };`,
  ],
  invalid: [
    ...['C:\\guard.mjs', '/tmp/guard.mjs', '\\\\server\\share\\guard.mjs'].map(value => ({
      code: `${imports} spawnSync(process.execPath, ['--import', ${JSON.stringify(value)}]);`,
      errors: [{ messageId: 'fileUrl' }],
    })),
    { code: `${imports} const guard = path.join('test', 'guard.js'); spawnSync(process.execPath, ['--import', guard, ...args]);`, errors: [{ messageId: 'fileUrl' }] },
    { code: `import { resolve as absolute } from 'path'; import { spawnSync as run } from 'child_process'; const a = absolute('a'); const b = a; run(process.execPath, ['--loader', b]);`, errors: [{ messageId: 'fileUrl' }] },
    { code: `import { fileURLToPath as toPath } from 'node:url'; const p = toPath(new URL('./a', import.meta.url)); import(p);`, errors: [{ messageId: 'fileUrl' }] },
    { code: `${imports} import(path.resolve('a.js'));`, errors: [{ messageId: 'fileUrl' }] },
    { code: `import('C:/guard.mjs');`, errors: [{ messageId: 'fileUrl' }] },
    { code: `${imports} spawnSync(process.execPath, ['--import=/tmp/a.js']);`, errors: [{ messageId: 'fileUrl' }] },
    { code: `const env = { NODE_OPTIONS: '--import="C:/space dir/a.js" --trace-warnings' };`, errors: [{ messageId: 'fileUrl' }] },
    { code: `${imports} const env = { NODE_OPTIONS: \`--import=\${path.resolve('a')}\` };`, errors: [{ messageId: 'fileUrl' }] },
    { code: `${imports} process.env.NODE_OPTIONS = '--loader=' + path.resolve('a');`, errors: [{ messageId: 'fileUrl' }] },
  ],
});

// PR533: URL.pathname is not a native path (drive letters and percent escapes).
// Keep this bounded to statically recognizable file URLs, not arbitrary URLs.
lintCases('file URL native paths', {
  valid: [
    `import { fileURLToPath } from 'node:url'; fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));`,
    `import { pathToFileURL } from 'node:url'; pathToFileURL('/tmp/a').href;`,
    `new URL('https://example.com/a').pathname;`,
    `new URL('/a', 'https://example.com').pathname;`,
    `new URL('https://example.com', import.meta.url).pathname;`,
    `new URL(value, import.meta.url).pathname;`,
    `new URL('./a', base).pathname;`,
    `request.url.pathname; url.pathname;`,
    `let url = new URL('./a', import.meta.url); url.pathname;`,
    `const url = new URL('./a', import.meta.url); function read(url) { return url.pathname; }`,
    `function read(URL) { return new URL('./a', import.meta.url).pathname; }`,
    `const url = new URL('./a', import.meta.url); url.href; url[key];`,
  ],
  invalid: [
    `new URL('../../bin/jsn.js', import.meta.url).pathname;`,
    `new URL('file:///D:/space%20dir/caf%C3%A9.js').pathname;`,
    `new URL('file://server/share/a').pathname;`,
    `new URL('./a', import.meta.url)['pathname'];`,
    `const url = new URL('./a', import.meta.url); const alias = url; alias.pathname;`,
    `const relative = './a'; const base = import.meta.url; new URL(relative, base).pathname;`,
    `const base = new URL('file:///D:/root/'); new URL('./a', base).pathname;`,
    `import { URL as FileURL } from 'node:url'; new FileURL('./a', import.meta.url).pathname;`,
  ].map(code => ({ code, errors: [{ messageId: 'filePath' }] })),
});
