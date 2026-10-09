import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient } from '../src/sdk.js';
import { readFileSync } from 'node:fs';

// Captured create/normalization shapes, with a synthetic parent ID and script.
// The failed live readback had NO steps; the responder below models attachment.
const createFixture = JSON.parse(readFileSync(new URL('./fixtures/processflow-create.json', import.meta.url), 'utf8'));

// Synthesized wire fixtures, not instance captures. IDs have no live target.
const ID = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const CONTEXT = 'c'.repeat(32);
const CID = '11111111-2222-4333-8444-555555555555';
function definition() {
  return {
    id: ID, scope: SCOPE, name: 'Echo', description: 'Synthetic echo action',
    internal_name: 'echo', master_snapshot: '', latest_snapshot: '', state: 'draft',
    action_status_metadata: { sysId: 'd'.repeat(32), actionTypeId: ID },
    inputs: [{ name: 'response', type: 'object', children: [{ name: 'text', type: 'string' }],
      attributes: { schema: { fields: { text: { type: 'string', required: true } } } } }],
    outputs: [{ name: 'response', type: 'string', value: `{{step[${CID}].response}}` }],
    steps: [{ cid: CID, step_type: 'SCRIPT', step_type_id: 'e'.repeat(32), order: 1,
      inputs: [{ name: 'script', type: 'script', value: '(function execute(inputs, outputs) { outputs.response = inputs.response.text; })(inputs, outputs);' }],
      extended_inputs: [{ name: 'response', type: 'object', value: '{{inputs.response}}',
        children: [{ name: 'text', type: 'string' }] }],
      outputs: [], extended_outputs: [{ name: 'response', type: 'string', extended: true }] }],
  };
}
function client(handler) {
  const sdk = new SDKClient('https://example.invalid', null);
  const calls = [];
  sdk.request = async (url, opts = {}) => {
    const call = { url: new URL(url), method: opts.method, body: opts.body && JSON.parse(opts.body), opts };
    calls.push(call);
    return structuredClone(await handler(call, calls));
  };
  return { sdk, calls };
}
const path = `/api/now/processflow/action/action_types/${ID}`;
function responder(saved = definition()) {
  return (call) => {
    if (call.url.pathname === `/api/now/table/sys_hub_action_type_definition/${ID}`) return { result: { sys_id: ID, sys_scope: { value: SCOPE } } };
    if (call.url.pathname === `/api/now/table/sys_scope/${SCOPE}`) return { result: { sys_id: SCOPE } };
    if (call.url.pathname === path && call.method === 'GET') { const { steps: _steps, ...metadata } = saved; return { result: metadata }; }
    if (call.url.pathname === `${path}/step_instances`) return { result: { steps: saved.steps } };
    if (call.url.pathname === path && call.method === 'PUT') return { result: saved };
    throw new Error(`Unexpected ${call.method} ${call.url.pathname}`);
  };
}

test('definition merges real executable step_instances into roundtrippable metadata', async () => {
  const { sdk, calls } = client(responder());
  assert.deepEqual(await sdk.getProcessFlowAction(ID, SCOPE), definition());
  assert.deepEqual(calls.map(c => [c.method, c.url.pathname]), [
    ['GET', path], ['GET', `${path}/step_instances`],
  ]);
  for (const c of calls) assert.equal(c.url.searchParams.get('sysparm_transaction_scope'), SCOPE);
});

