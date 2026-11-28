// Tests for approvals commands — structure, query building, state normalization
// Live-verified against dev227772 (sysapproval_approver schema, state choices).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { approvalsCmd } from '../src/commands/approvals.js';

// ─── Command Structure ───

describe('Approvals Command Structure', () => {
  it('should define all subcommands', async () => {
    const { approvalsCmd } = await import('../src/commands/approvals.js');
    const wrap = (fn) => fn;
    const cmd = approvalsCmd(wrap);
    const subcommands = [];
    const mockYargs = { command: (c) => { subcommands.push(typeof c === 'string' ? c : c.command); return mockYargs; } };
    cmd.builder(mockYargs);
    const names = subcommands.map(s => s.split(' ')[0]);
    for (const n of ['list', 'approve', 'reject', 'submit', 'history']) {
      assert.ok(names.includes(n), `missing subcommand: ${n}`);
    }
  });
});

// ─── State normalization ───

describe('normalizeApprovalState', () => {
  it('maps display labels to raw values', async () => {
    const { normalizeApprovalState } = await import('../src/commands/approvals.js');
    assert.strictEqual(normalizeApprovalState('Requested'), 'requested');
    assert.strictEqual(normalizeApprovalState('Approved'), 'approved');
    assert.strictEqual(normalizeApprovalState('Rejected'), 'rejected');
  });

  it('maps aliases and partials', async () => {
    const { normalizeApprovalState } = await import('../src/commands/approvals.js');
    assert.strictEqual(normalizeApprovalState('pending'), 'requested');
    assert.strictEqual(normalizeApprovalState('rej'), 'rejected');
    assert.strictEqual(normalizeApprovalState('any'), '');
    assert.strictEqual(normalizeApprovalState(''), '');
  });

  it('keeps raw values unchanged', async () => {
    const { normalizeApprovalState } = await import('../src/commands/approvals.js');
    assert.strictEqual(normalizeApprovalState('not_required'), 'not_required');
    assert.strictEqual(normalizeApprovalState('cancelled'), 'cancelled');
  });

  it('throws on unknown states', async () => {
    const { normalizeApprovalState } = await import('../src/commands/approvals.js');
    assert.throws(() => normalizeApprovalState('bogus'));
  });
});

// ─── Query building ───

describe('buildApproverQuery', () => {
  it('defaults to pending when no state', async () => {
    const { buildApproverQuery } = await import('../src/commands/approvals.js');
    assert.strictEqual(buildApproverQuery({}), '');
  });

  it('combines state, mine, record, and user query with ^', async () => {
    const { buildApproverQuery } = await import('../src/commands/approvals.js');
    const q = buildApproverQuery({
      state: 'requested',
      mineSysID: 'sys001',
      recordSysID: 'abc123',
      userQuery: 'order=1',
    });
    assert.strictEqual(q, 'state=requested^approver=sys001^document_id=abc123^order=1');
  });

  it('skips empty parts', async () => {
    const { buildApproverQuery } = await import('../src/commands/approvals.js');
    assert.strictEqual(buildApproverQuery({ state: 'approved' }), 'state=approved');
    assert.strictEqual(buildApproverQuery({ mineSysID: 'u1' }), 'approver=u1');
  });
});

// ─── Mock app helper ───

function mockApp({ listImpl, updateImpl, requestImpl } = {}) {
  const calls = { list: [], update: [], request: [] };
  const app = {
    getEffectiveInstance: () => 'https://dev.service-now.com',
    requireInstance: () => {},
    context: { username: 'jane.doe' },
    sdk: {
      baseURL: 'https://dev.service-now.com',
      request: async (endpoint, opts = {}) => {
        calls.request.push({ endpoint, method: opts.method || 'GET' });
        if (!requestImpl) throw new Error('unexpected request');
        return requestImpl(endpoint, opts);
      },
      list: async (table, params) => {
        calls.list.push({ table, params });
        return listImpl ? listImpl(table, params) : [];
      },
      update: async (table, sysID, data) => {
        calls.update.push({ table, sysID, data });
        return updateImpl ? updateImpl(table, sysID, data) : { sys_id: sysID, ...data };
      },
    },
  };
  return { app, calls };
}

// ─── Helpers ───

