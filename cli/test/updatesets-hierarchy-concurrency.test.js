// Update-set hierarchy reads: one bounded pool, invocation-local dedupe,
// preorder output order, and per-parent failure isolation. Every assertion is
// made against a counting fixture transport; no instance is contacted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateSetHierarchy, formatUpdateSetDetail } from '../src/commands/updatesets.js';

const id = digit => String(digit).repeat(32);
const CHILD_QUERY = parent => `parent=${parent}^ORDERBYname`;

function record(sysID, name, parent = '') {
  return { sys_id: sysID, name, state: 'in progress', application: 'Global', parent };
}

/**
 * Counting Table API fixture for sys_update_set / sys_update_xml reads. It
 * records every query, tracks how many reads overlap, and fails only the parent
 * queries named in `failFor` so a partial failure stays attributable.
 */
function tableFixture({ records, childrenOf, failFor = new Set(), latencyMs = 5, payload = [], payloadError = null }) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  async function list(table, params) {
    const query = params.get('sysparm_query') || '';
    requests.push({ table, query });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      if (table === 'sys_update_xml') {
        if (payloadError) throw new Error(payloadError);
        return payload;
      }
      const byId = query.match(/^sys_id=([0-9a-f]{32})$/);
      if (byId) return records.has(byId[1]) ? [records.get(byId[1])] : [];
      const byParent = query.match(/^parent=([0-9a-f]{32})\^ORDERBYname$/);
      if (byParent) {
        if (failFor.has(byParent[1])) throw new Error(`children read failed for ${byParent[1]}`);
        return childrenOf.get(byParent[1]) || [];
      }
      throw new Error(`unexpected query: ${query}`);
    } finally {
      inFlight -= 1;
    }
  }
  return {
    app: { sdk: { list }, getEffectiveInstance: () => 'https://dev.service-now.com' },
    requests,
    get maxInFlight() { return maxInFlight; },
  };
}