test('update sends untouched full nested definition and verifies executable readback', async () => {
  const document = definition();
  const { sdk, calls } = client(responder(document));
  const result = await sdk.updateProcessFlowAction(ID, SCOPE, document);
  assert.equal(result.status, 'verified');
  assert.equal(result.http_write_confirmed, true);
  assert.deepEqual(result.definition, document);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.url.pathname, path);
  assert.equal(put.url.searchParams.get('sysparm_transaction_scope'), SCOPE);
  assert.deepEqual(put.body, document);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

for (const [label, mutate, scope] of [
  ['wrong ID', d => { d.id = 'f'.repeat(32); }, SCOPE],
  ['wrong body scope', d => { d.scope = 'f'.repeat(32); }, SCOPE],
  ['wrong supplied scope', () => {}, 'f'.repeat(32)],
  ['wrong step action ID', d => { d.steps[0].action = 'f'.repeat(32); }, SCOPE],
  ['omitted steps', d => { delete d.steps; }, SCOPE],
  ['empty steps', d => { d.steps = []; }, SCOPE],
  ['partial table document', d => { delete d.action_status_metadata; }, SCOPE],
]) {
  test(`update rejects ${label} before writes`, async () => {
    const document = definition(); mutate(document);
    const { sdk, calls } = client(responder());
    await assert.rejects(sdk.updateProcessFlowAction(ID, scope, document));
    assert.ok(calls.every(c => c.method === 'GET'));
  });
}

test('update infers record scope and supports literal Global scope', async () => {
  const { sdk, calls } = client(responder());
  assert.equal((await sdk.updateProcessFlowAction(ID, undefined, definition())).scope, SCOPE);
  assert.ok(calls.filter(c => c.method === 'PUT').every(c => c.url.searchParams.get('sysparm_transaction_scope') === SCOPE));
  const global = definition(); global.scope = 'global';
  const base = responder(global);
  const g = client(c => {
    if (c.url.pathname === `/api/now/table/${'sys_hub_action_type_definition'}/${ID}`) return { result: { sys_id: ID, sys_scope: 'global' } };
    if (c.url.pathname === '/api/now/table/sys_scope/global') return { result: { sys_id: 'global' } };
    return base(c);
  });
  assert.equal((await g.sdk.updateProcessFlowAction(ID, 'global', global)).scope, 'global');
});

for (const [label, change] of [
  ['script', d => { d.steps[0].inputs[0].value = 'lost script'; }],
  ['action output mapping', d => { d.outputs[0].value = ''; }],
  ['step input mapping', d => { d.steps[0].extended_inputs[0].value = ''; }],
  ['nested schema', d => { d.inputs[0].attributes.schema.fields.text.required = false; }],
  ['extended output', d => { d.steps[0].extended_outputs = []; }],
]) {
  test(`update rejects persisted ${label} mismatch`, async () => {
    const saved = definition(); change(saved);
    const { sdk } = client(responder(saved));
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, definition()), e => e.code === 'action_verification_failed' && e.details.status === 'unverified');
  });
}

test('PUT timeout reads back once without another mutation or fake HTTP success', async () => {
  const base = responder();
  const { sdk, calls } = client(c => {
    if (c.method === 'PUT') throw new Error('Request timed out');
    return base(c);
  });
  const result = await sdk.updateProcessFlowAction(ID, SCOPE, definition());
  assert.equal(result.status, 'persisted_after_timeout');
  assert.equal(result.http_write_confirmed, false);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(calls.at(-1).url.pathname, `${path}/step_instances`);
});

test('PUT timeout with unpersisted steps remains an explicit failure', async () => {
  const saved = definition(); saved.steps = [];
  const base = responder(saved);
  const { sdk, calls } = client(c => {
    if (c.method === 'PUT') throw new Error('Request timed out');
    return base(c);
  });
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, definition()), /unverified/);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

function creating({ failPut = false, lostSteps = false, readFailure = false, captured = false, generatedStatus = false, mutate = () => {} } = {}) {
  let saved;
  const fresh = definition(); fresh.inputs = []; fresh.steps = [];
  if (generatedStatus) fresh.action_status_metadata.sysId = '';
  fresh.outputs = captured ? structuredClone(createFixture.freshOutputs)
    : [{ name: '__action_status__', type: 'object', id: '1'.repeat(32), children: [] }];
  return client(c => {
    if (c.method === 'POST' && c.url.pathname === '/api/now/table/sys_hub_action_type_definition') return { result: { sys_id: ID, sys_scope: SCOPE } };
    if (c.method === 'PUT') {
      if (failPut) throw new Error('permission denied');
      saved = structuredClone(c.body);
      if (captured) {
        // The independent bound-step probe proves action is the attachment key.
        saved.steps = saved.steps.filter(s => s.action === ID);
        saved.outputs = [...structuredClone(createFixture.normalizedOutputs), ...saved.outputs.filter(o => !o.name.startsWith('__'))];
      }
      mutate(saved);
      return { result: saved };
    }
    if (c.url.pathname === path && c.method === 'GET') {
      if (saved && readFailure) throw new Error('read denied');
      const { steps: _steps, ...metadata } = saved || fresh; return { result: metadata };
    }
    if (c.url.pathname === `${path}/step_instances`) return { result: { steps: lostSteps ? [] : saved.steps } };
    return responder()(c);
  });
}

