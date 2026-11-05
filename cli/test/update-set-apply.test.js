// Preview / problem inspection / commit for retrieved update sets (#298).
//
// The instance contract under test: which platform endpoint is called, that
// progress is followed, that state is verified after the operation, that
// unresolved preview problems block a commit, and that nothing changes state
// without an explicit command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { yargs } from '../src/cli-adapter.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';
import { SDKClient } from '../src/sdk.js';
import { collectCapabilities, mutationPaths } from '../src/capabilities.js';
import { createMockFetch } from './helpers/mock-transport.js';
import {
  assertNoUnresolvedProblems,
  isSuccessfulProgress,
  listPreviewProblems,
  normalizePreviewProblem,
  normalizeProgress,
  waitForCicdProgress,
} from '../src/update-set-apply.js';

const REMOTE_ID = 'a'.repeat(32);
const LOCAL_ID = 'c'.repeat(32);

async function run(args, app) {
  await yargs(['updatesets', ...args]).strictCommands().strictOptions()
    .option('json', { type: 'boolean' }).option('format', { type: 'string' })
    .command(updateSetsCmd(handler => argv => handler(argv, app)))
    .fail((message, error) => { throw error || new Error(message); }).parse();
}

function problem(overrides = {}) {
  return {
    sys_id: 'b'.repeat(32),
    remote_update_set: { display_value: 'AI in a Box 3.1.6', value: REMOTE_ID },
    description: 'Could not find a record in sc_cat_item for column cat_item referenced in this update',
    type: 'error',
    status: '',
    missing_item_table: 'sc_cat_item',
    missing_item: 'd'.repeat(32),
    ...overrides,
  };
}

function fixture({ state = 'loaded', afterState = 'previewed', problems = [], localSets = [], localRef = LOCAL_ID } = {}) {
  const calls = [];
  const results = [];
  let current = state;
  const app = {
    requireInstance: () => calls.push(['requireInstance']),
    getEffectiveInstance: () => 'https://target.service-now.com',
    ok: (data, opts) => results.push({ data, opts }),
    sdk: {
      baseURL: 'https://target.service-now.com',
      list: async (table, params) => {
        calls.push(['list', table, params.get('sysparm_query')]);
        if (table === 'sys_remote_update_set') {
          return [{
            sys_id: REMOTE_ID,
            name: 'AI in a Box 3.1.6',
            state: current,
            remote_sys_id: 'e'.repeat(32),
            update_set: localRef
              ? { display_value: 'AI in a Box 3.1.6', link: `https://target.service-now.com/api/now/table/sys_update_set/${localRef}` }
              : { display_value: '', link: '' },
          }];
        }
        if (table === 'sys_update_preview_problem') return structuredClone(problems);
        if (table === 'sys_update_set') return structuredClone(localSets);
        return [];
      },
      get: async (table, id) => {
        calls.push(['get', table, id]);
        if (table === 'sys_update_set') return structuredClone(localSets.find((record) => record.sys_id === id) || null);
        return null;
      },
      listUpdateSetPreviewProblems: async (sysID) => {
        calls.push(['listUpdateSetPreviewProblems', sysID]);
        return listPreviewProblems({ listStrict: async () => structuredClone(problems) }, sysID);
      },
      previewUpdateSet: async (sysID, opts) => {
        calls.push(['previewUpdateSet', sysID, opts]);
        current = afterState;
        return { status: '2', label: 'successful', percent_complete: 100, message: '', tracked: true };
      },
      commitUpdateSet: async (sysID, opts) => {
        calls.push(['commitUpdateSet', sysID, opts]);
        current = afterState;
        return { status: '2', label: 'successful', percent_complete: 100, message: '', tracked: true };
      },
      importUpdateSet: async () => assert.fail('import must not upload'),
    },
  };
  return { app, calls, results, remoteId: REMOTE_ID, localId: LOCAL_ID };
}

// ── domain ──────────────────────────────────────────────────────────────

test('normalizeProgress reads the sn_cicd dispatch shape and its status words', () => {
  assert.deepEqual(
    (({ status, label, percent_complete, progress_id }) => ({ status, label, percent_complete, progress_id }))(
      normalizeProgress({ result: { status: '1', percent_complete: 40, links: { progress: { id: 'p1' } } } }),
    ),
    { status: '1', label: 'running', percent_complete: 40, progress_id: 'p1' },
  );
  assert.equal(normalizeProgress({ result: { status: '3', status_message: 'boom' } }).label, 'failed');
  assert.equal(isSuccessfulProgress(normalizeProgress({ result: { status: '2' } })), true);
  assert.equal(isSuccessfulProgress(normalizeProgress({ result: { status: '3' } })), false);
});

