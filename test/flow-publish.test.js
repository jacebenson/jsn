import { describe, it } from 'node:test';
import assert from 'node:assert';
import { gzipSync } from 'node:zlib';

// Minimal SDK double. Each test overrides only what it needs.
function buildSdk({ fetchResponse, tables = {}, records = {}, scriptOutput = '' } = {}) {
  return {
    baseURL: 'https://dev.example.service-now.com',
    async _fetchWithAuth() {
      return fetchResponse;
    },
    async list(table) {
      const rows = tables[table];
      if (rows instanceof Error) throw rows;
      return rows ?? [];
    },
    async get(table, sysID) {
      return records[`${table}:${sysID}`] ?? null;
    },
    async executeScript() {
      return scriptOutput;
    },
  };
}

const jsonResponse = (status, body) => ({
  status,
  statusText: String(status),
  async text() { return JSON.stringify(body); },
});

// trigger_inputs is gzip+base64 JSON; only the "table" entry matters here.
const triggerInputs = (table) =>
  gzipSync(Buffer.from(JSON.stringify([{ name: 'table', value: table }]), 'utf8')).toString('base64');

describe('flows publish', () => {
  it('parses a 200 success body', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      fetchResponse: jsonResponse(200, {
        result: {
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ sys_id: 'abc', status: 'success', message: 'Published successfully' }],
        },
      }),
    });

    const out = await publishFlows(sdk, ['abc']);
    assert.strictEqual(out.via, 'wfa_fluent');
    assert.deepStrictEqual(out.summary, { total: 1, succeeded: 1, failed: 0 });
    assert.strictEqual(out.results[0].status, 'success');
  });

  // 422 is NOT an error case -- it carries the per-flow reasons, which are the
  // most useful thing this command produces. Throwing it away is the bug.
  it('reports a 422 body instead of throwing', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      fetchResponse: jsonResponse(422, {
        result: {
          summary: { total: 1, succeeded: 0, failed: 1 },
          results: [{ sys_id: 'abc', status: 'error', message: 'No Trigger instance found in the flow definition' }],
        },
      }),
    });

    const out = await publishFlows(sdk, ['abc']);
    assert.strictEqual(out.summary.failed, 1);
    assert.match(out.results[0].message, /No Trigger instance found/);
  });

  it('reports a 207 partial body', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      fetchResponse: jsonResponse(207, {
        result: {
          summary: { total: 2, succeeded: 1, failed: 1 },
          results: [{ status: 'success' }, { status: 'error' }],
        },
      }),
    });

    const out = await publishFlows(sdk, ['a', 'b']);
    assert.strictEqual(out.summary.succeeded, 1);
    assert.strictEqual(out.results.length, 2);
  });

  // Instances without the endpoint answer 400 with this phrase. The Now SDK
  // swallows it at debug level; we fall back rather than reporting success.
  it('falls back to FlowDesignerUtils when the endpoint is absent', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      fetchResponse: jsonResponse(400, {
        error: { message: 'Requested URI does not represent any resource' },
      }),
      scriptOutput:
        'JSN_PUBLISH_RESULT:{"items":[{"sys_id":"abc","status":"success","flow_name":"F"}],"successCount":1}',
    });

    const out = await publishFlows(sdk, ['abc']);
    assert.strictEqual(out.via, 'FlowDesignerUtils');
    assert.strictEqual(out.summary.succeeded, 1);
  });

  it('throws on a genuine error status', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    const sdk = buildSdk({ fetchResponse: jsonResponse(500, { error: { message: 'boom' } }) });
    await assert.rejects(() => publishFlows(sdk, ['abc']), /boom/);
  });

  it('refuses an empty publish', async () => {
    const { publishFlows } = await import('../src/flow-publish.js');
    await assert.rejects(() => publishFlows(buildSdk(), [], []), /Nothing to publish/);
  });
});