test('create initializes own lifecycle defaults, installs full steps and verifies', async () => {
  const source = definition(); source.master_snapshot = 'f'.repeat(32);
  source.latest_snapshot = 'f'.repeat(32); source.action_status_metadata.sysId = 'f'.repeat(32);
  source.outputs.push({ name: '__action_status__', id: 'f'.repeat(32), type: 'object' });
  const { sdk, calls } = creating();
  const result = await sdk.createProcessFlowAction(SCOPE, source);
  assert.equal(result.status, 'verified');
  const parent = calls.find(c => c.method === 'POST');
  assert.deepEqual(parent.body, { name: 'Echo', description: 'Synthetic echo action', sys_scope: SCOPE, internal_name: 'echo' });
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.body.id, ID);
  assert.equal(put.body.scope, SCOPE);
  assert.equal(put.body.master_snapshot, '');
  assert.equal(put.body.latest_snapshot, '');
  assert.equal(put.body.action_status_metadata.sysId, 'd'.repeat(32));
  assert.equal(put.body.outputs[0].id, '1'.repeat(32));
  assert.deepEqual(put.body.steps, source.steps.map(step => ({ ...step, action: ID })));
  assert.deepEqual(put.body.inputs, source.inputs);
  assert.equal(calls.at(-1).url.pathname, `${path}/step_instances`);
});

for (const options of [{ failPut: true }, { lostSteps: true }, { readFailure: true }]) {
  test(`create cannot report success after parent only: ${JSON.stringify(options)}`, async () => {
    const { sdk, calls } = creating(options);
    await assert.rejects(sdk.createProcessFlowAction(SCOPE, definition()), e => {
      assert.equal(e.code, 'action_create_partial');
      assert.equal(e.details.sys_id, ID);
      assert.equal(e.details.status, 'parent_created_definition_unverified');
      return true;
    });
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
  });
}

test('create accepts a newly allocated status ID but never an invalid or foreign status binding', async () => {
  for (const [label, statusID, actionID, passes] of [
    ['new status', 'e'.repeat(32), ID, true],
    ['invalid status', '', ID, false],
    ['foreign binding', 'e'.repeat(32), 'f'.repeat(32), false],
  ]) {
    const { sdk } = creating({ generatedStatus: true, mutate: d => {
      d.action_status_metadata.sysId = statusID;
      d.action_status_metadata.actionTypeId = actionID;
    } });
    if (passes) assert.equal((await sdk.createProcessFlowAction(SCOPE, definition())).status, 'verified', label);
    else await assert.rejects(sdk.createProcessFlowAction(SCOPE, definition()), e => e.code === 'action_create_partial', label);
  }
});

