// Tests for the cmdb command — structure + relationship traversal with a
// mocked sdk layer (no live instance).

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  PARENT,
  ROOT,
  SIB,
  collectHandlers,
  makeApp,
  makeSDK,
} from './support/cmdb-fixtures.js';

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
