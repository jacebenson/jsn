// Tests for the shared record resolver (src/resolve-record.js) and the
// widened interactiveList query seam (src/helpers.js).

import { describe, it } from 'node:test';
import assert from 'node:assert';

const SYS_ID = 'a'.repeat(32);

function makeSdk(rows = [], capture = {}) {
  return {
    list: async (_table, params) => {
      capture.table = _table;
      capture.query = params.get('sysparm_query');
      capture.displayValue = params.get('sysparm_display_value');
      capture.limit = params.get('sysparm_limit');
      capture.fields = params.get('sysparm_fields');
      return rows;
    },
  };
}

describe('resolveRecord', () => {
  it('classifies a 32-char hex identifier as sys_id', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    const capture = {};
    const sdk = makeSdk([{ sys_id: SYS_ID, name: 'thing' }], capture);
    const rec = await resolveRecord(sdk, { table: 'sys_script', identifier: SYS_ID, matchField: 'name' });
    assert.strictEqual(capture.query, `sys_id=${SYS_ID}`);
    assert.strictEqual(rec.sys_id, SYS_ID);
  });

  it('queries matchField for non-sys_id identifiers', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    const capture = {};
    const sdk = makeSdk([{ sys_id: 'x1', name: 'My Rule' }], capture);
    await resolveRecord(sdk, { table: 'sys_script', identifier: 'My Rule', matchField: 'name' });
    assert.strictEqual(capture.query, 'name=My Rule');
  });

  it('always requests display values and limit=1', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    const capture = {};
    const sdk = makeSdk([{ sys_id: 'x1' }], capture);
    await resolveRecord(sdk, { table: 'sys_user', identifier: 'john.doe', matchField: 'user_name' });
    assert.strictEqual(capture.displayValue, 'all');
    assert.strictEqual(capture.limit, '1');
  });

  it('passes fields through as sysparm_fields when given', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    const capture = {};
    const sdk = makeSdk([{ sys_id: 'x1' }], capture);
    await resolveRecord(sdk, { table: 't', identifier: 'n', matchField: 'name', fields: ['sys_id', 'name'] });
    assert.strictEqual(capture.fields, 'sys_id,name');
  });

  it('throws a not_found AppError naming the resource and identifier', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    const sdk = makeSdk([]);
    await assert.rejects(
      () => resolveRecord(sdk, { table: 'sys_user', identifier: 'ghost', matchField: 'user_name', resource: 'User' }),
      (err) => {
        assert.strictEqual(err.code, 'not_found');
        assert.strictEqual(err.message, 'User not found: ghost');
        return true;
      }
    );
  });

  it('rejects unsafe identifiers before hitting the SDK', async () => {
    const { resolveRecord } = await import('../src/resolve-record.js');
    let called = false;
    const sdk = { list: async () => { called = true; return []; } };
    await assert.rejects(
      () => resolveRecord(sdk, { table: 't', identifier: 'x^OR1=1', matchField: 'name' }),
      /Unsafe identifier/
    );
    assert.ok(!called);
  });
});

describe('resolveSysId', () => {
  it('returns the raw sys_id string from a wrapped or plain field', async () => {
    const { resolveSysId } = await import('../src/resolve-record.js');
    const sdk = makeSdk([{ sys_id: { value: 'raw123', display_value: 'raw123' } }]);
    assert.strictEqual(await resolveSysId(sdk, { table: 't', identifier: 'n', matchField: 'name' }), 'raw123');
    const sdk2 = makeSdk([{ sys_id: 'plain456' }]);
    assert.strictEqual(await resolveSysId(sdk2, { table: 't', identifier: 'n', matchField: 'name' }), 'plain456');
  });
});

describe('unwrapSysId', () => {
  it('unwraps {value} objects and passes through strings', async () => {
    const { unwrapSysId } = await import('../src/resolve-record.js');
    assert.strictEqual(unwrapSysId({ sys_id: { value: 'v1' } }), 'v1');
    assert.strictEqual(unwrapSysId({ sys_id: 'v2' }), 'v2');
  });
});

// ─── interactiveList query seam ───
// Regression: interactiveList accepted a `query` param (as `_query`) that was
// never wired into the request — callers passing a filter got unfiltered
// results. These tests stub paginatedSearch via a TTY-less path? No — the
// seam is exercised by stubbing `paginatedSearch` through a canPrompt-true
// environment, so instead we test the source-builder directly via a fake
// prompt. To keep this unit-testable without a TTY, interactiveList accepts
// an injectable promptFn.

describe('interactiveList query handling', () => {
  function makeApp(sdkCapture = {}, rows = []) {
    return {
      requireInstance: () => {},
      output: { getFormat: () => 'auto' },
      sdk: {
        list: async (_table, params) => {
          sdkCapture.query = params.get('sysparm_query');
          sdkCapture.offset = params.get('sysparm_offset');
          sdkCapture.fields = params.get('sysparm_fields');
          return rows;
        },
        aggregateCount: async (_table, query) => {
          sdkCapture.countQuery = query;
          return 100;
        },
      },
      getEffectiveInstance: () => 'https://dev.service-now.com',
    };
  }

  const promptCapture = {};
  function fakePrompt(config) {
    promptCapture.config = config;
    return Promise.resolve({ name: 'picked', value: { sys_id: 's1', name: 'Picked' } });
  }

  it('applies the caller query filter to count, browse, and search requests', async () => {
    const { interactiveList } = await import('../src/helpers.js');
    const capture = {};
    const app = makeApp(capture, [{ sys_id: 's1', name: 'Picked' }]);
    const picked = await interactiveList({
      app, table: 'sc_cat_item', singular: 'catalog item', columns: ['name'],
      query: 'active=true', labelField: 'name', promptFn: fakePrompt,
    });
    assert.ok(picked, 'should return the picked record');
    assert.strictEqual(capture.countQuery, 'active=true');
    // initial load (no term) must fold the filter in ahead of the ORDERBY
    assert.strictEqual(capture.query, 'active=true^ORDERBYDESCsys_updated_on');

    // now exercise the search branch
    await promptCapture.config.source('foo', undefined, {});
    assert.strictEqual(capture.query, 'active=true^nameLIKEfoo^ORDERBYDESCsys_updated_on');
  });

  it('works with no query (default behavior unchanged)', async () => {
    const { interactiveList } = await import('../src/helpers.js');
    const capture = {};
    const app = makeApp(capture, [{ sys_id: 's1', name: 'Picked' }]);
    await interactiveList({
      app, table: 'sys_user', singular: 'user', columns: ['user_name'],
      labelField: 'user_name', promptFn: fakePrompt,
    });
    assert.strictEqual(capture.countQuery, '');
    assert.strictEqual(capture.query, 'ORDERBYDESCsys_updated_on');
    await promptCapture.config.source('jo', undefined, {});
    assert.strictEqual(capture.query, 'user_nameLIKEjo^ORDERBYDESCsys_updated_on');
  });

  it('returns the full record by default and supports a custom message', async () => {
    const { interactiveList } = await import('../src/helpers.js');
    const app = makeApp({}, [{ sys_id: 's1', name: 'Picked' }]);
    const picked = await interactiveList({
      app, table: 't', singular: 'thing', columns: ['name'],
      message: 'Select a thing', promptFn: fakePrompt,
    });
    assert.deepStrictEqual(picked, { sys_id: 's1', name: 'Picked' });
    assert.strictEqual(promptCapture.config.message, 'Select a thing');
  });
});