test('create validates definition and scope existence before creating parent', async () => {
  const { sdk, calls } = client(() => ({ result: null }));
  await assert.rejects(sdk.createProcessFlowAction(SCOPE, definition()), /Scope does not exist/);
  const empty = definition(); empty.steps = [];
  await assert.rejects(sdk.createProcessFlowAction(SCOPE, empty), /at least one/);
  await assert.rejects(sdk.createProcessFlowAction(` ${SCOPE}`, definition()), /scope/);
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('captured create binds new steps to allocated parent and accepts only empty lifecycle normalization', async () => {
  const source = structuredClone(createFixture.source);
  const before = structuredClone(source);
  const { sdk, calls } = creating({ captured: true });
  const result = await sdk.createProcessFlowAction(SCOPE, source);
  assert.equal(result.status, 'verified');
  assert.equal(result.definition.steps.length, 1);
  assert.notEqual(source.id, result.sys_id);
  assert.equal(calls.find(c => c.method === 'PUT').body.steps[0].action, ID);
  assert.deepEqual(source, before);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(!calls.some(c => c.method === 'DELETE'));
});

for (const [label, mutate] of [
  ['persisted step ID', s => { s.step_id = 'f'.repeat(32); }],
  ['foreign step action', s => { s.action = 'f'.repeat(32); }],
  ['malformed step ID', s => { s.step_id = false; }],
]) {
  test(`create rejects ${label} before parent allocation`, async () => {
    const source = structuredClone(createFixture.source); mutate(source.steps[0]);
    const { sdk, calls } = creating({ captured: true });
    await assert.rejects(sdk.createProcessFlowAction(SCOPE, source), /new step|Step/);
    assert.equal(calls.length, 0);
  });
}

for (const [label, mutate] of [
  ['output mapping', d => { d.outputs.find(o => o.name === 'response').value = ''; }],
  ['status code', d => { const o = d.outputs[0]; const v = JSON.parse(o.value); v.complexObject.code.$cv.$v = '1'; o.value = JSON.stringify(v); }],
  ['serialized required constraint', d => {
    const o = d.outputs[0]; const v = JSON.parse(o.value); const facet = v.complexObjectSchema['FlowDesigner:FDACTIONSTATUS']['code.$field_facets'];
    const fields = JSON.parse(facet.SimpleMapFacet); fields.mandatory = 'true'; facet.SimpleMapFacet = JSON.stringify(fields); o.value = JSON.stringify(v);
  }],
  ['status object mapping', d => { d.outputs[0].complexObjectValue.children[0].value = '{{inputs.code}}'; }],
  ['status parameter constraint', d => { d.outputs[0].complexObjectValue.children[0].parameter.mandatory = true; }],
  ['status script', d => { d.outputs[0].script = { script: 'changed' }; }],
  ['error behavior', d => { d.outputs[1].value = true; }],
]) {
  test(`captured create still rejects changed ${label}`, async () => {
    const { sdk } = creating({ captured: true, mutate });
    await assert.rejects(sdk.createProcessFlowAction(SCOPE, createFixture.source), e => e.code === 'action_create_partial' && e.details.mismatches?.some(p => p.startsWith('outputs.')));
  });
}

for (const [label, change] of [
  ['state', d => { d.state = 'published'; }],
  ['reserved output ID', d => { d.outputs[1].id = 'f'.repeat(32); }],
  ['removed reserved output', d => { d.outputs.pop(); }],
]) {
  test(`update rejects target-owned ${label} before PUT`, async () => {
    const current = definition(); current.outputs.push({ name: '__action_status__', type: 'object', id: '1'.repeat(32) });
    const source = structuredClone(current); change(source);
    const { sdk, calls } = client(responder(current));
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source));
    assert.ok(calls.every(c => c.method === 'GET'));
  });
}

test('update readback must retain protected reserved output IDs', async () => {
  const current = definition(); current.outputs.push({ name: '__action_status__', type: 'object', id: '1'.repeat(32) });
  let saved = current;
  const { sdk } = client(c => {
    if (c.method === 'PUT') { saved = structuredClone(c.body); saved.outputs[1].id = 'f'.repeat(32); return { result: saved }; }
    return responder(saved)(c);
  });
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, current), e => e.code === 'action_verification_failed' && e.details.mismatches.includes('outputs.__action_status__.id'));
});

for (const [label, changeSource, changeSaved] of [
  ['removed script value', d => { delete d.steps[0].inputs[0].value; }, () => {}],
  ['removed output mapping', d => { delete d.outputs[0].value; }, () => {}],
  ['removed script object', d => { delete d.outputs[0].script; }, d => { d.outputs[0].script = { script: 'retained' }; }],
  ['added required schema field', () => {}, d => { d.inputs[0].attributes.schema.fields.extra = { type: 'string', required: true }; }],
  ['added child constraint', () => {}, d => { d.inputs[0].children[0].mandatory = true; }],
  ['added data structure', () => {}, d => { d.inputs[0].data_structure = 'f'.repeat(32); }],
]) {
  test(`verification rejects ${label}`, async () => {
    const source = definition(); const saved = definition(); changeSource(source); changeSaved(saved);
    const { sdk } = client(responder(saved));
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source), e => e.code === 'action_verification_failed');
  });
}

