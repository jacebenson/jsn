import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrentCatalog, executeReadonlyScenarios } from '../scripts/acceptance/concurrency.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageHarness } from '../scripts/run-acceptance.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scenario = (id, run, requires = []) => ({ id: `readonly.catalog.${id}`, modes: ['readonly', 'pdi'], mutates: false, requires: requires.map(id => `readonly.catalog.${id}`), run });

test('catalog overlaps four runs, caps dispatch, awaits completion and keeps report order', async () => {
  const gates = Array.from({ length: 6 }, deferred), started = [], completed = [];
  const ctx = { mode: 'readonly' };
  const input = gates.map((gate, i) => scenario(`family${'abcdef'[i]}.list`, async () => { started.push(i); await gate.promise; completed.push(i); }));
  const adapter = concurrentCatalog(input);
  const first = adapter.scenarios[0].run(ctx);
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve(); await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[1].resolve(); await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  let finished = false; first.then(() => { finished = true; });
  await new Promise(setImmediate); assert.equal(finished, false);
  gates.forEach(g => g.resolve()); await first;
  for (const s of adapter.scenarios.slice(1)) await s.run(ctx);
  assert.equal(completed.length, 6);
  assert.deepEqual(adapter.scenarios.map(s => s.id), input.map(s => s.id));
  assert.equal(adapter.durations.size, 6);
});

test('show waits for its own list; failures propagate unchanged and block dependent dispatch', async () => {
  const gate = deferred(), events = [], failure = Error('fixture failure');
  const input = [
    scenario('one.list', async () => { events.push('list'); await gate.promise; events.push('listed'); }),
    scenario('one.show', async () => { events.push('show'); }, ['one.list']),
    scenario('two.list', async () => { throw failure; }),
    scenario('two.show', async () => { assert.fail('failed list must block show'); }, ['two.list']),
  ];
  const adapter = concurrentCatalog(input);
  const run = adapter.scenarios[0].run({ mode: 'readonly' });
  await new Promise(setImmediate); assert.deepEqual(events, ['list']);
  gate.resolve(); await run;
  await adapter.scenarios[1].run({ mode: 'readonly' });
  assert.deepEqual(events, ['list', 'listed', 'show']);
  await assert.rejects(adapter.scenarios[2].run({ mode: 'readonly' }), error => error === failure);
  assert.deepEqual(await adapter.scenarios[3].run({ mode: 'readonly' }), { status: 'blocked-prerequisite' });
});

test('noncatalog, mutating, cleanup and pdi scenarios are never prefetched', async () => {
  const events = [];
  const local = { ...scenario('unsafe.list', async () => events.push('local')), id: 'local.version' };
  const mutation = { ...scenario('write.list', async () => events.push('write')), mutates: true };
  const cleanup = { ...scenario('cleanup.list', async () => events.push('cleanup')), cleanup() {} };
  const safe = scenario('safe.list', async () => events.push('safe'));
  const adapter = concurrentCatalog([local, mutation, cleanup, safe]);
  for (const s of [local, mutation, cleanup]) assert.equal(adapter.scenarios.find(other => other.id === s.id), s);
  await adapter.scenarios[3].run({ mode: 'pdi' });
  assert.deepEqual(events, ['safe']);
  assert.equal(adapter.durations.size, 0);
});

test('immutable producer retains failure classification, order, sanitization and cleanup after draining', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'concurrency-producer-'));
  try {
    const harness = stageHarness(root, '5.5.7');
    const support = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/support.mjs')));
    const { executeScenarios } = await import(pathToFileURL(path.join(harness, 'cli/scripts/acceptance/run.mjs')));
    const gate = deferred(), events = [];
    const input = [
      scenario('one.list', async () => { events.push('one'); await gate.promise; events.push('drained'); }),
      scenario('one.show', async () => { events.push('show'); }, ['one.list']),
      scenario('two.list', async () => { events.push('two'); throw Error('private-canary'); }),
      scenario('two.show', async () => assert.fail('blocked show ran'), ['two.list']),
      { id: 'local.after', modes: ['readonly'], mutates: false, requires: [], async run() { assert.ok(events.includes('show')); events.push('serial'); } },
    ];
    const ctx = { mode: 'readonly', state: new Map(), runKey: `acceptance_${'a'.repeat(32)}`, outputDir: root, async cleanup() { events.push('cleanup'); return []; } };
    const running = executeReadonlyScenarios(executeScenarios, support, input, ctx, {
      selection: { ids: input.map(s => s.id), full: true },
      suiteHooks: { async beginSuite() { events.push('begin'); }, async endSuite() { events.push('end'); } },
    });
    await new Promise(setImmediate);
    assert.deepEqual(events, ['begin', 'one', 'two']);
    gate.resolve();
    const report = await running;
    assert.deepEqual(report.results.map(r => r.id), input.map(s => s.id));
    assert.deepEqual(report.results.map(r => r.status), ['passed', 'passed', 'failed', 'blocked-prerequisite', 'passed']);
    assert.equal(report.summary.complete, false);
    assert.deepEqual(events, ['begin', 'one', 'two', 'drained', 'show', 'serial', 'end', 'cleanup']);
    const retained = JSON.parse(fs.readFileSync(path.join(root, 'public-summary.json')));
    assert.equal(JSON.stringify(retained).includes('private-canary'), false);
    assert.deepEqual(retained.results, report.results.map(({ id, status, durationMs }) => ({ id, status, durationMs })));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private-report.json'))).results, JSON.parse(JSON.stringify(report.results)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
