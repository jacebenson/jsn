// Tests for the cmdb command — structure + relationship traversal with a
// mocked sdk layer (no live instance).

import { describe, it } from 'node:test';
import assert from 'node:assert';

const ROOT = 'a'.repeat(32);
const SERVER = 'b'.repeat(32);
const CLUSTER = 'c'.repeat(32);
const WEB = 'd'.repeat(32);
const PARENT = 'e'.repeat(32);
const SIB = 'f'.repeat(32);

const CI_NAMES = {
  [ROOT]: 'app1',
  [SERVER]: 'server1',
  [CLUSTER]: 'cluster1',
  [WEB]: 'web1',
  [PARENT]: 'cluster-p',
  [SIB]: 'sib1',
};

function relRecord(parent, child, type = 'Runs on::Runs') {
  const sysID = (id) => ({
    display_value: CI_NAMES[id] || id,
    link: `https://example.service-now.com/api/now/table/cmdb_ci/${id}`,
    value: id,
  });
  return {
    parent: sysID(parent),
    child: sysID(child),
    type: { display_value: type, link: `https://example.service-now.com/api/now/table/cmdb_rel_type/${type}`, value: `rel_${type}` },
  };
}

/**
 * Build a fake sdk that serves a tiny graph:
 *   ROOT --Runs on--> SERVER --Contained by--> CLUSTER
 * plus one extra downstream child of ROOT (WEB) for direction filtering.
 * With `withSiblings`, ROOT gains a parent (PARENT) that also contains SIB,
 * so ROOT has parents + siblings for the show command.
 */
function makeSDK({ withSiblings = false } = {}) {
  const cis = {
    [ROOT]: { sys_id: ROOT, name: 'app1', sys_class_name: 'cmdb_ci_app_server', operational_status: 'Operational', install_status: 'Installed' },
    [SERVER]: { sys_id: SERVER, name: 'server1', sys_class_name: 'cmdb_ci_server' },
    [CLUSTER]: { sys_id: CLUSTER, name: 'cluster1', sys_class_name: 'cmdb_ci_cluster' },
    [WEB]: { sys_id: WEB, name: 'web1', sys_class_name: 'cmdb_ci_web_server' },
  };
  const rels = {
    [ROOT]: [
      relRecord(ROOT, SERVER, 'Runs on::Runs'),
      relRecord(ROOT, WEB, 'Depends on::Depends on'),
    ],
    [SERVER]: [relRecord(CLUSTER, SERVER, 'Contained by::Contains')],
    [CLUSTER]: [],
    [WEB]: [],
  };
  if (withSiblings) {
    cis[PARENT] = { sys_id: PARENT, name: 'cluster-p', sys_class_name: 'cmdb_ci_cluster' };
    cis[SIB] = { sys_id: SIB, name: 'sib1', sys_class_name: 'cmdb_ci_server' };
    rels[PARENT] = [
      relRecord(PARENT, ROOT, 'Contains::Contained by'),
      relRecord(PARENT, SIB, 'Contains::Contained by'),
    ];
    rels[SIB] = [];
  }
  const listCalls = [];
  return {
    sdk: {
      async list(table, params) {
        listCalls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit'), display: params.get('sysparm_display_value') });
        if (table === 'cmdb_rel_ci') {
          const q = params.get('sysparm_query');
          const match = q.match(/^parent=([0-9a-f]+)\^ORchild=\1$/);
          if (match) {
            const id = match[1];
            // Real Table API semantics: any rel whose parent OR child matches.
            return Object.values(rels).flat().filter((r) => r.parent.value === id || r.child.value === id);
          }
          return [];
        }
        if (table === 'cmdb_ci') {
          const q = params.get('sysparm_query');
          if (!q) {
            const all = Object.values(cis);
            return all.slice(0, Number(params.get('sysparm_limit')) || 5);
          }
          if (q.startsWith('sys_id=')) {
            const id = q.slice('sys_id='.length);
            return cis[id] ? [cis[id]] : [];
          }
          if (q.startsWith('name=')) {
            const name = q.slice('name='.length);
            const rows = Object.values(cis).filter((c) => c.name === name);
            return rows.slice(0, Number(params.get('sysparm_limit')) || 5);
          }
          return [];
        }
        return [];
      },
      async aggregateCount() {
        return 42;
      },
    },
    listCalls,
  };
}

function makeApp(sdk) {
  return {
    sdk,
    okCalls: [],
    requireInstance() {},
    output: { getFormat: () => 'auto' },
    getEffectiveInstance() {
      return 'https://example.service-now.com';
    },
    ok(data, opts) {
      this.okCalls.push({ data, opts });
    },
  };
}

