// Opt-in, demo-only live proof. Evidence is persisted before/after each phase.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { resolveSession } from '../src/session.js';
import { AuthManager } from '../src/auth.js';
import { SDKClient } from '../src/sdk.js';
import { readCaptureContext } from '../src/mutation-context.js';
import { spawnSync } from 'node:child_process';
import { planId } from '../src/batch-engine.js';
import { readEffectiveUpdateSet } from '../src/context.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'docs/verification/batch-live');
fs.mkdirSync(dir, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const session = resolveSession({ profile: 'demo' }, loadConfig());
assert.equal(session.instance, 'https://tygrllcdemo5.service-now.com');
assert.equal(session.readOnly, false);
const auth = new AuthManager({ getUsername: () => session.username,
  getEffectiveInstance: () => session.instance, getAuthMethod: () => session.profile.auth_method });
const sdk = new SDKClient(session.instance, auth.createProfileProvider(session.instance, {
  username: session.username, authMethod: session.profile.auth_method,
}), { username: session.username, domain: session.domain });
const cli = (label, args, expected = 0) => {
  const result = spawnSync(process.execPath, ['--import', path.join(root, 'cli/scripts/batch-live-audit.mjs'), path.join(root, 'cli/bin/jsn.js'), ...args, '--profile', 'demo', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, JSN_BATCH_LIVE_EVIDENCE: dir, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  fs.writeFileSync(path.join(dir, label + '.stdout'), result.stdout || '');
  fs.writeFileSync(path.join(dir, label + '.stderr'), result.stderr || '');
  save(label + '-status', { args, status: result.status, signal: result.signal, error: result.error?.message });
  assert.equal(result.status, expected, `${label}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const command = process.argv[2] || 'preflight';
if (command === 'preflight') {
  const context = await readCaptureContext(sdk);
  const effective = await readEffectiveUpdateSet(sdk).catch(error => ({ error: error.message }));
  const queries = {};
  for (const query of ['', 'name=itil', 'name=admin']) {
    const params = new URLSearchParams({ sysparm_query: query, sysparm_limit: '3', sysparm_fields: 'sys_id,name' });
    const endpoint = `${sdk.baseURL}/api/now/table/sys_user_role?${params}`;
    queries[query || '(unfiltered)'] = { endpoint, response: await sdk.request(endpoint, { method: 'GET', readOnly: true }) };
  }
  save('preflight', { instance: session.instance, context, effective, roles: queries });
  console.log(JSON.stringify({ context, effective, roles: queries }, null, 2));
} else if (command === 'generate') {
  assert.ok(!fs.existsSync(path.join(dir, 'run.json')), 'Do not overwrite a live run');
  const preflight = JSON.parse(fs.readFileSync(path.join(dir, 'preflight.json')));
  assert.equal(preflight.context.update_set.name, 'Default');
  assert.equal(preflight.context.update_set.sys_id, preflight.effective.sys_id);
  const marker = `HOLLY-BATCH-${Math.floor(Date.now() / 1000)}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/verification/batch-families-manifest.json')));
  manifest.description = `${marker}: authorized inert six-family live proof plus ACL`;
  for (const step of manifest.steps) {
    const oldName = step.name;
    step.name = `${marker}-${oldName}`;
    for (const [field, value] of Object.entries(step.fields)) {
      if (value?.$ref) value.$ref = value.$ref.replace('steps.', `steps.${marker}-`);
      if (['name', 'label', 'title', 'short_description', 'id'].includes(field)) step.fields[field] = `${marker}-${oldName}`;
    }
    if (step.type === 'catalog_variable') step.fields.active = false;
    if (step.type === 'sp_page') step.fields.draft = true;
    if (['sp_row', 'sp_column'].includes(step.type)) step.fields.class_name = `${marker}-${oldName}`;
  }
  manifest.steps.push({ name: `${marker}-acl`, type: 'acl', operation: 'create', fields: {
    name: `${marker}-inert`, operation: 'read', type: 'record', active: false, advanced: false, admin_overrides: true,
  } }, { name: `${marker}-acl_role`, type: 'acl_role', operation: 'create', fields: {
    sys_security_acl: { $ref: `steps.${marker}-acl.sys_id` }, sys_user_role: preflight.roles['name=itil'].response.result[0].sys_id,
  } });
  save('run', { marker, instance: session.instance, default_set: preflight.effective.sys_id,
    tables: ['sc_cat_item', 'item_option_new', 'catalog_ui_policy', 'catalog_ui_policy_action', 'catalog_script_client',
      'sys_ui_policy', 'sys_ui_policy_action', 'sys_data_policy2', 'sys_data_policy_rule',
      'sp_page', 'sp_container', 'sp_row', 'sp_column', 'sp_instance', 'sys_security_acl', 'sys_security_acl_role'] });
  save('create-manifest', manifest);
  console.log(marker);
} else if (command === 'readback') {
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'create-result.json'))).data;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'create-manifest.json')));
  const rows = [];
  for (const step of result.steps.filter(step => step.status === 'created')) {
    const params = new URLSearchParams({ sysparm_fields: ['sys_id', ...Object.keys(step.payload)].join(',') });
    const endpoint = `${sdk.baseURL}/api/now/table/${step.table}/${step.sys_id}?${params}`;
    const response = await sdk.request(endpoint, { method: 'GET', readOnly: true });
    const row = response.result;
    const checks = Object.entries(step.payload).map(([field, expected]) => ({ field, expected, actual: row[field], matches: String(expected) === String(row[field]) }));
    rows.push({ name: step.name, table: step.table, sys_id: step.sys_id, endpoint, response, checks });
    save('create-readback', rows);
  }
  const mismatches = rows.flatMap(row => row.checks.filter(check => !check.matches).map(check => ({ step: row.name, ...check })));
  console.log(JSON.stringify({ records: rows.length, mismatches }, null, 2));
  const succeeded = new Set(rows.map(row => row.name));
  const deletes = { version: 1, description: `${manifest.description}: exact reverse cleanup`, steps: manifest.steps.filter(step => succeeded.has(step.name)).reverse().map(step => ({
    name: step.name, type: step.type, operation: 'delete', target: { sys_id: result.steps.find(row => row.name === step.name).sys_id },
    fields: Object.fromEntries(Object.entries(step.fields).filter(([, value]) => value?.$ref)),
  })) };
  save('delete-manifest', deletes);
} else if (command === 'gates') {
  const manifestFile = path.join(dir, 'create-manifest.json');
  const planFile = path.join(dir, 'create-plan.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  const plan = JSON.parse(fs.readFileSync(planFile)).data;
  const results = {};
  results.missing = cli('gate-missing', ['batch', 'apply', '--file', manifestFile, '--force'], 2);
  const changed = structuredClone(manifest);
  changed.steps[0].fields.name += '-changed';
  save('changed-manifest', changed);
  results.manifest = cli('gate-manifest', ['batch', 'apply', '--file', path.join(dir, 'changed-manifest.json'), '--plan', planFile, '--force'], 2);
  for (const kind of ['payload', 'instance']) {
    const receipt = structuredClone(plan);
    if (kind === 'payload') receipt.steps[0].payload.name += '-changed';
    else receipt.instance = 'https://intentionally-different.invalid';
    // Intact checksums isolate the stale-plan comparison from tamper detection.
    receipt.plan_id = planId(receipt);
    save(`changed-${kind}-plan`, receipt);
    results[kind] = cli(`gate-${kind}`, ['batch', 'apply', '--file', manifestFile, '--plan', path.join(dir, `changed-${kind}-plan.json`), '--force'], 2);
  }
  save('gate-results', results);
  console.log(JSON.stringify(results, null, 2));
} else if (command === 'failure-generate') {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json')));
  const marker = run.marker;
  const ref = name => ({ $ref: `steps.${marker}-fail_${name}.sys_id` });
  save('failure-manifest', { version: 1, description: `${marker}: live out-of-range integer child failure`, steps: [
    { name: `${marker}-fail_page`, type: 'sp_page', operation: 'create', fields: { id: `${marker}-fail_page`, title: `${marker}-fail_page`, public: false, draft: true } },
    { name: `${marker}-fail_container`, type: 'sp_container', operation: 'create', fields: { sp_page: ref('page'), name: `${marker}-fail_container`, order: Number.MAX_SAFE_INTEGER } },
    { name: `${marker}-fail_row`, type: 'sp_row', operation: 'create', fields: { sp_container: ref('container'), class_name: `${marker}-fail_row` } },
    { name: `${marker}-fail_column`, type: 'sp_column', operation: 'create', fields: { sp_row: ref('row'), class_name: `${marker}-fail_column`, size: 12 } },
  ] });
} else if (command === 'failure2-generate') {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'failure-manifest.json')));
  for (const step of manifest.steps) {
    step.name = step.name.replace('fail_', 'bad_');
    for (const [field, value] of Object.entries(step.fields)) {
      if (value?.$ref) value.$ref = value.$ref.replace('fail_', 'bad_');
      else if (typeof value === 'string') step.fields[field] = value.replace('fail_', 'bad_');
    }
  }
  save('failure2-manifest', manifest);
} else if (command === 'cleanup') {
  assert.ok(!fs.existsSync(path.join(dir, 'cleanup-results.json')), 'Cleanup already started; reconcile saved results before resuming');
  const cleanup = [];
  for (const prefix of ['failure2', 'failure', 'create']) {
    const result = JSON.parse(fs.readFileSync(path.join(dir, `${prefix}-result.json`))).data;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `${prefix}-manifest.json`)));
    const written = result.steps.filter(step => step.sys_id && step.operation === 'create');
    const steps = written.toReversed().map(step => {
      const source = manifest.steps.find(source => source.name === step.name);
      return { name: step.name, type: step.type, operation: 'delete', target: { sys_id: step.sys_id },
        fields: Object.fromEntries(Object.entries(source.fields).filter(([, value]) => value?.$ref)) };
    });
    save(`${prefix}-cleanup-order`, steps);
    let chunk = [];
    let index = 0;
    const flush = () => {
      if (!chunk.length) return;
      const label = `${prefix}-cleanup-${index++}`;
      save(label + '-manifest', { version: 1, steps: chunk });
      const file = path.join(dir, label + '-manifest.json');
      const plan = cli(label + '-plan', ['batch', 'plan', '--file', file]);
      assert.deepEqual(plan.data.order, chunk.map(step => step.name));
      save(label + '-receipt', plan);
      const applied = cli(label + '-apply', ['batch', 'apply', '--file', file, '--plan', path.join(dir, label + '-receipt.json'), '--force']);
      assert.equal(applied.data.counts.deleted, chunk.length);
      cleanup.push(...applied.data.steps);
      save('cleanup-results', cleanup);
      chunk = [];
    };
    for (const step of steps) {
      const source = written.find(source => source.name === step.name);
      if (['ui_policy_action', 'catalog_ui_policy_action'].includes(step.type)) {
        // Do not falsify symbolic links to work around the planner's refusal.
        // These two known-owned rows were created with blank parent fields.
        flush();
        const persisted = await sdk.get(source.table, source.sys_id);
        assert.equal(persisted.ui_policy, '');
        await sdk.delete(source.table, source.sys_id);
        const params = new URLSearchParams({ sysparm_query: `sys_id=${source.sys_id}`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
        const response = await sdk.request(`${sdk.baseURL}/api/now/table/${source.table}?${params}`, { method: 'GET', readOnly: true });
        assert.deepEqual(response.result, []);
        cleanup.push({ name: step.name, table: source.table, sys_id: source.sys_id, status: 'deleted', lane: 'explicit owned-orphan cleanup', before: persisted, absence: response });
        save('cleanup-results', cleanup);
      } else chunk.push(step);
    }
    flush();
  }
  console.log(JSON.stringify({ deleted: cleanup.length, order: cleanup.map(step => step.name) }, null, 2));
} else if (command === 'absence') {
  const cleanup = JSON.parse(fs.readFileSync(path.join(dir, 'cleanup-results.json')));
  const proof = [];
  for (const step of cleanup) {
    const params = new URLSearchParams({ sysparm_query: `sys_id=${step.sys_id}`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
    const endpoint = `${sdk.baseURL}/api/now/table/${step.table}?${params}`;
    const response = await sdk.request(endpoint, { method: 'GET', readOnly: true });
    proof.push({ table: step.table, sys_id: step.sys_id, endpoint, response });
    save('final-absence', proof);
    assert.deepEqual(response.result, []);
  }
  console.log(`Verified absent: ${proof.length}`);
} else if (command === 'residue') {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json')));
  const selectors = { sc_cat_item: 'name', item_option_new: 'question_text', catalog_ui_policy: 'short_description',
    catalog_script_client: 'name', sys_ui_policy: 'short_description', sys_data_policy2: 'short_description',
    sp_page: 'title', sp_container: 'name', sp_row: 'class_name', sp_column: 'class_name', sp_instance: 'title', sys_security_acl: 'name' };
  const proof = [];
  for (const [table, field] of Object.entries(selectors)) {
    const params = new URLSearchParams({ sysparm_query: `${field}STARTSWITH${run.marker}`, sysparm_fields: 'sys_id', sysparm_limit: '100' });
    const endpoint = `${sdk.baseURL}/api/now/table/${table}?${params}`;
    const response = await sdk.request(endpoint, { method: 'GET', readOnly: true });
    proof.push({ table, endpoint, response });
    save('marker-residue', proof);
    assert.deepEqual(response.result, []);
  }
  console.log(`Marker searches empty: ${proof.length}`);
} else {
  throw new Error(`Unknown phase: ${command}`);
}
