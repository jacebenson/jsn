import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { observeScenario } from '../scripts/acceptance/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('actual delivery gate accepts either delivered target, rejects neither and collisions', t => {
  if (process.platform === 'win32') { t.skip('actual bash gate runs on Linux'); return; }
  const w = load(fs.readFileSync(path.join(root, '.github/workflows/acceptance.yml'), 'utf8'));
  const script = w.jobs.delivery.steps[0].run;
  const run = env => spawnSync('bash', ['-eo', 'pipefail', '-c', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const key1 = `acceptance_${'1'.repeat(32)}`, key2 = `acceptance_${'2'.repeat(32)}`;
  for (const env of [
    { V1: 'false', V2: 'true', K2: key2 }, // unavailable vendor and executed failing assertions
    { V1: 'true', V2: 'false', K1: key1 },
    { V1: 'true', V2: 'true', K1: key1, K2: key2 },
    { PDI: 'true', KP: key1 },
  ]) assert.equal(run(env).status, 0, JSON.stringify(env));
  for (const env of [{}, { V1: 'true' }, { V1: 'false', V2: 'false' }, { V1: 'true', V2: 'true', K1: key1, K2: key1 }]) assert.notEqual(run(env).status, 0);
});

test('observer requires authenticated scenario operations, not local checks or auth failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = { outputDir: dir, runKey: `acceptance_${'a'.repeat(32)}`, read: async () => { throw Error('authentication rejected'); }, command: async () => ({ exitCode: 0, json: { ok: true } }) };
  const evidence = path.join(dir, 'executed.jsonl');
  await observeScenario({ id: 'local.version', run: c => c.command(['version']) }).run(ctx);
  await observeScenario({ id: 'auth.status', run: c => c.command(['auth', 'status']) }).run(ctx);
  await assert.rejects(observeScenario({ id: 'readonly.records', run: c => c.read('sys_db_object') }).run(ctx));
  assert.equal(fs.existsSync(evidence), false);
  ctx.read = async () => [];
  await assert.rejects(observeScenario({ id: 'readonly.records', run: async c => { await c.read('sys_db_object'); throw Error('deliberate failed assertion'); } }).run(ctx));
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), { runKey: ctx.runKey, id: 'readonly.records' });
});
