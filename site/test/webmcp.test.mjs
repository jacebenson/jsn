import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Exercise the asset copied into the deployable site, including inside the image.
const source = fs.readFileSync(new URL('../public/assets/webmcp.js', import.meta.url), 'utf8');
function setup({ secure = true, supported = true, fetch = async () => { throw new Error('Unexpected fetch'); }, parser } = {}) {
  const tools = new Map();
  vm.runInNewContext(source, { window: { isSecureContext: secure }, document: supported ? { modelContext: { registerTool: tool => tools.set(tool.name, tool) } } : {}, URL, URLSearchParams, fetch, DOMParser: parser });
  const call = async (name, input, options) => JSON.parse(await tools.get(name).execute(input, options));
  return { tools, call };
}
test('unsupported and insecure browsers remain untouched', () => {
  assert.equal(setup({ supported: false }).tools.size, 0);
  assert.equal(setup({ secure: false }).tools.size, 0);
});
test('six narrow schema-bearing read-only tools; no arbitrary URL reader', () => {
  const { tools } = setup();
  assert.equal(tools.size, 6);
  assert.equal(tools.has('jsn_docs_read_page'), false);
  for (const tool of tools.values()) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.untrustedContentHint, true);
  }
});
test('install/update preserve exact scoped package and explicit channels', async () => {
  const { call } = setup();
  for (const channel of ['stable', 'dev']) {
    const command = `npm install -g @jacebenson/jsn${channel === 'dev' ? '@dev' : ''}`;
    assert.equal((await call('jsn_install_guidance', { channel })).commands[0], command);
    assert.deepEqual((await call('jsn_update_guidance', { channel })).commands, ['jsn version --check', command, 'jsn version']);
  }
  assert.match((await call('jsn_update_guidance')).error, /Missing channel/);
});
test('remove and GitHub workflows instruct only; never fetch or post', async () => {
  const { call } = setup();
  const remove = await call('jsn_remove_guidance');
  assert.deepEqual(remove.commands, ['npm uninstall -g @jacebenson/jsn']);
  assert.match(remove.note, /not user-created JSN profiles, credentials/);
  for (const name of ['jsn_bug_guidance', 'jsn_feature_request_guidance']) {
    const result = await call(name);
    assert.equal(result.url, 'https://github.com/jacebenson/jsn/issues/new/choose');
    assert.match(result.note, /Human review/);
  }
});
test('invalid values rejected before network; no URL/code execution inputs', async () => {
  const { call } = setup();
  for (const input of [{}, { query: ' ', source: 'jsn' }, { query: 'x'.repeat(201), source: 'jsn' }, { query: 'x', source: 'other' }, { query: 'x', source: 'jsn', url: 'https://evil.test' }, null, []]) {
    assert.ok((await call('jsn_docs_search', input)).error);
  }
  assert.ok((await call('jsn_install_guidance', { channel: 'latest' })).error);
});
test('ServiceNow search reuses API, bounds results and preserves served release', async () => {
  const requests = [];
  const controller = new AbortController();
  const { call } = setup({ fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ release: 'fixture-family', results: Array.from({ length: 20 }, () => ({ title: 'Class', path: 'api/Class.md', summary: 'Text'.repeat(300) })) }) };
  } });
  const result = await call('jsn_docs_search', { query: 'GlideRecord', source: 'servicenow' }, { signal: controller.signal });
  assert.equal(requests[0].url, '/api/docs/search?q=GlideRecord&limit=4');
  assert.equal(requests[0].options.signal, controller.signal);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.match(result.source, /not JSN CLI/);
  assert.match(result.results[0].url, /release=fixture-family/);
  assert.ok(result.results.length <= 4);
  assert.ok(JSON.stringify(result).length <= 1800);
});
test('JSN search uses rendered catalog and fixed canonical result allowlist', async () => {
  const card = (href, text) => ({ textContent: text, getAttribute: () => href, querySelector: () => ({ textContent: text }) });
  class Parser { parseFromString() { return { querySelectorAll: () => [card('/features/servicenow-cli-auth-setup/', 'Auth setup'), card('https://evil.test/features/auth', 'Auth evil'), card('/admin', 'Auth admin')] }; } }
  const { call } = setup({ parser: Parser, fetch: async url => { assert.equal(url, '/features'); return { ok: true, text: async () => 'catalog fixture' }; } });
  const result = await call('jsn_docs_search', { query: 'auth', source: 'jsn' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://jsn.jace.pro/features/servicenow-cli-auth-setup/');
});
test('network failures and cancellation return concise explicit errors', async () => {
  const { call } = setup({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.match((await call('jsn_docs_search', { query: 'x', source: 'servicenow' })).error, /503/);
  const cancelled = setup({ fetch: async () => { throw new DOMException('stop', 'AbortError'); } });
  assert.equal((await cancelled.call('jsn_docs_search', { query: 'x', source: 'servicenow' })).error, 'Cancelled.');
});
test('site-owned bundle matches prepared asset and shared layout', () => {
  const layout = fs.readFileSync(new URL('../app/views/layouts/application.html.erb', import.meta.url), 'utf8');
  assert.match(layout, /src="\/assets\/webmcp.js\?v=2" defer/);
  const sourcePath = new URL('../static/assets/webmcp.js', import.meta.url);
  if (fs.existsSync(sourcePath)) assert.equal(source, fs.readFileSync(sourcePath, 'utf8'));
});
