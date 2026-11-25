import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenarios, runFixture } from './support/cmdb-performance-fixture.js';
import { ROOT, baseArgv, collectHandlers, makeApp } from './support/cmdb-fixtures.js';

// Captured from the unoptimized handlers at 719c430. Compare serialized command
// results (including summary/breadcrumbs) and the rendered card/graph verbatim.
const baseline = JSON.parse(readFileSync(new URL('./support/cmdb-performance-baseline.json', import.meta.url), 'utf8'));

for (const [name, scenario] of Object.entries(scenarios)) {
  it(`cmdb performance preserves baseline JSON and rendered output: ${name}`, async () => {
    const result = await runFixture(scenario);
    assert.equal(result.output, baseline[name].output);
    assert.equal(result.rendered, baseline[name].rendered);
  });
}

it('cmdb show reuses successful root reads and memoizes classes within each invocation', async () => {
  for (let invocation = 0; invocation < 2; invocation++) {
    const { calls } = await runFixture(scenarios.show);
    assert.equal(calls.filter((c) => c.table === 'cmdb_rel_ci').length, 3, 'baseline: 4 relationship reads');
    const classes = calls.filter((c) => c.fields === 'sys_class_name');
    assert.equal(classes.length, 6, 'baseline: 8 class reads');
    assert.equal(new Set(classes.map((c) => c.query)).size, classes.length);
    assert.equal(calls.length, 11, 'baseline: 14 total reads');
  }
});

it('cmdb hydrates distinct IDs in small bounded chunks without changing row order', async () => {
  const ids = Array.from({ length: 11 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
  let active = 0;
  let maxActive = 0;
  const classReads = [];
  const sdk = {
    async list(table, params) {
      if (table === 'cmdb_rel_ci') {
        const rows = ids.map((id) => ({ parent: ROOT, child: id, type: 'Contains' }));
        return [...rows, ...rows];
      }
      const id = params.get('sysparm_query').slice('sys_id='.length);
      if (params.get('sysparm_fields') === 'sys_class_name') {
        classReads.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
      }
      return [{ sys_id: id, name: id === ROOT ? 'root' : id, sys_class_name: 'cmdb_ci_server' }];
    },
  };
  const app = makeApp(sdk);
  const sub = (await collectHandlers()).find((s) => s.command === 'relationships');
  await sub.handler(baseArgv(app, { depth: 1 }));
  assert.ok(maxActive > 1, 'class hydration must not be serial');
  assert.ok(maxActive <= 4, `small pool must cap active reads at four, got ${maxActive}`);
  assert.deepEqual(classReads, ids, 'duplicate edges must not rehydrate IDs');
  assert.deepEqual(app.okCalls[0].data.records.map((r) => r.sys_id), ids);
});

it('cmdb show retries a failed root read rather than caching an empty success', async () => {
  const { calls } = await runFixture(scenarios.failedRootOnce);
  assert.equal(calls.filter((c) => c.table === 'cmdb_rel_ci').length, 2);
});