test('normalizeProgress keeps the platform error when status_message is empty', () => {
  // Live sn_cicd progress bodies carry status_message:"" and put the reason in
  // error. Empty strings must not mask the real failure text.
  const progress = normalizeProgress({
    result: { status: '3', status_label: 'Failed', status_message: '', status_detail: '', error: 'Preview failed: boom' },
  });
  assert.equal(progress.message, 'Preview failed: boom');
});

test('waitForCicdProgress follows the tracker until it is terminal', async () => {
  const seen = [];
  const sdk = {
    baseURL: 'https://target.service-now.com',
    request: async (url) => {
      seen.push(url);
      if (seen.length === 1) return { result: { status: '1', percent_complete: 10, links: { progress: { id: 'p1' } } } };
      if (seen.length === 2) return { result: { status: '1', percent_complete: 60, links: { progress: { id: 'p1' } } } };
      return { result: { status: '2', percent_complete: 100 } };
    },
  };
  const final = await waitForCicdProgress(sdk, { result: { status: '0', links: { progress: { id: 'p1' } } } }, { wait: async () => {} });
  assert.equal(final.status, '2');
  assert.equal(seen[0], 'https://target.service-now.com/api/sn_cicd/progress/p1');
  assert.equal(seen.length, 3);
});

test('waitForCicdProgress times out without retrying the operation', async () => {
  let clock = 0;
  const sdk = {
    baseURL: 'https://target.service-now.com',
    request: async () => ({ result: { status: '1', links: { progress: { id: 'p1' } } } }),
  };
  await assert.rejects(
    waitForCicdProgress(sdk, { result: { status: '1', links: { progress: { id: 'p1' } } } },
      { timeoutMs: 5000, pollMs: 1000, wait: async () => { clock += 2000; }, now: () => clock }),
    (error) => {
      assert.equal(error.code, 'api_error');
      assert.match(error.message, /may still be running/i);
      return true;
    },
  );
});