for (const errorCode of [null, false, '', '00', true]) {
  test(`test rejects non-explicit success errorCode ${JSON.stringify(errorCode)}`, async () => {
    const base = responder();
    const { sdk } = client(c => c.url.pathname.endsWith('/test') ? { result: { data: CONTEXT, errorCode } } : base(c));
    await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition()));
  });
}

test('explicit numeric and string zero errorCodes both dispatch successfully', async () => {
  for (const errorCode of [0, '0']) {
    const { sdk } = testing({ errorCode });
    assert.equal((await sdk.testProcessFlowAction(ID, SCOPE, definition())).status, 'dispatched');
  }
});

test('generated UI attributes do not hide or invent schema constraints', async () => {
  const saved = definition(); saved.inputs[0].attributes.uiUniqueId = 'generated'; saved.inputs[0].children[0].id = 'f'.repeat(32);
  const { sdk } = client(responder(saved));
  assert.equal((await sdk.updateProcessFlowAction(ID, SCOPE, definition())).status, 'verified');
});

test('step-types uses exact scoped schema discovery endpoint', async () => {
  const { sdk, calls } = client(() => ({ result: [{ type: 'SCRIPT', id: 'e'.repeat(32) }] }));
  assert.deepEqual(await sdk.getProcessFlowStepTypes(SCOPE), [{ type: 'SCRIPT', id: 'e'.repeat(32) }]);
  assert.equal(calls[0].url.pathname, '/api/now/processflow/action/step_types');
  assert.equal(calls[0].url.searchParams.get('sysparm_transaction_scope'), SCOPE);
});

function testing({ state = 'COMPLETE', message = '', errorCode = 0, values, denied = false, rows, running = false } = {}) {
  const base = responder();
  return client(c => {
    if (c.url.pathname === `${path}/test`) return { result: { data: CONTEXT, errorCode, errorMessage: errorCode === 0 || errorCode === '0' ? '' : 'dispatch rejected' } };
    if (c.url.pathname === `/api/now/table/sys_flow_context/${CONTEXT}`) return { result: { sys_id: CONTEXT, state: running ? 'IN_PROGRESS' : state, error_message: message } };
    if (c.url.pathname === '/api/now/table/sys_flow_runtime_value') {
      if (denied) throw new Error('API error (status 403): denied');
      assert.equal(c.url.searchParams.get('sysparm_query'), `context=${CONTEXT}^type=output`);
      return { result: rows ?? [{ context: CONTEXT, type: 'output', value: JSON.stringify(values ?? { response: { value: 'real output', displayValue: 'real output', hasValue: true } }) }] };
    }
    return base(c);
  });
}

test('test defaults to saved complete definition and keeps outputMap wire name', async () => {
  const { sdk, calls } = testing();
  const result = await sdk.testProcessFlowAction(ID, undefined, undefined, { response: { text: 'hello' } });
  assert.deepEqual(result, { context: CONTEXT, state: 'DISPATCHED', status: 'dispatched', outputs: null });
  const post = calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body, { action: definition(), outputMap: { response: { text: 'hello' } }, runOnThread: true, tracingEnabled: false });
  assert.equal(post.url.searchParams.get('sysparm_transaction_scope'), SCOPE);
});

test('wait returns exact completed context and actual runtime outputs, not dispatch ID', async () => {
  const { sdk, calls } = testing();
  const result = await sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { wait: true, timeout: 1, runOnThread: false, tracingEnabled: true });
  assert.deepEqual(result, { context: CONTEXT, state: 'COMPLETE', status: 'complete', outputs: { response: { value: 'real output', displayValue: 'real output', hasValue: true } } });
  assert.equal(calls.find(c => c.method === 'POST').body.runOnThread, false);
  assert.ok(calls.at(-1).opts.timeout <= 1000);
});

