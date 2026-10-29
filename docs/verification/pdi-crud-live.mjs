// Explicit live test: creates one inert, uniquely named preference, then removes it.
// Run only against a PDI explicitly authorized for disposable record testing.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { applySession } from '../../src/session.js';
import { getCurrentUser, getCurrentApplication, getCurrentUpdateSet } from '../../src/context.js';
import { getStringField } from '../../src/helpers.js';
import { listHistory } from '../../src/mutation-history.js';
const profile = process.argv[2];
if (!profile) throw new Error('Pass the explicitly approved disposable PDI profile');
const app = new App(loadConfig());
applySession(app, { profile });
const user = await getCurrentUser(app.sdk);
if (!user?.sys_id) throw new Error('Current user is unavailable');
const [application, updateSet] = await Promise.all([
  getCurrentApplication(app.sdk, user.sys_id, { unknownWhenMissing: true }), getCurrentUpdateSet(app.sdk, user.sys_id),
]);
if (!application?.scope || !updateSet?.sys_id || !['in progress', 'in_progress'].includes(updateSet.state?.toLowerCase()) || updateSet.name?.toLowerCase() === 'default') {
  throw new Error('A known, dedicated in-progress update set must already be selected; this test never switches context or overrides Global+Default');
}
const cli = fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));
const name = `jsn.validation.${randomUUID()}`, reason = 'Disposable PDI CRUD validation';
const env = { ...process.env, JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' };
function run(args) {
  const result = spawnSync(process.execPath, [cli, '--profile', profile, ...args, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  let output;
  try { output = JSON.parse(result.stdout); } catch { throw new Error(`CLI returned non-JSON; exit ${result.status}`); }
  if (result.status !== 0 || !output.ok) throw new Error(`CLI ${args.slice(0, 2).join(' ')} failed: ${output.error?.code || result.status}`);
  return output;
}
async function ensureOriginalContext() {
  const current = await getCurrentUpdateSet(app.sdk, user.sys_id);
  if (current?.sys_id !== updateSet.sys_id || current.name?.toLowerCase() === 'default' || !['in progress', 'in_progress'].includes(current.state?.toLowerCase())) {
    throw new Error('Capture context changed; refusing any force cleanup. Select the original dedicated set before removing the own test record.');
  }
}
let id, removed = false;
const proof = { profile, live: true, table: 'sys_user_preference', test_record: 'unique inert jsn.validation.* preference', known_named_in_progress_context: true, steps: [] };
try {
  const created = run(['records', 'create', '--table', proof.table, '--data', JSON.stringify({ name, user: user.sys_id, value: 'created' }), '--reason', reason]);
  id = getStringField(created.data, 'sys_id');
  if (!id) throw new Error('Create did not return a full record ID; inspect own unique test preference for cleanup');
  proof.steps.push({ command: 'records create', ok: true, context_approved: created.context?.mutation?.approval_required === false, resolved_id: true });
  const updated = run(['records', 'update', '--table', proof.table, '--sys-id', id, '--data', '{"value":"updated"}', '--reason', reason]);
  proof.steps.push({ command: 'records update', ok: getStringField(updated.data, 'value') === 'updated' });
  const read = run(['records', 'get', '--table', proof.table, '--sys-id', id]);
  proof.steps.push({ command: 'records get', ok: getStringField(read.data, 'value') === 'updated' });
  await ensureOriginalContext();
  run(['records', 'delete', '--table', proof.table, '--sys-id', id, '--force', '--reason', reason]);
  removed = true;
  proof.steps.push({ command: 'records delete', ok: true, approval: 'cleanup of this test-created record only' });
  const remaining = await app.sdk.list(proof.table, new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: 'sys_id', sysparm_limit: '1' }));
  proof.cleanup_verified = remaining.length === 0;
  const entries = listHistory({ instance: app.session.instance, profile, table: proof.table, record: id, limit: 10 });
  proof.history = entries.map(entry => ({ operation: entry.operation, outcome: entry.outcome, correct_resolved_id: entry.sys_id === id, supplied_reason: entry.reason === reason }));
  proof.ok = proof.steps.every(step => step.ok) && proof.cleanup_verified && entries.length === 3 && entries.every(entry => entry.outcome === 'succeeded');
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  if (!proof.ok) process.exitCode = 1;
} finally {
  if (id && !removed) {
    await ensureOriginalContext();
    run(['records', 'delete', '--table', proof.table, '--sys-id', id, '--force', '--reason', reason]);
    process.stderr.write('Removed own disposable preference after an interrupted assertion.\n');
  }
}