function collectHandlers() {
  return import('../src/commands/cmdb.js').then(({ cmdbCmd }) => {
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = cmdbCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c) => {
        subcommands.push(typeof c === 'object' ? c : { command: c });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    return subcommands;
  });
}

function baseArgv(app, overrides = {}) {
  return {
    ci: ROOT,
    direction: 'both',
    depth: 3,
    type: undefined,
    class: undefined,
    impact: false,
    limit: 100,
    app,
    ...overrides,
  };
}

describe('cmdb command structure', () => {
  it('exports cmdbCmd', async () => {
    const { cmdbCmd } = await import('../src/commands/cmdb.js');
    assert.strictEqual(typeof cmdbCmd, 'function');
  });

  it('defines the relationships subcommand', async () => {
    const subs = await collectHandlers();
    assert.ok(subs.some((s) => s.command === 'relationships'));
  });

  it('defines list and show subcommands', async () => {
    const subs = await collectHandlers();
    assert.ok(subs.some((s) => s.command === 'list'));
    assert.ok(subs.some((s) => s.command.startsWith('show ')));
  });

  it('uses optional [subcommand] so bare `jsn cmdb` shows help, not a yargs error', async () => {
    const { cmdbCmd } = await import('../src/commands/cmdb.js');
    const cmd = cmdbCmd((fn) => fn);
    assert.match(cmd.command, /cmdb \[subcommand\]/);
    assert.doesNotMatch(cmd.command, /cmdb <subcommand>/);
  });
});

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

describe('cmdb list — CI listing', () => {
  async function run(argv) {
    const { sdk, listCalls } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const sub = subs.find((s) => s.command === 'list');
    await sub.handler({ query: undefined, columns: undefined, limit: 20, offset: 0, count: true, app, ...argv });
    return { app, listCalls };
  }

  it('lists cmdb_ci with default columns and display values', async () => {
    const { listCalls, app } = await run({});
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci');
    assert.ok(ciCall, 'should query cmdb_ci');
    assert.strictEqual(ciCall.fields, 'sys_id,name,operational_status,ip_address');
    assert.strictEqual(ciCall.display, 'all');
    const data = app.okCalls[0].data;
    assert.strictEqual(data.table, 'cmdb_ci');
    assert.strictEqual(data.pagination.total, 42);
    assert.strictEqual(data.records.length, 4);
    assert.ok(Array.isArray(app.okCalls[0].opts.breadcrumbs));
  });

  it('honors custom columns and encoded query', async () => {
    const { listCalls, app } = await run({ query: 'sys_class_name=cmdb_ci_server', columns: 'name,ip_address' });
    const ciCall = listCalls.find((c) => c.table === 'cmdb_ci');
    assert.strictEqual(ciCall.query, 'sys_class_name=cmdb_ci_server');
    assert.strictEqual(ciCall.fields, 'sys_id,name,ip_address');
    assert.strictEqual(app.okCalls[0].data.columns.join(','), 'name,ip_address');
  });
});

