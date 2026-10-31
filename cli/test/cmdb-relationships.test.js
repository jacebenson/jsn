// Tests for the cmdb command — structure + relationship traversal with a
// mocked sdk layer (no live instance).

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  CLUSTER,
  ROOT,
  SERVER,
  collectHandlers,
  makeApp,
  makeSDK,
  baseArgv,
} from './support/cmdb-fixtures.js';

describe('cmdb relationships — root resolution', () => {
  async function run(argv) {
    const { sdk, listCalls } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const rel = subs.find((s) => s.command === 'relationships');
    await rel.handler(baseArgv(app, argv));
    return { app, listCalls };
  }

  it('resolves a 32-hex --ci as a sys_id lookup (limit 1)', async () => {
    const { listCalls, app } = await run({});
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci' && c.query.startsWith('sys_id='));
    assert.ok(ciCall, 'should look up cmdb_ci by sys_id');
    assert.strictEqual(ciCall.query, `sys_id=${ROOT}`);
    assert.strictEqual(ciCall.limit, '1');
    assert.strictEqual(app.okCalls[0].data.root.name, 'app1');
    assert.strictEqual(app.okCalls[0].data.root.class, 'cmdb_ci_app_server');
  });

  it('resolves a non-hex --ci as a name lookup (limit 5) and takes the first row', async () => {
    const { listCalls, app } = await run({ ci: 'app1' });
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci' && c.query.startsWith('name='));
    assert.ok(ciCall, 'should look up cmdb_ci by name');
    assert.strictEqual(ciCall.query, 'name=app1');
    assert.strictEqual(ciCall.limit, '5');
    assert.strictEqual(app.okCalls[0].data.root.sys_id, ROOT);
  });

  it('throws not_found when the CI does not exist', async () => {
    const { sdk } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const rel = subs.find((s) => s.command === 'relationships');
    await assert.rejects(
      rel.handler(baseArgv(app, { ci: 'ghost' })),
      (err) => err.code === 'not_found' && /ghost/.test(err.message)
    );
  });

  it('rejects identifiers with query metacharacters (injection guard)', async () => {
    const { sdk } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const rel = subs.find((s) => s.command === 'relationships');
    await assert.rejects(
      rel.handler(baseArgv(app, { ci: 'app1^active=true' })),
      /Unsafe identifier/
    );
  });
});
describe('cmdb relationships — traversal', () => {
  async function run(argv, { withSiblings = false } = {}) {
    const { sdk, listCalls } = makeSDK({ withSiblings });
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const rel = subs.find((s) => s.command === 'relationships');
    await rel.handler(baseArgv(app, argv));
    return { app, listCalls };
  }

  it('walks the graph with correct direction and depth per hop', async () => {
    const { app } = await run({});
    const data = app.okCalls[0].data;
    const rows = data.records;
    assert.strictEqual(data.root.sys_id, ROOT);
    // depth 1: SERVER + WEB (downstream); depth 2: back-edge to ROOT + CLUSTER
    // (both upstream, discovered from SERVER); depth 3: SERVER + WEB again via
    // the back-edge's re-walk. Real Table API returns every edge where parent
    // OR child matches, so cycles are surfaced as rows.
    assert.strictEqual(data.meta.total, 6);
    // ROOT -> SERVER (downstream, depth 1)
    const server = rows.find((r) => r.sys_id === SERVER && r.depth === 1);
    assert.ok(server, 'SERVER should be a direct downstream of ROOT');
    assert.strictEqual(server.direction, 'downstream');
    assert.strictEqual(server.type, 'Runs on::Runs');
    assert.strictEqual(server.parent, ROOT, 'rows carry the CI they were discovered from');
    // ROOT -> WEB (downstream, depth 1)
    assert.ok(rows.some((r) => r.sys_id === 'd'.repeat(32) && r.direction === 'downstream' && r.depth === 1));
    // SERVER -> CLUSTER (upstream, depth 2)
    const cluster = rows.find((r) => r.sys_id === CLUSTER);
    assert.ok(cluster, 'CLUSTER should be reached at depth 2');
    assert.strictEqual(cluster.direction, 'upstream');
    assert.strictEqual(cluster.depth, 2);
    assert.strictEqual(cluster.class, 'cmdb_ci_cluster');
    assert.strictEqual(cluster.parent, SERVER);
    // cycle: SERVER's hop re-discovers ROOT as an upstream back-edge
    const back = rows.find((r) => r.sys_id === ROOT && r.depth === 2);
    assert.ok(back, 'back-edge to the root should be surfaced');
    assert.strictEqual(back.direction, 'upstream');
  });

  it('renders the hourglass layout: parents above, YOU ARE HERE, children below', async () => {
    const { app } = await run({}, { withSiblings: true });
    const tree = app.okCalls[0].data._formatted;
    assert.ok(tree.includes('CMDB: app1 (cmdb_ci_app_server)'), 'header should name the root');
    // parents section (upstream) sits above the CI itself
    const parentsIdx = tree.indexOf('▶ PARENTS');
    const hereIdx = tree.indexOf('**YOU ARE HERE** app1 (cmdb_ci_app_server)');
    const childrenIdx = tree.indexOf('▶ CHILDREN');
    assert.ok(parentsIdx !== -1 && hereIdx !== -1 && childrenIdx !== -1, 'all three sections present');
    assert.ok(parentsIdx < hereIdx && hereIdx < childrenIdx, 'order: parents → YOU ARE HERE → children');
    assert.ok(tree.includes('└─ ↑ cluster-p (cmdb_ci_cluster) — Contains::Contained by'), 'parent renders in the parents section');
    assert.ok(tree.includes('├─ ↓ server1 (cmdb_ci_server) — Runs on::Runs'), 'child renders in the children section');
    // the interleaved walk rows (back-edges into the root) are NOT re-shown as siblings
    assert.ok(!tree.includes('↺'), 'no interleaved back-edge rows in the hourglass layout');
  });

  it('nests ancestor and descendant chains, collapsing cycles to ↺', async () => {
    const { formatCMDBGraph } = await import('../src/commands/cmdb.js');
    const tree = formatCMDBGraph(
      { name: 'A', class: 'app', sys_id: 'a1' },
      [
        // ancestor chain: A ← P ← GP, with a cycle back to P
        { name: 'P', class: 'pr', type: 'Contains::Contained by', direction: 'upstream', sys_id: 'p1', parent: 'a1', depth: 1 },
        { name: 'GP', class: 'gp', type: 'Contains::Contained by', direction: 'upstream', sys_id: 'g1', parent: 'p1', depth: 2 },
        { name: 'P', class: 'pr', type: 'Contains::Contained by', direction: 'upstream', sys_id: 'p1', parent: 'g1', depth: 3 },
        // descendant chain: A → C → GC, with a cycle back to C
        { name: 'C', class: 'cn', type: 'Runs on::Runs', direction: 'downstream', sys_id: 'c1', parent: 'a1', depth: 1 },
        { name: 'GC', class: 'gc', type: 'Runs on::Runs', direction: 'downstream', sys_id: 'h1', parent: 'c1', depth: 2 },
        { name: 'C', class: 'cn', type: 'Runs on::Runs', direction: 'downstream', sys_id: 'c1', parent: 'h1', depth: 3 },
      ]
    );
    assert.ok(tree.includes('└─ ↑ P (pr) — Contains::Contained by'), 'root parent renders');
    assert.ok(tree.includes('   └─ ↑ GP (gp) — Contains::Contained by'), 'grandparent nests under parent');
    assert.ok(tree.includes('      └─ ↑ P (pr) — Contains::Contained by  ↺'), 'ancestor cycle collapses to ↺');
    assert.ok(tree.includes('└─ ↓ C (cn) — Runs on::Runs'), 'root child renders');
    assert.ok(tree.includes('   └─ ↓ GC (gc) — Runs on::Runs'), 'grandchild nests under child');
    assert.ok(tree.includes('      └─ ↓ C (cn) — Runs on::Runs  ↺'), 'descendant cycle collapses to ↺');
    assert.ok(tree.includes('**YOU ARE HERE** A (app)'), 'the CI sits between parents and children');
  });

  it('filters by direction', async () => {
    const { app } = await run({ direction: 'downstream' });
    const rows = app.okCalls[0].data.records;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.direction === 'downstream'));
    assert.ok(!rows.some((r) => r.sys_id === CLUSTER), 'upstream-only CLUSTER must be excluded');
  });

  it('--impact forces upstream only', async () => {
    const { app } = await run({ impact: true });
    const data = app.okCalls[0].data;
    assert.strictEqual(data.meta.direction, 'upstream');
    // Upstream from ROOT: nothing (root has no parents) — CLUSTER is only
    // reachable upstream from SERVER, which itself is a downstream child of ROOT.
    assert.strictEqual(data.meta.total, 0);
  });

  it('filters by relationship type substring', async () => {
    const { app } = await run({ type: 'Depends' });
    const rows = app.okCalls[0].data.records;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.type.toLowerCase().includes('depends')));
  });

  it('filters rows by class substring but still traverses through them', async () => {
    const { app } = await run({ class: 'server' });
    const data = app.okCalls[0].data;
    const rows = data.records;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.class.toLowerCase().includes('server')));
    // WEB (cmdb_ci_web_server) matches; CLUSTER (cmdb_ci_cluster) is filtered
    // from rows, but SERVER is still traversed, so its upstream CLUSTER rel is
    // walked and class-cached — the graph walk does not stop at filtered nodes.
    assert.ok(!rows.some((r) => r.sys_id === CLUSTER));
  });

  it('clamps --depth beyond the 1-5 range with a usage error', async () => {
    const { sdk } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const rel = subs.find((s) => s.command === 'relationships');
    await assert.rejects(rel.handler(baseArgv(app, { depth: 6 })), (err) => err.code === 'usage_error');
    await assert.rejects(rel.handler(baseArgv(app, { depth: 0 })), (err) => err.code === 'usage_error');
  });

  it('returns records-shaped output for the renderers', async () => {
    const { app } = await run({});
    const data = app.okCalls[0].data;
    assert.deepStrictEqual(data.columns, ['name', 'class', 'type', 'direction', 'sys_id', 'depth']);
    assert.strictEqual(data.table, 'cmdb_rel_ci');
    assert.strictEqual(data.count, data.records.length);
    assert.strictEqual(data.context.instance_url, 'https://example.service-now.com');
    assert.ok(app.okCalls[0].opts.summary.includes('relationship(s)'));
    assert.ok(Array.isArray(app.okCalls[0].opts.breadcrumbs) && app.okCalls[0].opts.breadcrumbs.length > 0);
  });
});