for (const [label, options, code] of [
  ['server errorCode', { errorCode: 7 }, 'action_api_error'],
  ['terminal ERROR', { state: 'ERROR' }, 'action_test_failed'],
  ['terminal CANCELLED', { state: 'CANCELLED' }, 'action_test_failed'],
  ['complete with error', { message: 'script failed' }, 'action_test_failed'],
  ['missing outputs', { rows: [] }, 'action_test_outputs_missing'],
  ['unset output', { values: { response: { value: '', hasValue: false } } }, 'action_test_outputs_missing'],
  ['denied outputs', { denied: true }, 'action_test_read_failed'],
  ['wrong context', { rows: [{ context: ID, type: 'output', value: '{}' }] }, 'action_test_outputs_invalid'],
  ['invalid runtime JSON', { rows: [{ context: CONTEXT, type: 'output', value: '{' }] }, 'action_test_outputs_invalid'],
]) {
  test(`wait rejects ${label} explicitly`, async () => {
    const { sdk } = testing(options);
    await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { wait: true, timeout: 1 }), e => e.code === code);
  });
}

test('wait timeout is bounded, reports context and never cancels execution', async () => {
  const { sdk, calls } = testing({ running: true });
  const started = Date.now();
  await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { wait: true, timeout: 0.03 }), e => e.code === 'action_test_timeout' && e.details.context === CONTEXT);
  assert.ok(Date.now() - started < 500);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(calls.filter(c => c.url.pathname.includes('sys_flow_context')).every(c => c.opts.timeout <= 30));
});

test('false, zero and empty string runtime values are real outputs', async () => {
  for (const value of [false, 0, '']) {
    const { sdk } = testing({ values: { response: { value, hasValue: true } } });
    const result = await sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { wait: true });
    assert.equal(result.outputs.response.value, value);
  }
});

test('invalid timeout and outputMap fail before dispatch', async () => {
  const { sdk, calls } = testing();
  for (const timeout of [0, -1, Infinity, 3601]) await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { timeout }), /timeout/);
  await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition(), []), /output-map/);
  assert.equal(calls.length, 0);
});

for (const [label, change] of [
  ['omitted optional field', d => { delete d.description; }],
  ['foreign snapshot', d => { d.master_snapshot = 'f'.repeat(32); }],
  ['foreign status ID', d => { d.action_status_metadata.sysId = 'f'.repeat(32); }],
  ['duplicate input names', d => { d.inputs.push(structuredClone(d.inputs[0])); }],
  ['unnamed output', d => { delete d.outputs[0].name; }],
]) {
  test(`full update rejects ${label} before mutation`, async () => {
    const source = definition(); change(source);
    const { sdk, calls } = client(responder());
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source));
    assert.ok(calls.every(c => c.method === 'GET'));
  });
}

test('PUT returned definition mismatch cannot masquerade as verified save', async () => {
  const base = responder();
  const { sdk } = client(c => {
    if (c.method === 'PUT') { const d = definition(); d.steps[0].inputs[0].value = 'wrong'; return { result: d }; }
    return base(c);
  });
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, definition()), e => e.code === 'action_verification_failed');
});

test('metadata identity and incomplete steps fail instead of building a fake definition', async () => {
  for (const result of [{ id: ID, scope: 'f'.repeat(32) }, { ...definition(), id: 'f'.repeat(32) }]) {
    const { sdk } = client(() => ({ result }));
    await assert.rejects(sdk.getProcessFlowAction(ID, SCOPE), e => e.code === 'action_identity_mismatch');
  }
  const base = responder();
  const { sdk } = client(c => c.url.pathname.endsWith('/step_instances') ? { result: {} } : base(c));
  await assert.rejects(sdk.getProcessFlowAction(ID, SCOPE), e => e.code === 'action_definition_incomplete');
});