describe('cmdb show — CI details', () => {
  async function run(argv, { withSiblings = false } = {}) {
    const { sdk, listCalls } = makeSDK({ withSiblings });
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const sub = subs.find((s) => s.command.startsWith('show '));
    await sub.handler({ columns: undefined, app, ...argv });
    return { app, listCalls };
  }

  it('resolves by name and returns the full record with inline relationships', async () => {
    const { app } = await run({ ci: 'app1' });
    const data = app.okCalls[0].data;
    assert.strictEqual(data.sys_id, ROOT);
    assert.strictEqual(data.name, 'app1');
    assert.strictEqual(data._context.table, 'cmdb_ci');
    // ROOT has two direct children in the fixture (SERVER downstream, WEB downstream)
    assert.ok(data.relationships, 'show should inline relationships');
    assert.strictEqual(data.relationships.parents.length, 0);
    assert.strictEqual(data.relationships.children.length, 2);
    assert.strictEqual(data.relationships.counts.children, 2);
    assert.ok(app.okCalls[0].opts.summary.includes('2 child(ren)'));
  });

  it('shows parents and siblings via parent traversal', async () => {
    const { app } = await run({ ci: 'app1' }, { withSiblings: true });
    const data = app.okCalls[0].data;
    const rel = data.relationships;
    assert.strictEqual(rel.parents.length, 1);
    assert.strictEqual(rel.parents[0].sys_id, PARENT);
    assert.strictEqual(rel.parents[0].direction, 'upstream');
    assert.strictEqual(rel.siblings.length, 1);
    assert.strictEqual(rel.siblings[0].sys_id, SIB);
    assert.strictEqual(rel.siblings[0].via, 'cluster-p', 'siblings should note the shared parent');
    assert.strictEqual(rel.counts.parents, 1);
    assert.strictEqual(rel.counts.siblings, 1);
    assert.strictEqual(rel.counts.children, 2);
  });

  it('renders a curated styled card in _formatted', async () => {
    const { app } = await run({ ci: 'app1' }, { withSiblings: true });
    const card = app.okCalls[0].data._formatted;
    assert.ok(card.includes('app1 (cmdb_ci_app_server)'), 'card header should name the CI');
    assert.ok(card.includes('▶ Fields'), 'key fields section should render');
    assert.ok(card.includes('operational_status'), 'populated field should show');
    assert.ok(card.includes('Operational'), 'field value should show');
    assert.ok(card.includes('▶ Parents (1)'), 'parents group with count');
    assert.ok(card.includes('↑ cluster-p (cmdb_ci_cluster) — Contains::Contained by'), 'parent row with arrow');
    assert.ok(card.includes('▶ Siblings (1)'), 'siblings group with count');
    assert.ok(card.includes('↔ sib1 (cmdb_ci_server) — Contains::Contained by (via cluster-p)'), 'sibling row with via');
    assert.ok(card.includes('▶ Children (2)'), 'children group with count');
    assert.ok(!card.includes('warranty_expiration'), 'full field dump should not leak into the card');
  });

  it('skips the Fields section when no curated fields are populated', async () => {
    const { formatCMDBShow } = await import('../src/commands/cmdb.js');
    const card = formatCMDBShow(
      { name: 'bare', class: 'cmdb_ci', sys_id: 'x1' },
      { parents: [], siblings: [], children: [], counts: { parents: 0, siblings: 0, children: 0 } },
      { instanceURL: 'https://dev', record: { name: 'bare', sys_class_name: 'cmdb_ci' } }
    );
    assert.ok(!card.includes('▶ Fields'), 'no empty fields section');
    assert.ok(card.includes('▶ Parents (0)'), 'groups still render');
  });

  it('caps groups at 4 and points to relationships for the rest', async () => {
    const { formatCMDBShow } = await import('../src/commands/cmdb.js');
    const groups = {
      parents: [],
      siblings: [],
      children: [
        { name: 'c1', class: 'srv', type: 'Depends on::Used by', direction: 'downstream', sys_id: 'c1', depth: 1 },
        { name: 'c2', class: 'srv', type: 'Depends on::Used by', direction: 'downstream', sys_id: 'c2', depth: 1 },
        { name: 'c3', class: 'srv', type: 'Depends on::Used by', direction: 'downstream', sys_id: 'c3', depth: 1 },
        { name: 'c4', class: 'srv', type: 'Depends on::Used by', direction: 'downstream', sys_id: 'c4', depth: 1 },
      ],
      counts: { parents: 0, siblings: 0, children: 9 },
    };
    const card = formatCMDBShow({ name: 'app1', class: 'app', sys_id: 'root1' }, groups, { instanceURL: 'https://dev' });
    assert.ok(card.includes('▶ Children (9)'), 'group shows the true total');
    assert.ok(card.includes('… 5 more — run: jsn cmdb relationships --ci root1'), 'truncation points to the relationships command');
  });

  it('resolves by sys_id directly', async () => {
    const { app } = await run({ ci: ROOT });
    assert.strictEqual(app.okCalls[0].data.sys_id, ROOT);
  });

  it('breadcrumbs hint at relationships (the traversal entry point)', async () => {
    const { app } = await run({ ci: 'app1' });
    const crumbs = app.okCalls[0].opts.breadcrumbs;
    assert.ok(crumbs.some((b) => b.action === 'relationships' && b.cmd.includes(`--ci ${ROOT}`)), 'should link to all relationships');
    assert.ok(crumbs.some((b) => b.action === 'impact'), 'should link to impact analysis');
  });

  it('throws not_found for a missing CI', async () => {
    const { sdk } = makeSDK();
    const app = makeApp(sdk);
    const subs = await collectHandlers();
    const sub = subs.find((s) => s.command.startsWith('show '));
    await assert.rejects(sub.handler({ ci: 'ghost', columns: undefined, app }), (err) => err.code === 'not_found');
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
