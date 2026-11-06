// Read-only aggregation of captured live proof and test logs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'docs/verification/batch-live');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
const save = (name, value) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const events = fs.readFileSync(path.join(dir, 'transport.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const creates = events.filter(event => event.event === 'response' && event.method === 'POST' && event.sys_id);
const deletes = events.filter(event => event.event === 'request' && event.method === 'DELETE');
assert.equal(creates.length, 23);
assert.equal(deletes.length, 23);
assert.deepEqual(deletes.map(event => `${event.table}/${event.target}`), creates.toReversed().map(event => `${event.table}/${event.sys_id}`));
const absent = read('final-absence');
assert.equal(absent.length, creates.length);
assert.equal(new Set(creates.map(row => row.sys_id)).size, creates.length);
assert.deepEqual(absent.map(row => `${row.table}/${row.sys_id}`).sort(), creates.map(row => `${row.table}/${row.sys_id}`).sort());
assert.equal(events.filter(event => event.event === 'error' && event.method === 'DELETE').length, 0);
assert.equal(events.filter(event => event.event === 'response' && event.method === 'DELETE').length, deletes.length);
for (const row of absent) assert.deepEqual(row.response.result, []);
const initial = read('create-result').data;
const readback = read('create-readback');
const raw = value => value && typeof value === 'object' ? value.value : value;
const links = [];
const fieldMismatches = [];
for (const row of readback) {
  const step = initial.steps.find(step => step.name === row.name);
  for (const [field, expected] of Object.entries(step.payload)) {
    const actual = raw(row.response.result[field]);
    if (String(expected) !== String(actual)) fieldMismatches.push({ name: row.name, field, expected, actual });
  }
  for (const parentName of step.depends_on) {
    const parent = initial.steps.find(step => step.name === parentName);
    const field = Object.keys(step.payload).find(field => [parent.sys_id, `IO:${parent.sys_id}`].includes(step.payload[field]));
    const actual = raw(row.response.result[field]);
    links.push({ child: row.name, child_sys_id: row.sys_id, field, parent: parentName, parent_sys_id: parent.sys_id, actual, resolves: [parent.sys_id, `IO:${parent.sys_id}`].includes(actual) });
    const parentEvent = creates.findIndex(event => event.sys_id === parent.sys_id);
    const childEvent = creates.findIndex(event => event.sys_id === row.sys_id);
    assert.ok(parentEvent < childEvent);
  }
}
const failure = read('failure2-result').data;
assert.deepEqual(failure.steps.map(step => step.status), ['created', 'failed', 'skipped', 'skipped']);
assert.equal(failure.steps[1].write_outcome, 'created_unverified');
const bad = creates.filter(event => failure.steps.some(step => step.sys_id === event.sys_id));
assert.equal(bad.length, 2);
save('live-summary', { created: creates.length, deleted: deletes.length, verified_absent: absent.length,
  exact_reverse_global_transport_order: true, batch_deleted: read('cleanup-results').filter(row => !row.lane).length,
  explicit_orphan_deletes: read('cleanup-results').filter(row => row.lane).length,
  initial_create_counts: initial.counts, links, fieldMismatches, failure_counts: failure.counts,
  create_order: creates.map(event => ({ table: event.table, sys_id: event.sys_id })),
  delete_order: deletes.map(event => ({ table: event.table, sys_id: event.target })) });
if (process.argv.length > 2) {
  function testLog(file) {
    const text = fs.readFileSync(file, 'utf8');
    const tail = text.split('✖ failing tests:')[1] || '';
    const failures = [...tail.matchAll(/^✖ (.+?) \([\d.]+m?s\)$/gm)].map(match => match[1]).sort();
    const metric = name => Number([...text.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`, 'gm'))].at(-1)?.[1]);
    assert.equal(failures.length, metric('fail'), `Failure parser mismatch: ${file}`);
    return { file, tests: metric('tests'), pass: metric('pass'), fail: metric('fail'), failures };
  }
  const branch = testLog(process.argv[2]);
  const main = testLog(process.argv[3]);
  const comparison = { branch, main, new_failures: branch.failures.filter(name => !main.failures.includes(name)),
    resolved_failures: main.failures.filter(name => !branch.failures.includes(name)) };
  save('suite-comparison', comparison);
  assert.deepEqual(comparison.new_failures, []);
  assert.deepEqual(comparison.resolved_failures, []);
  console.log(JSON.stringify(comparison, null, 2));
}
console.log(`Live transport: ${creates.length} creates, ${deletes.length} deletes in exact reverse order; ${absent.length} verified absent.`);
