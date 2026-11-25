import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareLinuxRemoteMidServer } from '../src/midserver-linux-remote.js';
import { prepareWindowsRemoteMidServer } from '../src/midserver-windows-remote.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-remote-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  return { root, home, directory: path.join(root, 'controller', 'metadata'), target: 'fixture-target', instanceURL: 'https://example.service-now.com', name: 'fixture' };
}
test('Linux target default and overrides are resolved and validated by read-only target program before controller writes', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
  const f = fixture(t);
  const run = (_command, args, options) => {
    const source = Buffer.from(args.at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1], 'base64').toString();
    return execFileSync('python3', ['-c', source], { input: options.input, encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  };
  const defaultPath = path.join(f.home, '.servicenow', 'mids', 'example', 'fixture');
  const plan = prepareLinuxRemoteMidServer({ ...f, run, dryRun: true });
  assert.equal(plan.remoteDirectory, defaultPath);
  assert.equal(fs.existsSync(path.dirname(f.directory)), false);
  assert.equal(fs.existsSync(path.join(f.home, '.servicenow')), false);
  const override = path.join(f.home, 'custom');
  assert.equal(prepareLinuxRemoteMidServer({ ...f, run, remoteDirectory: override, dryRun: true }).remoteDirectory, override);
  fs.mkdirSync(override, { mode: 0o700 });
  assert.throws(() => prepareLinuxRemoteMidServer({ ...f, run, remoteDirectory: override, dryRun: true }), /operation failed/);
  fs.symlinkSync(f.home, path.join(f.home, 'link'));
  assert.throws(() => prepareLinuxRemoteMidServer({ ...f, run, remoteDirectory: path.join(f.home, 'link', 'mid'), dryRun: true }), /operation failed/);
  assert.throws(() => prepareLinuxRemoteMidServer({ ...f, run: () => assert.fail('invalid override must reject before transport'), remoteDirectory: 'relative', dryRun: true }), /absolute/);
  assert.equal(fs.existsSync(path.dirname(f.directory)), false);
});
test('Windows preflight validates target paths and parent ACLs, carries overrides on stdin and writes no controller metadata', t => {
  const f = fixture(t), remoteDirectory = 'C:\\Users\\fixture\\MID';
  let calls = 0;
  const run = (_command, _args, options) => {
    calls++;
    const [encoded, payload] = options.input.split('\n');
    const script = Buffer.from(encoded, 'base64').toString();
    const p = JSON.parse(payload);
    assert.equal(p.remoteDirectory, remoteDirectory);
    assert.match(script, /Get-Acl.*nearest/);
    assert.match(script, /Reparse ancestor forbidden/);
    assert.doesNotMatch(script, /New-Item|Set-Acl|Set-Content|Invoke-WebRequest/);
    return `JSN_RESULT:${JSON.stringify({ elevated: true, platform: 'windows-x64', remoteDirectory })}`;
  };
  assert.equal(prepareWindowsRemoteMidServer({ ...f, run, remoteDirectory, dryRun: true }).remoteDirectory, remoteDirectory);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.dirname(f.directory)), false);
  assert.throws(() => prepareWindowsRemoteMidServer({ ...f, run: () => assert.fail('invalid path must reject before transport'), remoteDirectory: 'C:\\Users\\fixture\\..\\other', dryRun: true }), /absolute normalized/);
});