describe('resolveTaskRecord', () => {
  it('queries task by number when not a sys_id', async () => {
    const { resolveTaskRecord } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp({
      listImpl: (table, params) => {
        assert.strictEqual(table, 'task');
        assert.match(params.get('sysparm_query'), /number=CHG0000082/);
        return [{ number: 'CHG0000082', sys_id: 'rec1' }];
      },
    });
    const rec = await resolveTaskRecord(app, 'CHG0000082');
    assert.strictEqual(rec.sys_id, 'rec1');
    assert.strictEqual(calls.list.length, 1);
  });

  it('queries by sys_id when 32-hex', async () => {
    const { resolveTaskRecord } = await import('../src/commands/approvals.js');
    const { app } = mockApp({
      listImpl: (table, params) => {
        assert.match(params.get('sysparm_query'), /sys_id=[0-9a-f]{32}/);
        return [{ sys_id: '00112233445566778899aabbccddeeff' }];
      },
    });
    await resolveTaskRecord(app, '00112233445566778899aabbccddeeff');
  });

  it('throws not found on empty result', async () => {
    const { resolveTaskRecord } = await import('../src/commands/approvals.js');
    const { app } = mockApp({ listImpl: () => [] });
    await assert.rejects(() => resolveTaskRecord(app, 'CHG0009999'));
  });

  it('rejects unsafe identifiers', async () => {
    const { resolveTaskRecord } = await import('../src/commands/approvals.js');
    const { app } = mockApp();
    await assert.rejects(() => resolveTaskRecord(app, 'CHG^state=1'));
  });
});

describe('approvalRowsForRecord', () => {
  it('filters by document_id', async () => {
    const { approvalRowsForRecord } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp({ listImpl: () => [{ state: 'Requested' }] });
    const rows = await approvalRowsForRecord(app, 'rec1');
    assert.strictEqual(calls.list[0].table, 'sysapproval_approver');
    assert.match(calls.list[0].params.get('sysparm_query'), /document_id=rec1/);
    assert.strictEqual(rows.length, 1);
  });
});

describe('setApprovalState', () => {
  it('updates the approver row state', async () => {
    const { setApprovalState } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp({ updateImpl: (t, id, d) => ({ sys_id: id, ...d }) });
    const updated = await setApprovalState(app, 'appr1', 'approved', 'looks good');
    assert.deepStrictEqual(calls.update[0], {
      table: 'sysapproval_approver',
      sysID: 'appr1',
      data: { state: 'approved', comments: 'looks good' },
    });
    assert.strictEqual(updated.state, 'approved');
  });

  it('omits comments when empty', async () => {
    const { setApprovalState } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp();
    await setApprovalState(app, 'appr1', 'rejected');
    assert.deepStrictEqual(calls.update[0].data, { state: 'rejected' });
  });
});

describe('resolveCurrentUserSysID', () => {
  it('uses ui/me when available', async () => {
    const { resolveCurrentUserSysID } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp({
      requestImpl: (endpoint) => {
        assert.match(endpoint, /api\/now\/ui\/me/);
        return { result: { userID: 'me001' } };
      },
    });
    const id = await resolveCurrentUserSysID(app);
    assert.strictEqual(id, 'me001');
    assert.strictEqual(calls.request.length, 1);
  });

  it('falls back to profile username when ui/me is missing', async () => {
    const { resolveCurrentUserSysID } = await import('../src/commands/approvals.js');
    const { app } = mockApp({
      requestImpl: () => { throw new Error('400 not found'); },
      listImpl: (table, params) => {
        assert.strictEqual(table, 'sys_user');
        assert.match(params.get('sysparm_query'), /user_name=jane\.doe/);
        return [{ sys_id: 'usr001' }];
      },
    });
    const id = await resolveCurrentUserSysID(app);
    assert.strictEqual(id, 'usr001');
  });

  it('throws a clear hint when the user cannot be resolved', async () => {
    const { resolveCurrentUserSysID } = await import('../src/commands/approvals.js');
    const { app } = mockApp({
      requestImpl: () => { throw new Error('400 not found'); },
      listImpl: () => [],
    });
    await assert.rejects(() => resolveCurrentUserSysID(app), /Cannot resolve the current user/);
  });
});

describe('submitForApproval', () => {
  it('sets approval=requested on the record', async () => {
    const { submitForApproval } = await import('../src/commands/approvals.js');
    const { app, calls } = mockApp();
    await submitForApproval(app, 'change_request', 'rec1');
    assert.deepStrictEqual(calls.update[0], {
      table: 'change_request',
      sysID: 'rec1',
      data: { approval: 'requested' },
    });
  });
});

// ─── approve / reject read the row first ───

