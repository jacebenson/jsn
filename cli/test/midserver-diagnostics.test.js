import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { midserversCmd } from '../src/commands/midservers.js';
import { OutputWriter } from '../src/output.js';
import { mutationPaths } from '../src/capabilities.js';

function commands() {
  const children = [];
  const builder = { command(child) { children.push(child); return builder; } };
  midserversCmd(handler => handler).builder(builder);
  return children;
}

function fixture(records, format = 'json') {
  const queries = [];
  let text = '';
  const output = new OutputWriter({ format, writer: { isTTY: true, write: chunk => { text += chunk; } } });
  return {
    queries, text: () => text,
    app: {
      requireInstance: () => {},
      getEffectiveInstance: () => 'https://example.service-now.com',
      output,
      ok: (data, opts) => output.ok(data, opts),
      sdk: {
        list: async (table, params) => {
          queries.push({ table, query: params.get('sysparm_query'), limit: params.get('sysparm_limit'), offset: params.get('sysparm_offset') });
          return table === 'ecc_agent' ? [{ sys_id: { value: 'agent-id', display_value: 'oct12' }, name: 'oct12', status: 'Down', validated: 'false' }] : records;
        },
        create: () => assert.fail('diagnostics must not write'),
        update: () => assert.fail('diagnostics must not write'),
        delete: () => assert.fail('diagnostics must not delete'),
      },
    },
  };
}

function command(name) {
  const result = commands().find(c => c.command === `${name} [identifier]`);
  assert.ok(result, `${name} is registered`);
  return result;
}

describe('MID diagnostics', () => {
  it('filters unresolved issues by the raw MID sys_id and supports Down MIDs', async () => {
    const f = fixture([]);
    await command('issues').handler({ identifier: 'oct12', limit: 25, offset: 0 }, f.app);
    assert.deepEqual(f.queries[1], { table: 'ecc_agent_issue', query: 'mid_server=agent-id^state!=resolved^ORDERBYDESClast_detected', limit: '25', offset: '0' });
    const data = JSON.parse(f.text()).data;
    assert.equal(data.count, 0);
    assert.equal(data.mid_server, 'oct12');
    assert.match(data.url, /ecc_agent_issue_list\.do/);
    assert.match(decodeURIComponent(data.url), /mid_server=agent-id\^state!=resolved/);
  });

  it('includes resolved issues only with --all and preserves pagination', async () => {
    const f = fixture([{ sys_id: { value: 'issue-id', display_value: 'Issue' }, state: 'resolved', source: 'MID', message: 'fixed' }]);
    await command('issues').handler({ identifier: 'oct12', all: true, limit: 5, offset: 10 }, f.app);
    assert.equal(f.queries[1].query, 'mid_server=agent-id^ORDERBYDESClast_detected');
    assert.equal(f.queries[1].offset, '10');
    const record = JSON.parse(f.text()).data.records[0];
    assert.equal(record.url, 'https://example.service-now.com/ecc_agent_issue.do?sys_id=issue-id');
  });

  it('filters lifecycle events by configured name, not ECC prefix or sys_id', async () => {
    const f = fixture([{ sys_id: 'event-id', event: 'validated', message: '', sys_created_on: '2026-10-13 03:18:59' }], 'auto');
    await command('events').handler({ identifier: 'oct12', limit: 50, offset: 0 }, f.app);
    assert.equal(f.queries[1].table, 'mid_server_event');
    assert.equal(f.queries[1].query, 'agent=oct12^ORDERBYDESCsys_created_on');
    assert.match(f.text(), /validated/);
    assert.match(f.text(), /mid_server_event\.do\?sys_id=event-id/);
  });

  it('prints a useful empty result in terminal output', async () => {
    const f = fixture([], 'auto');
    await command('issues').handler({ identifier: 'oct12', limit: 50, offset: 0 }, f.app);
    assert.match(f.text(), /No unresolved issues/);
    assert.match(f.text(), /ecc_agent_issue_list\.do/);
  });

  it('requires an explicit MID outside interactive auto output', async () => {
    const f = fixture([]);
    for (const name of ['issues', 'events']) {
      await assert.rejects(command(name).handler({ limit: 50, offset: 0 }, f.app), /identifier is required/);
    }
    assert.equal(f.queries.length, 0);
    assert.equal(mutationPaths().some(p => p.join(' ') === 'midservers issues'), false);
    assert.equal(mutationPaths().some(p => p.join(' ') === 'midservers events'), false);
  });
});