describe('update set hierarchy reads', () => {
  it('reads each parent exactly once and keeps preorder order, depth and kind', async () => {
    const root = id(1);
    const alpha = id(2);
    const beta = id(3);
    const alphaOne = id(4);
    const alphaTwo = id(5);
    const records = new Map([
      [root, record(root, 'Root set')],
      [alpha, record(alpha, 'Alpha')],
      [beta, record(beta, 'Beta')],
      [alphaOne, record(alphaOne, 'Alpha one')],
      [alphaTwo, record(alphaTwo, 'Alpha two')],
    ]);
    const childrenOf = new Map([
      [root, [record(alpha, 'Alpha'), record(beta, 'Beta')]],
      [alpha, [record(alphaOne, 'Alpha one'), record(alphaTwo, 'Alpha two')]],
    ]);
    const fixture = tableFixture({ records, childrenOf });

    const { hierarchy, cycleIds, missingParents } = await buildUpdateSetHierarchy(fixture.app, record(root, 'Root set'));

    // Five parents are reachable; each is read once, no more and no less.
    assert.equal(fixture.requests.length, 5);
    assert.deepEqual(
      fixture.requests.map(request => request.query).sort(),
      [root, alpha, beta, alphaOne, alphaTwo].map(CHILD_QUERY).sort(),
    );
    assert.ok(fixture.requests.every(request => request.table === 'sys_update_set'));
    // Depth-first preorder is preserved even though siblings are read together.
    assert.deepEqual(
      hierarchy.map(row => [row.name, row.depth, row.kind, row.selected]),
      [
        ['Root set', 0, 'selected', true],
        ['Alpha', 1, 'descendant', false],
        ['Alpha one', 2, 'descendant', false],
        ['Alpha two', 2, 'descendant', false],
        ['Beta', 1, 'descendant', false],
      ],
    );
    assert.deepEqual(cycleIds, []);
    assert.deepEqual(missingParents, []);
  });

  it('bounds a wide level at four concurrent reads', async () => {
    const root = id(1);
    const childIds = [2, 3, 4, 5, 6, 7].map(id);
    const records = new Map([[root, record(root, 'Root set')]]);
    const childrenOf = new Map([[
      root,
      childIds.map((childID, index) => record(childID, `Child ${index + 1}`)),
    ]]);
    const fixture = tableFixture({ records, childrenOf, latencyMs: 15 });

    const { hierarchy } = await buildUpdateSetHierarchy(fixture.app, record(root, 'Root set'));

    assert.equal(fixture.requests.length, 7);
    assert.equal(fixture.maxInFlight, 4, 'six sibling reads must never exceed the pool of four');
    assert.deepEqual(
      hierarchy.map(row => row.name),
      ['Root set', 'Child 1', 'Child 2', 'Child 3', 'Child 4', 'Child 5', 'Child 6'],
    );
    assert.deepEqual(hierarchy.map(row => row.depth), [0, 1, 1, 1, 1, 1, 1]);
  });

  it('keeps ancestors and siblings when one parent read fails', async () => {
    const root = id(1);
    const alpha = id(2);
    const beta = id(3);
    const alphaOne = id(4);
    const records = new Map([
      [root, record(root, 'Root set')],
      [alpha, record(alpha, 'Alpha')],
      [beta, record(beta, 'Beta')],
      [alphaOne, record(alphaOne, 'Alpha one')],
    ]);
    const childrenOf = new Map([
      [root, [record(alpha, 'Alpha'), record(beta, 'Beta')]],
      [alpha, [record(alphaOne, 'Alpha one')]],
    ]);
    const fixture = tableFixture({ records, childrenOf, failFor: new Set([alpha]) });

    const { hierarchy } = await buildUpdateSetHierarchy(fixture.app, record(root, 'Root set'));

    // The failed branch is empty for that parent only; siblings keep their
    // order and depth, so one source cannot blank the others.
    assert.deepEqual(
      hierarchy.map(row => [row.name, row.depth]),
      [['Root set', 0], ['Alpha', 1], ['Beta', 1]],
    );
    assert.equal(fixture.requests.length, 3);
    assert.ok(fixture.requests.some(request => request.query === CHILD_QUERY(alpha)));
  });

  it('stops on a parent cycle without refetching a seen parent', async () => {
    const root = id(1);
    const alpha = id(2);
    const beta = id(3);
    const records = new Map([
      [root, record(root, 'Root set')],
      [alpha, record(alpha, 'Alpha')],
      [beta, record(beta, 'Beta')],
    ]);
    const childrenOf = new Map([
      [root, [record(alpha, 'Alpha')]],
      [alpha, [record(beta, 'Beta')]],
      [beta, [record(alpha, 'Alpha')]],
    ]);
    const fixture = tableFixture({ records, childrenOf });

    const { hierarchy, cycleIds } = await buildUpdateSetHierarchy(fixture.app, record(root, 'Root set'));

    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(hierarchy.map(row => [row.name, row.depth]), [['Root set', 0], ['Alpha', 1], ['Beta', 2]]);
    assert.deepEqual(cycleIds, [alpha]);
  });

  it('reads the member payload alongside the hierarchy and reports each failure separately', async () => {
    const root = id(1);
    const alpha = id(2);
    const records = new Map([
      [root, record(root, 'Root set')],
      [alpha, record(alpha, 'Alpha')],
    ]);
    const childrenOf = new Map([[root, [record(alpha, 'Alpha')]]]);
    const payload = [{ name: 'b.xml', sys_updated_on: '2026-08-11 09:00:00' }, { name: 'a.xml', sys_updated_on: '2026-08-10 09:00:00' }];

    const ok = tableFixture({ records, childrenOf, payload });
    const detail = await formatUpdateSetDetail(ok.app, record(root, 'Root set'));
    assert.deepEqual(detail.children, [{ name: 'b.xml', type: '?' }, { name: 'a.xml', type: '?' }]);
    assert.deepEqual(detail.hierarchy.map(row => row.name), ['Root set', 'Alpha']);
    assert.equal(ok.requests.filter(request => request.table === 'sys_update_xml').length, 1);
    // One record refetch, then one children list per reachable parent.
    assert.deepEqual(
      ok.requests.filter(request => request.table === 'sys_update_set').map(request => request.query).sort(),
      [`sys_id=${root}`, CHILD_QUERY(root), CHILD_QUERY(alpha)].sort(),
    );
    assert.ok(ok.maxInFlight >= 2, 'the payload read and the hierarchy must overlap');
    assert.ok(ok.maxInFlight <= 4);

    const broken = tableFixture({ records, childrenOf, payloadError: 'member read failed' });
    const degraded = await formatUpdateSetDetail(broken.app, record(root, 'Root set'));
    assert.deepEqual(degraded.children, []);
    assert.deepEqual(degraded.hierarchy.map(row => row.name), ['Root set', 'Alpha']);
    assert.ok(degraded._formatted.includes('Update set hierarchy:'));
    assert.ok(degraded._formatted.includes('Updates:   0'));
  });
});