describe('approvals approve and reject', () => {
  const ID = 'a'.repeat(32);
  const ref = (value, display_value) => ({ value, display_value });
  function fixture({ state = 'requested', approver = 'me001', rows, caller = 'me001' } = {}) {
    const commands = [];
    const builder = { command(c) { commands.push(c); return this; } };
    approvalsCmd(fn => fn).builder(builder);
    const reads = [];
    const writes = [];
    let meta = {};
    const app = {
      config: { profiles: {} },
      requireInstance: () => {},
      sdk: {
        baseURL: 'https://dev.service-now.com',
        request: async () => { if (!caller) throw new Error('400'); return { result: { userID: caller } }; },
        list: async () => [],
        listStrict: async (table, params) => {
          reads.push({ table, ...Object.fromEntries(params) });
          return rows ?? [{
            sys_id: ref(ID, ID),
            state: ref(state, { requested: 'Requested', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', 'not requested': 'Not Yet Requested' }[state]),
            approver: ref(approver, approver === 'me001' ? 'Jane Doe' : 'Beth Anglin'),
            document_id: ref('d'.repeat(32), 'CHG0000082'),
          }];
        },
        update: async (table, sysID, data) => { writes.push({ table, sysID, data }); return { sys_id: sysID, document_id: 'CHG0000082', ...data }; },
      },
      ok(value, options = {}) { meta = options; },
    };
    const run = (verb, args = {}) => commands.find(c => c.command.startsWith(verb)).handler({ 'sys-id': ID, force: true, ...args }, app);
    return { run, reads, writes, get summary() { return meta.summary; } };
  }

  it('reads the row before writing a requested approval', async () => {
    for (const [verb, state, word] of [['approve', 'approved', 'Approved'], ['reject', 'rejected', 'Rejected']]) {
      const f = fixture();
      await f.run(verb, { comments: 'ok' });
      assert.deepStrictEqual(f.reads, [{
        table: 'sysapproval_approver', sysparm_query: `sys_id=${ID}`, sysparm_limit: '1',
        sysparm_display_value: 'all', sysparm_fields: 'sys_id,state,approver,document_id',
      }]);
      assert.deepStrictEqual(f.writes, [{ table: 'sysapproval_approver', sysID: ID, data: { state, comments: 'ok' } }]);
      assert.strictEqual(f.summary, `${word} CHG0000082`);
    }
  });

  it('refuses a row that is not requested and writes nothing', async () => {
    for (const verb of ['approve', 'reject']) {
      for (const [state, label] of [['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['not requested', 'Not Yet Requested']]) {
        const f = fixture({ state });
        await assert.rejects(f.run(verb), (err) => {
          assert.strictEqual(err.code, 'usage_error');
          assert.match(err.message, new RegExp(`is ${label}; only a Requested approval`));
          assert.match(err.hint, /jsn approvals history CHG0000082/);
          return true;
        });
        assert.deepStrictEqual(f.writes, [], `${verb} wrote a ${state} row`);
      }
    }
  });

  it('refuses a missing or mismatched row and writes nothing', async () => {
    for (const rows of [[], [{ sys_id: ref('b'.repeat(32), 'b'.repeat(32)), state: ref('requested', 'Requested') }]]) {
      const f = fixture({ rows });
      await assert.rejects(f.run('approve'), (err) => err.code === 'not_found');
      assert.deepStrictEqual(f.writes, []);
    }
  });

  it('refuses an unsafe sys_id before any read', async () => {
    const f = fixture();
    await assert.rejects(f.run('reject', { 'sys-id': 'x^state=requested' }));
    assert.deepStrictEqual(f.reads, []);
    assert.deepStrictEqual(f.writes, []);
  });

  it('names the approver when it is not the caller', async () => {
    const f = fixture({ approver: 'u777' });
    await f.run('approve');
    assert.strictEqual(f.summary, 'Approved CHG0000082 (approver: Beth Anglin)');
    const unknown = fixture({ approver: 'u777', caller: '' });
    await unknown.run('reject');
    assert.strictEqual(unknown.summary, 'Rejected CHG0000082 (approver: Beth Anglin)');
  });

  it('names the approver in the confirmation and writes nothing when it is refused', async () => {
    const prior = process.env.JSN_NO_PROMPTS;
    process.env.JSN_NO_PROMPTS = '1';
    try {
      const f = fixture({ approver: 'u777' });
      await assert.rejects(f.run('approve', { force: false }), (err) => {
        assert.strictEqual(err.code, 'confirmation_required');
        assert.match(err.message, /Approve approval request a{32} for CHG0000082\? Its approver is Beth Anglin\./);
        return true;
      });
      assert.deepStrictEqual(f.writes, []);
    } finally {
      if (prior === undefined) delete process.env.JSN_NO_PROMPTS; else process.env.JSN_NO_PROMPTS = prior;
    }
  });
});