test('preview problems: resolved statuses are excluded from the unresolved set', () => {
  const open = normalizePreviewProblem(problem());
  assert.equal(open.resolved, false);
  assert.equal(open.description.includes('sc_cat_item'), true);
  assert.equal(normalizePreviewProblem(problem({ status: 'ignored' })).resolved, true);
  assert.equal(normalizePreviewProblem(problem({ status: 'Skipped' })).resolved, true);
  assert.throws(
    () => assertNoUnresolvedProblems({ problems: [open], unresolved: [open] }),
    (error) => {
      assert.equal(error.code, 'usage_error');
      assert.match(error.message, /Refusing to commit: 1 of 1 preview problem/);
      assert.match(error.message, /sc_cat_item/);
      assert.match(error.message, /does not resolve problems automatically/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertNoUnresolvedProblems({ problems: [], unresolved: [] }));
});

// ── platform endpoints ──────────────────────────────────────────────────

test('preview and commit call the CICD update set endpoints with POST', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const operations = [
    { result: { status: '2', percent_complete: 100 } },
    { result: { status: '2', percent_complete: 100 } },
  ];
  const jsonResponse = (body, status = 200) => ({
    ok: status < 300,
    status,
    headers: { get: () => 'application/json', getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  // The SDK passes a Request object, so read the method off the request itself.
  globalThis.fetch = async (request) => {
    requests.push({ url: request.url, method: request.method });
    if (/get_user|sys_scope/.test(request.url)) return jsonResponse({ result: [] });
    return jsonResponse(operations.shift());
  };
  try {
    const client = new SDKClient('https://target.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'token' }),
    });
    const preview = await client.previewUpdateSet(REMOTE_ID, { wait: async () => {} });
    const commit = await client.commitUpdateSet(REMOTE_ID, { wait: async () => {} });
    assert.equal(preview.status, '2');
    assert.equal(commit.status, '2');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests.filter(({ url }) => url.includes('/api/sn_cicd/')), [
    { url: `https://target.service-now.com/api/sn_cicd/update_set/preview/${REMOTE_ID}`, method: 'POST' },
    { url: `https://target.service-now.com/api/sn_cicd/update_set/commit/${REMOTE_ID}`, method: 'POST' },
  ]);
});

test('a missing CICD API reports that nothing was started', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch([{ status: 404, body: { error: { message: 'no such resource' } } }]);
  try {
    const client = new SDKClient('https://target.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'token' }),
    });
    await assert.rejects(client.previewUpdateSet(REMOTE_ID), (error) => {
      assert.equal(error.code, 'usage_error');
      assert.match(error.message, /not available on this instance; no preview was started/);
      assert.match(error.hint, /sn_cicd/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a 404 that names the update set is a failed operation, not a missing plugin', async () => {
  // Live sn_cicd returns 404 with a result envelope for an unknown set id.
  // That is not the same condition as the API route being absent.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch([{
    status: 404,
    body: { result: { status: '3', status_label: 'Failed', error: `Update set with id ${REMOTE_ID} cannot be found` } },
  }]);
  try {
    const client = new SDKClient('https://target.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'token' }),
    });
    await assert.rejects(client.previewUpdateSet(REMOTE_ID), (error) => {
      assert.equal(error.code, 'api_error');
      assert.match(error.message, /cannot be found/);
      assert.doesNotMatch(error.message, /not available on this instance/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed progress job surfaces the platform error text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch([
    { status: 200, body: { result: { status: '0', links: { progress: { id: 'p1' } } } } },
    { status: 200, body: { result: { status: '3', status_label: 'Failed', status_message: '', status_detail: '', error: 'Preview failed: exploded' } } },
  ]);
  try {
    const client = new SDKClient('https://target.service-now.com', {
      getCredentials: async () => ({ auth_method: 'oauth', access_token: 'token' }),
    });
    await assert.rejects(client.previewUpdateSet(REMOTE_ID, { wait: async () => {} }), (error) => {
      assert.equal(error.code, 'api_error');
      assert.match(error.message, /exploded/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preview problem listing uses the strict table seam', async () => {
  let used = null;
  const sdk = {
    list: async () => { throw new Error('best-effort list must not be used for a commit gate'); },
    listStrict: async (table, params) => {
      used = [table, params.get('sysparm_query')];
      return [];
    },
  };
  const result = await listPreviewProblems(sdk, REMOTE_ID);
  assert.equal(result.count, 0);
  assert.equal(used[0], 'sys_update_preview_problem');
  assert.match(used[1], /remote_update_set=/);
});

// ── commands ────────────────────────────────────────────────────────────

test('capabilities declare preview/commit as mutations and problems as a read', () => {
  const caps = collectCapabilities().get('updatesets');
  assert.ok(caps.mutationSubcommands.includes('preview'));
  assert.ok(caps.mutationSubcommands.includes('commit'));
  assert.ok(!caps.mutationSubcommands.includes('problems'));
  assert.ok(mutationPaths().some((p) => p[0] === 'updatesets' && p[1] === 'commit'));
});

test('preview requires confirmation before any platform call', async () => {
  const { app, calls } = fixture();
  await assert.rejects(run(['preview', REMOTE_ID, '--json'], app), (error) => {
    assert.equal(error.code, 'confirmation_required');
    assert.match(error.hint, /updatesets preview/);
    assert.match(error.hint, /--yes/);
    return true;
  });
  assert.equal(calls.some(([kind]) => kind === 'previewUpdateSet'), false);
});

test('preview reports progress, verified state, and unresolved problems', async () => {
  const { app, calls, results } = fixture({ problems: [problem(), problem({ sys_id: 'f'.repeat(32), status: 'skipped' })] });
  await run(['preview', REMOTE_ID, '--yes', '--timeout', '30', '--json'], app);
  const { data, opts } = results[0];
  assert.equal(data.state, 'previewed');
  assert.equal(data.preview.status, 'successful');
  assert.equal(data.problems, 2);
  assert.equal(data.unresolved, 1);
  assert.equal(data.problems_detail.length, 2);
  assert.match(opts.summary, /1 unresolved problem\(s\) of 2/);
  const previewCall = calls.find(([kind]) => kind === 'previewUpdateSet');
  assert.deepEqual(previewCall.slice(1), [REMOTE_ID, { timeoutMs: 30000 }]);
});

test('preview refuses a committed retrieved set and a failed state verification', async () => {
  const committed = fixture({ state: 'committed' });
  await assert.rejects(run(['preview', REMOTE_ID, '--yes'], committed.app), /Cannot preview a retrieved update set in state "committed"/);
  assert.equal(committed.calls.some(([kind]) => kind === 'previewUpdateSet'), false);

  const stuck = fixture({ afterState: 'loaded' });
  await assert.rejects(run(['preview', REMOTE_ID, '--yes'], stuck.app), (error) => {
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /will not commit a set the platform has not previewed/);
    return true;
  });
});

test('problems is read-only and hides resolved rows unless asked', async () => {
  const problems = [problem(), problem({ sys_id: 'f'.repeat(32), status: 'ignored', description: 'stale' })];
  const { app, calls, results } = fixture({ state: 'previewed', problems });
  await run(['problems', REMOTE_ID], app);
  assert.equal(results[0].data.count, 2);
  assert.equal(results[0].data.unresolved, 1);
  assert.deepEqual(results[0].data.problems.map((p) => p.sys_id), ['b'.repeat(32)]);
  assert.equal(calls.some(([kind]) => kind.startsWith('preview') || kind.startsWith('commit')), false);

  await run(['problems', REMOTE_ID, '--include-resolved'], app);
  assert.equal(results[1].data.problems.length, 2);
});

test('commit refuses a set that was never previewed', async () => {
  const { app, calls } = fixture({ state: 'loaded' });
  await assert.rejects(run(['commit', REMOTE_ID, '--yes'], app), /has not been previewed yet/);
  assert.equal(calls.some(([kind]) => kind === 'commitUpdateSet'), false);
});

test('commit refuses unresolved preview problems without applying anything', async () => {
  const { app, calls } = fixture({ state: 'previewed', problems: [problem()] });
  await assert.rejects(run(['commit', REMOTE_ID, '--yes'], app), (error) => {
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /Refusing to commit: 1 of 1 preview problem/);
    return true;
  });
  assert.equal(calls.some(([kind]) => kind === 'commitUpdateSet'), false);
});

test('commit verifies the committed state and reports the local update set', async () => {
  const { app, calls, results } = fixture({
    state: 'previewed', afterState: 'committed', problems: [problem({ status: 'ignored' })],
    localSets: [{ sys_id: LOCAL_ID, name: 'AI in a Box 3.1.6', state: 'in progress' }],
  });
  await run(['commit', REMOTE_ID, '--yes', '--timeout', '45', '--json'], app);
  assert.equal(results[0].data.state, 'committed');
  assert.equal(results[0].data.preview_problems, 1);
  assert.equal(results[0].data.local_update_set.sys_id, LOCAL_ID);
  const commitCall = calls.find(([kind]) => kind === 'commitUpdateSet');
  assert.deepEqual(commitCall.slice(1), [REMOTE_ID, { timeoutMs: 45000 }]);
});

test('commit prefers the retrieved record\'s local-copy reference over a duplicate name', async () => {
  // Live sys_remote_update_set.update_set points at the exact local set the
  // commit produced. A duplicate name must not turn that into ambiguity.
  const other = '1'.repeat(32);
  const { app, calls, results } = fixture({
    state: 'previewed', afterState: 'committed',
    localSets: [
      { sys_id: other, name: 'AI in a Box 3.1.6', state: 'complete' },
      { sys_id: LOCAL_ID, name: 'AI in a Box 3.1.6', state: 'complete' },
    ],
    localRef: LOCAL_ID,
  });
  await run(['commit', REMOTE_ID, '--yes', '--json'], app);
  assert.equal(results[0].data.local_update_set.sys_id, LOCAL_ID);
  assert.equal(results[0].data.local_update_set.ambiguous, false);
  assert.ok(calls.some(([kind, table, id]) => kind === 'get' && table === 'sys_update_set' && id === LOCAL_ID));
});

test('commit reports an ambiguous local copy instead of guessing', async () => {
  const { app, results } = fixture({
    state: 'previewed', afterState: 'committed', localRef: null,
    localSets: [{ sys_id: LOCAL_ID, name: 'AI in a Box 3.1.6' }, { sys_id: '1'.repeat(32), name: 'AI in a Box 3.1.6' }],
  });
  await run(['commit', REMOTE_ID, '--yes'], app);
  assert.equal(results[0].data.local_update_set.sys_id, undefined);
  assert.equal(results[0].data.local_update_set.ambiguous, true);
  assert.match(results[0].opts.summary, /Multiple local update sets share this name/);
});

test('import refuses the proposed rename/local/state modifiers before touching the instance', async () => {
  for (const [args, pattern] of [
    [['import', 'missing.xml', '--name', 'Renamed'], /cannot rename a retrieved update set/],
    [['import', 'missing.xml', '--local'], /does not convert XML into a local capture set/],
    [['import', 'missing.xml', '--state', 'complete'], /Import never sets state/],
  ]) {
    const { app, calls } = fixture();
    await assert.rejects(run(args, app), (error) => {
      assert.equal(error.code, 'usage_error');
      assert.match(error.message, pattern);
      return true;
    });
    assert.deepEqual(calls, []);
  }
});
