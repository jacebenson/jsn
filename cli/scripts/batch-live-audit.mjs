// Opt-in safety/transport evidence for the demo proof; never loaded normally.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SDKClient } from '../src/sdk.js';
const dir = process.env.JSN_BATCH_LIVE_EVIDENCE;
assert.ok(dir, 'Explicit evidence directory required');
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
const trace = path.join(dir, 'transport.jsonl');
const events = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const log = event => fs.appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const original = SDKClient.prototype.request;
SDKClient.prototype.request = async function(endpoint, options = {}) {
  const url = new URL(endpoint);
  assert.equal(url.origin, run.instance);
  const method = options.method || 'GET';
  const parts = url.pathname.split('/');
  const table = parts[4];
  const id = parts[5];
  if (method !== 'GET') {
    assert.ok(['POST', 'DELETE'].includes(method), `Prohibited method: ${method}`);
    assert.ok(run.tables.includes(table), `Prohibited write table: ${table}`);
    const effective = await original.call(this, `${this.baseURL}/api/now/ui/concoursepicker/updateset`, { method: 'GET', readOnly: true });
    assert.equal(effective?.result?.current?.sysId, run.default_set);
    log({ event: 'capture_checked', method, table, effective: effective.result.current });
    if (method === 'DELETE') assert.ok(events().some(e => e.event === 'response' && e.method === 'POST' && e.table === table && e.sys_id === id), `Not created in this run: ${table}/${id}`);
    if (method === 'POST') {
      const payload = JSON.parse(options.body);
      const known = events().filter(e => e.event === 'response' && e.method === 'POST').map(e => e.sys_id);
      const links = ['cat_item', 'catalog_item', 'ui_policy', 'catalog_variable', 'sys_data_policy', 'sp_page', 'sp_container', 'sp_row', 'sp_column', 'sys_security_acl'];
      for (const field of links.filter(field => payload[field])) {
        const parent = payload[field].replace(/^IO:/, '');
        assert.ok(known.includes(parent), `Parent not created in this run: ${field}=${parent}`);
      }
      assert.ok(Object.values(payload).some(v => typeof v === 'string' && (v.startsWith(run.marker) || known.includes(v.replace(/^IO:/, '')))), 'Missing run marker or owned parent');
    }
  }
  const event = { method, path: url.pathname + url.search, table, target: id || null };
  log({ event: 'request', ...event, ...(method === 'POST' ? { payload: JSON.parse(options.body) } : {}) });
  try {
    const result = await original.call(this, endpoint, options);
    log({ event: 'response', ...event, sys_id: result?.result?.sys_id || null,
      ...(Array.isArray(result?.result) ? { rows: result.result.length } : {}) });
    return result;
  } catch (error) {
    log({ event: 'error', ...event, code: error.code, message: error.message });
    throw error;
  }
};