describe('flows status', () => {
  const flow = (over = {}) => ({
    sys_id: 'f1', name: 'Test Flow', type: 'flow',
    master_snapshot: 'snap1', version: '2', active: 'true', ...over,
  });

  it('does not treat table-wide registration evidence as proof this flow is healthy', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow() },
      tables: {
        sys_hub_trigger_instance_v2: [{ trigger_type: 'record_create', trigger_inputs: triggerInputs('incident') }],
        // This row may belong to a different flow using the same table.
        sys_flow_record_trigger: [{ condition: '^EQ', active: 'true' }],
      },
    });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.ok, false, JSON.stringify(out.checks));
    assert.strictEqual(out.checks.find(c => c.name === 'Trigger registered').ok, false);
    assert.strictEqual(out.checks.find(c => c.name === 'Table registrations').ok, true);
    assert.match(out.checks.find(c => c.name === 'Trigger registered').detail, /cannot verify.*this flow/i);
  });

  // version 1 makes the publisher read the (empty) v1 instance tables and fail
  // with "No Trigger instance found" while the trigger sits right there.
  it('flags engine version 1', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow({ version: '1' }) },
      tables: {
        sys_hub_trigger_instance_v2: [{ trigger_type: 'record_create', trigger_inputs: triggerInputs('incident') }],
        sys_flow_record_trigger: [{ condition: '^EQ' }],
      },
    });

    const out = await flowStatus(sdk, 'f1');
    const check = out.checks.find(c => c.name === 'Engine version');
    assert.strictEqual(check.ok, false);
    assert.match(check.detail, /expected 2/);
    assert.strictEqual(out.ok, false);
  });

  // An empty condition is never matched -- it does not mean "always". Flow
  // Designer writes "^EQ"; tools that write "" produce a flow that reports
  // published + active and silently never fires.
  it('flags an empty trigger condition', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow() },
      tables: {
        sys_hub_trigger_instance_v2: [{ trigger_type: 'record_create', trigger_inputs: triggerInputs('incident') }],
        sys_flow_record_trigger: [{ condition: '', active: 'true' }],
      },
    });

    const out = await flowStatus(sdk, 'f1');
    const check = out.checks.find(c => c.name === 'Trigger condition');
    assert.strictEqual(check.ok, false);
    assert.match(check.detail, /never fire/);
  });

  it('flags a flow that was never published', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow({ master_snapshot: '' }) },
      tables: {
        sys_hub_trigger_instance_v2: [{ trigger_type: 'record_create', trigger_inputs: triggerInputs('incident') }],
        sys_flow_record_trigger: [{ condition: '^EQ' }],
      },
    });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.checks.find(c => c.name === 'Published').ok, false);
  });

  // sys_hub_flow.active is the liveness gate -- deactivating leaves
  // sys_flow_record_trigger.active = 1 behind.
  it('flags an inactive flow even with a live registration', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow({ active: 'false' }) },
      tables: {
        sys_hub_trigger_instance_v2: [{ trigger_type: 'record_create', trigger_inputs: triggerInputs('incident') }],
        sys_flow_record_trigger: [{ condition: '^EQ', active: 'true' }],
      },
    });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.checks.find(c => c.name === 'Active').ok, false);
  });

  it('skips trigger checks for a subflow', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({ records: { 'sys_hub_flow:f1': flow({ type: 'subflow' }) } });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.ok, true);
    assert.match(out.checks.find(c => c.name === 'Trigger').detail, /subflow/);
  });

  // Only record_* triggers register in sys_flow_record_trigger. Scheduled and
  // application triggers are dispatched elsewhere -- treating a missing
  // registration as a fault reports false failures on healthy flows.
  it('does not demand a registration for a non-record trigger', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow() },
      tables: { sys_hub_trigger_instance_v2: [{ trigger_type: 'service_catalog', trigger_inputs: '' }] },
    });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.ok, true, JSON.stringify(out.checks));
    assert.match(out.checks.find(c => c.name === 'Trigger').detail, /not a record trigger/);
  });

  it('flags a flow with no trigger instance', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      records: { 'sys_hub_flow:f1': flow() },
      tables: { sys_hub_trigger_instance_v2: [] },
    });

    const out = await flowStatus(sdk, 'f1');
    assert.strictEqual(out.ok, false);
    assert.match(out.checks.find(c => c.name === 'Trigger').detail, /no trigger instance/);
  });

  it('errors on an unknown flow', async () => {
    const { flowStatus } = await import('../src/flow-publish.js');
    await assert.rejects(() => flowStatus(buildSdk(), 'nope'), /No flow found/);
  });
});

describe('flows doctor', () => {
  const wsDef = [{ sys_id: 'd1', name: 'Workflow Automation Fluent APIs', base_uri: '/api/now/wfa_fluent', active: 'true' }];
  const wsOp = [{ sys_id: 'o1', name: 'Activate Flows and Actions', http_method: 'POST', relative_path: '/activate_flows', active: 'true' }];

  it('passes when the endpoint and plugins are present', async () => {
    const { publishDoctor } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      tables: {
        sys_ws_definition: wsDef,
        sys_ws_operation: wsOp,
        sys_plugins: [
          { name: 'ServiceNow IDE Platform', active: 'true' },
          { name: 'ServiceNow IDE Runtime Services', active: 'true' },
        ],
      },
    });

    const out = await publishDoctor(sdk);
    assert.strictEqual(out.ok, true, JSON.stringify(out.checks));
  });

  // sys_plugins is commonly ACL-blocked at the API level even for admins.
  // That must not fail a doctor run on an instance that publishes fine.
  it('degrades gracefully when sys_plugins is not readable', async () => {
    const { publishDoctor } = await import('../src/flow-publish.js');
    const sdk = buildSdk({
      tables: {
        sys_ws_definition: wsDef,
        sys_ws_operation: wsOp,
        sys_plugins: Object.assign(new Error('API error (status 403): User Not Authorized'), { status: 403 }),
      },
    });

    const out = await publishDoctor(sdk);
    assert.strictEqual(out.ok, true);
    const skipped = out.checks.find(c => c.skipped);
    assert.ok(skipped, 'expected a skipped plugin check');
    assert.match(skipped.detail, /no read access/);
  });

  it('fails when the activate_flows endpoint is missing', async () => {
    const { publishDoctor } = await import('../src/flow-publish.js');
    const sdk = buildSdk({ tables: { sys_ws_definition: [], sys_ws_operation: [], sys_plugins: [] } });

    const out = await publishDoctor(sdk);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.checks.find(c => c.name === 'wfa_fluent REST API').ok, false);
  });
});