test('test rejects scope and supplied body ID mismatch without dispatching', async () => {
  const { sdk, calls } = testing();
  const d = definition(); d.id = 'f'.repeat(32);
  await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, d));
  await assert.rejects(sdk.testProcessFlowAction(ID, 'f'.repeat(32)));
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('COMPLETE with unreadable error_message is not proven successful', async () => {
  const base = responder();
  const { sdk } = client(c => {
    if (c.url.pathname.endsWith('/test')) return { result: { data: CONTEXT, errorCode: 0, errorMessage: '' } };
    if (c.url.pathname.includes('sys_flow_context')) return { result: { sys_id: CONTEXT, state: 'COMPLETE' } };
    return base(c);
  });
  await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition(), {}, { wait: true }), e => e.code === 'action_test_read_failed');
});

test('parent timeout reports unknown partial state and is never retried', async () => {
  const base = responder();
  const { sdk, calls } = client(c => {
    if (c.method === 'POST') throw new Error('Request timed out');
    return base(c);
  });
  await assert.rejects(sdk.createProcessFlowAction(SCOPE, definition()), e => e.code === 'action_create_partial' && e.details.status === 'unknown_parent');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(!calls.some(c => c.method === 'DELETE'));
});

test('schema fields named id are semantic, not server-owned record IDs', async () => {
  const source = definition();
  source.inputs[0].attributes.schema.fields.id = { type: 'string', required: true };
  const saved = structuredClone(source);
  saved.inputs[0].attributes.schema.fields.id.type = 'integer';
  const { sdk } = client(responder(saved));
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source), e => e.code === 'action_verification_failed');
});

test('post-PUT read failures retain action ID and unverified update status', async () => {
  const base = responder(); let written = false;
  const { sdk } = client(c => {
    if (c.method === 'PUT') written = true;
    if (written && c.method === 'GET' && c.url.pathname === path) {
      const error = new Error('API error (status 403): denied'); error.code = 'api_error'; throw error;
    }
    return base(c);
  });
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, definition()), e => e.code === 'action_update_failed' && e.details.sys_id === ID && e.details.status === 'unverified');
});

for (const [label, change] of [
  ['maximum size', d => { d.outputs[0].maxsize = 1; }],
  ['reference qualifier', d => { d.steps[0].inputs.find(v => v.name === 'connection_alias').ref_qual = ''; }],
  ['runtime choices', d => { d.steps[0].inputs.find(v => v.name === 'required_run_time').choices = []; }],
]) {
  test(`readback rejects changed ${label} constraints`, async () => {
    const source = { ...definition(), ...structuredClone(createFixture.source), id: ID, scope: SCOPE };
    source.steps[0].action = ID;
    const saved = structuredClone(source); change(saved);
    const { sdk } = client(responder(saved));
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source), e => e.code === 'action_verification_failed');
  });
}

test('readback rejects retained step error handling omitted from update', async () => {
  const current = definition(); current.steps[0].error_handling_type = 'EVAL_ERRORS';
  const source = structuredClone(current); delete source.steps[0].error_handling_type;
  const { sdk } = client(responder(current));
  await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, source), e => e.code === 'action_verification_failed');
});

for (const key of ['master_snapshot', 'latest_snapshot', 'action_status_metadata']) {
  test(`readback rejects changed protected ${key}`, async () => {
    const current = definition(); let saved = current;
    const { sdk } = client(c => {
      if (c.method === 'PUT') {
        saved = structuredClone(c.body);
        if (key === 'action_status_metadata') saved[key].sysId = 'f'.repeat(32);
        else saved[key] = 'f'.repeat(32);
        return { result: saved };
      }
      return responder(saved)(c);
    });
    await assert.rejects(sdk.updateProcessFlowAction(ID, SCOPE, current), e => e.code === 'action_verification_failed');
  });
}

test('missing errorCode and nonempty errorMessage are dispatch failures', async () => {
  for (const response of [{ data: CONTEXT }, { data: CONTEXT, errorCode: 0, errorMessage: 'rejected' }]) {
    const base = responder();
    const { sdk } = client(c => c.url.pathname.endsWith('/test') ? { result: response } : base(c));
    await assert.rejects(sdk.testProcessFlowAction(ID, SCOPE, definition()), e => e.code === 'action_test_dispatch_failed');
  }
});
