// Audit #5: a failed aggregate count must never become an invented empty
// success (count: 0, records: []) — and it must not silently swallow the
// failure either. The count is unknown; only a real list response decides
// emptiness, and a list failure surfaces as an error.
//
// Reproduction (pre-fix): with aggregateCount throwing, interactiveList
// returned null and _ticket.js rendered `count: 0, records: []` while the
// list method was never called.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormatAuto } from '../src/output.js';
import { interactiveList } from '../src/helpers.js';

function makeApp(sdk) {
  return {
    sdk,
    requireInstance() {},
    output: { getFormat: () => FormatAuto },
  };
}

/** Prompt stub: records what the picker was told and returns the first choice. */
function pickerStub(capture) {
  return async (config) => {
    capture.totalCount = config.totalCount;
    const items = await config.source(undefined, 0, {});
    capture.items = items;
    return items[0];
  };
}

const RECORD = { sys_id: 'abc', name: 'incident-1' };

describe('interactiveList count failure', () => {
  it('does the bounded list request and returns records with an unknown (null) total', async () => {
    const calls = [];
    const capture = {};
    const app = makeApp({
      aggregateCount: async () => { throw new Error('synthetic forbidden aggregate'); },
      list: async (table, params) => {
        calls.push({ table, limit: params.get('sysparm_limit') });
        return [RECORD];
      },
    });

    const picked = await interactiveList({
      app, table: 'incident', singular: 'incident', columns: ['number'],
      labelField: 'number', promptFn: pickerStub(capture),
    });

    assert.deepEqual(picked, RECORD, 'a real record must come back, not an empty result');
    assert.equal(calls.length >= 1, true, 'the list must be attempted after the count failed');
    assert.equal(capture.items.length, 1, 'the picker must receive the loaded records');
    assert.equal(capture.totalCount, null, 'unknown total must be null, never 0');
  });

  it('surfaces the failure when the count AND the list both fail', async () => {
    const app = makeApp({
      aggregateCount: async () => { throw new Error('synthetic forbidden aggregate'); },
      list: async () => { throw new Error('synthetic list denied'); },
    });

    await assert.rejects(
      () => interactiveList({
        app, table: 'incident', singular: 'incident', columns: ['number'],
        labelField: 'number', promptFn: pickerStub({}),
      }),
      /Could not list incident: synthetic list denied \(aggregate count also failed: synthetic forbidden aggregate\)/
    );
  });

  it('treats an empty list as measured-empty when the count failed', async () => {
    const app = makeApp({
      aggregateCount: async () => { throw new Error('synthetic forbidden aggregate'); },
      list: async () => [],
    });

    const picked = await interactiveList({
      app, table: 'incident', singular: 'incident', columns: ['number'],
      labelField: 'number', promptFn: pickerStub({}),
    });

    assert.equal(picked, null, 'the empty result is confirmed by a real list response');
  });

  it('a genuine zero count is still a fast empty result with no list call', async () => {
    let listCalls = 0;
    const app = makeApp({
      aggregateCount: async () => 0,
      list: async () => { listCalls += 1; return []; },
    });

    const picked = await interactiveList({
      app, table: 'incident', singular: 'incident', columns: ['number'],
      labelField: 'number', promptFn: pickerStub({}),
    });

    assert.equal(picked, null);
    assert.equal(listCalls, 0, 'a measured zero needs no list request');
  });

  it('a measured non-zero count goes straight to the picker', async () => {
    const capture = {};
    const app = makeApp({
      aggregateCount: async () => 3,
      list: async () => [RECORD],
    });

    await interactiveList({
      app, table: 'incident', singular: 'incident', columns: ['number'],
      labelField: 'number', promptFn: pickerStub(capture),
    });

    assert.equal(capture.totalCount, 3);
  });
});
