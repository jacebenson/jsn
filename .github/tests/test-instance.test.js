import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

test('shell entrypoint: cwd, dotenv, aliases, opt-in dry-run and status forwarding', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'instance wrapper '));
  try {
    fs.mkdirSync(path.join(root, '.github/scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cli/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const script = path.join(root, '.github/scripts/test-instance.sh');
    fs.copyFileSync(new URL('../scripts/test-instance.sh', import.meta.url), script);
    fs.chmodSync(script, 0o755);
    // Contract spy only: existing local-acceptance tests exercise real provider
    // scenarios and publication HTTP/readback separately.
    fs.writeFileSync(path.join(root, 'cli/src/config.js'), `export const loadConfig = () => ({profiles: process.env.DIRECT ? {'vendor-1': {}, local: {}} : {local: {}}});`);
    fs.writeFileSync(path.join(root, '.github/scripts/run-acceptance.mjs'), `export function parseOptions(args) { const i=args.indexOf('--version'); if(i>=0&&!/^\\d+\\.\\d+\\.\\d+$/.test(args[i+1])) throw Error('options: exact version required'); } export async function main(args) { console.log(JSON.stringify(args)); console.log('Tested version: '+(args.includes('--version')?args[args.indexOf('--version')+1]:'checkout')); return Number(process.env.TEST_STATUS||0); }`);
    const envFile = path.join(root, 'private settings.env');
    fs.writeFileSync(envFile, 'JSN_TEST_PROFILE_VENDOR_1=local\nJSN_ACCEPTANCE_INGEST_URL=https://example.invalid/api/acceptance/runs\nJSN_ACCEPTANCE_INGEST_TOKEN=canary-never-log-01234567890123456789\n');
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, HERMES_HOME: root };
    const run = (args, extra = {}) => spawnSync(script, args, { cwd: path.dirname(root), env: { ...env, ...extra }, encoding: 'utf8' });
    let r = run(['--env-file', envFile, '--profile', 'vendor-1', '--dry-run']);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /skips publication ONLY/); assert.doesNotMatch(r.stdout, /--publish|canary-never-log/); assert.match(r.stdout, /"--profile","local"/); assert.match(r.stdout, /"--mode","full"/);
    const ro = run(['--env-file', envFile, '--profile', 'vendor-1', '--dry-run', '--readonly']); assert.equal(ro.status, 0); assert.match(ro.stdout, /"--mode","readonly"/);
    const plan = run(['--profile','local','--plan']); assert.equal(plan.status,0); assert.match(plan.stdout,/PLAN ONLY/); assert.doesNotMatch(plan.stdout,/--publish/);
    r = run(['--env-file', envFile, '--profile', 'vendor-1', '--version', '5.5.5']);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Publication enabled/); assert.match(r.stdout, /--publish/); assert.match(r.stdout, /Tested version: 5.5.5/);
    r = run(['--env-file', envFile, '--profile', 'vendor-1', '--dry-run'], { DIRECT: '1', TEST_STATUS: '2' });
    assert.equal(r.status, 2); assert.match(r.stdout, /"--profile","vendor-1"/);
    r = run(['--profile', 'vendor-1', '--dry-run']); assert.equal(r.status, 1); assert.match(r.stderr, /JSN_TEST_PROFILE_VENDOR_1.*local profile/);
    r = run(['--profile', 'local']); assert.equal(r.status, 1); assert.match(r.stderr, /publication:/); assert.equal(r.stdout, '');
    r = run(['--env-file', envFile, '--profile', 'local', '--version', 'latest']); assert.equal(r.status, 1); assert.equal(r.stdout, '');
    r = run(['--env-file', path.join(root, 'missing'), '--profile', 'local']); assert.equal(r.status, 1);
    fs.copyFileSync(envFile, path.join(root, '.env'));
    r = run(['--profile', 'vendor-1', '--dry-run']); assert.equal(r.status, 0, r.stderr);
    fs.writeFileSync(path.join(root, '.github/scripts/run-acceptance.mjs'), `export function parseOptions() {} export async function main() { console.log('ready-for-signal'); await new Promise(() => setInterval(() => {}, 1000)); }`);
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const child = spawn(script, ['--profile', 'local', '--dry-run'], { cwd: path.dirname(root), env, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('signal fixture timed out')); }, 5000);
        let output = '';
        child.stdout.on('data', data => { output += data; if (output.includes('ready-for-signal')) child.kill(signal); });
        child.once('error', reject);
        child.once('exit', (code, actualSignal) => { clearTimeout(timeout); try { assert.equal(code, null); assert.equal(actualSignal, signal); resolve(); } catch (error) { reject(error); } });
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
