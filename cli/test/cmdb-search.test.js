import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdbSearchCmd } from '../src/commands/cmdb-search.js';
import { cmdbCmd } from '../src/commands/cmdb.js';
import { captureCommands } from './support/command-test-helpers.js';
const ID = 'a'.repeat(32);
function fixture(rows = []) {
  const calls = [], output = [];
  const app = { sdk: { listStrict: async (...args) => { calls.push(args); return rows; } }, ok: (data, options) => output.push({ data, options }) };
  return { calls, output, app, run: args => cmdbSearchCmd(fn => fn).handler({ limit: 2, offset: 0, ...args }, app) };
}
test('CMDB search covers four fields and repeats exact class scope in every branch', async () => {
  const f = fixture([{ sys_id: { value: ID, display_value: 'wrong' }, name: 'web1' }]);
  await f.run({ text: 'web', class: 'cmdb_ci_server', profile: 'work' });
  const [table, params] = f.calls[0];
  assert.equal(table, 'cmdb_ci');
  assert.equal(params.get('sysparm_query'), ['name','fqdn','ip_address','serial_number'].map(k => `${k}LIKEweb^sys_class_name=cmdb_ci_server`).join('^NQ') + '^ORDERBYname^ORDERBYsys_id');
  assert.equal(params.get('sysparm_limit'), '3');
  assert.equal(f.output[0].data.count, 1);
  assert.equal(f.output[0].options.breadcrumbs[0].cmd, `jsn cmdb show ${ID} --profile work`);
  assert.equal(f.output[0].data.pagination.has_more, false);
});
test('lookahead pagination keeps search, class and instance and does not expose the extra row', async () => {
  const f = fixture([{sys_id:ID},{sys_id:ID},{sys_id:ID}]);
  await f.run({ text: 'web server', class: 'cmdb_ci_server', offset: 2, instance: 'https://example.invalid' });
  assert.equal(f.output[0].data.records.length, 2);
  assert.equal(f.output[0].data.pagination.has_more, true);
  assert.equal(f.output[0].options.breadcrumbs.at(-1).cmd, "jsn cmdb search 'web server' --limit 2 --offset 4 --class cmdb_ci_server --instance https://example.invalid");
});
test('empty results are explicit; rejected/malformed reads cannot look like an empty search', async () => {
  const f = fixture(); await f.run({text:'missing'});
  assert.equal(f.output[0].data.count,0);
  f.app.sdk.listStrict = async () => { throw new Error('denied'); };
  await assert.rejects(f.run({text:'web'}), /denied/);
  await assert.rejects(fixture([null]).run({text:'web'}), /valid record list/);
});
test('query metacharacters, scripts, invalid classes and paging fail before transport', async () => {
  for (const args of [{text:''},{text:'web^ORactive=true'},{text:'javascript:gs.getUserID()'},{text:'web\nserver'},{text:'web',class:'task^NQ'},{text:'web',limit:0},{text:'web',offset:0.5}]) {
    const f = fixture(); await assert.rejects(f.run(args)); assert.equal(f.calls.length,0);
  }
});
test('search is registered under cmdb alongside the existing read-only commands', () => {
  assert.ok(captureCommands(cmdbCmd(fn=>fn)).some(c=>c.command==='search <text>'));
});
