import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeCmd } from '../src/commands/knowledge.js';
import { captureCommands } from './support/command-test-helpers.js';
import { visibleCommandRegistry } from '../src/command-audience.js';
import { buildCLI } from '../src/cli.js';

const ID = 'a'.repeat(32);
function fixture(response) {
  const calls = [], output = [];
  const app = { sdk: { baseURL: 'https://example.invalid', request: async (...args) => { calls.push(args); return response; } },
    ok: (data, options) => output.push({ data, options }) };
  const commands = captureCommands(knowledgeCmd(fn => fn));
  return { calls, output, app, run: (name, args) => commands.find(c => c.command.startsWith(name + ' ')).handler({ limit: 20, offset: 0, ...args }, app) };
}

test('knowledge search uses native parameters, preserves punctuation as text and pins article/page hints', async () => {
  const f = fixture({ result: { meta: { count: 21, status: { code: 200 } }, articles: [{ number: 'KB001', title: 'VPN', id: `kb_knowledge:${ID}` }] } });
  await f.run('search', { text: 'VPN & network^query', kb: ID, language: 'en', profile: 'work' });
  const url = new URL(f.calls[0][0]);
  assert.equal(url.pathname, '/api/sn_km_api/knowledge/articles');
  assert.equal(url.searchParams.get('query'), 'VPN & network^query');
  assert.equal(url.searchParams.get('kb'), ID);
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(f.calls[0][1].method, 'GET');
  assert.equal(f.output[0].data.count, 1);
  assert.ok(f.output[0].options.breadcrumbs.every(h => h.cmd.endsWith(' --profile work')));
  assert.match(f.output[0].options.breadcrumbs.at(-1).cmd, /--offset 20/);
});

test('empty, malformed and rejected results remain distinct, with no alternate table request', async () => {
  const empty = fixture({ result: { articles: [], meta: { count: 0 } } });
  await empty.run('search', { text: 'none' });
  assert.equal(empty.output[0].data.count, 0);
  for (const response of [{ result: {} }, { result: { articles: [null] } }, { result: { articles: [], meta: { status: { code: 403 } } } }]) {
    const f = fixture(response);
    await assert.rejects(f.run('search', { text: 'vpn' }));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(null);
  f.app.sdk.request = async (...args) => { f.calls.push(args); throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await assert.rejects(f.run('search', { text: 'vpn' }), /forbidden/);
  assert.equal(f.calls.length, 1);
});

test('invalid filters and paging fail before transport', async () => {
  for (const args of [{ text: '' }, { text: 'vpn', limit: 0 }, { text: 'vpn', offset: -1 }, { text: 'vpn', kb: 'bad^id' }, { text: 'vpn', language: 'xx&query=all' }]) {
    const f = fixture(null);
    await assert.rejects(f.run('search', args));
    assert.equal(f.calls.length, 0);
  }
});

test('article display preserves HTML in JSON and renders text without requesting view-count updates', async () => {
  const f = fixture({ result: { sys_id: ID, number: 'KB001', content: '<p>Connect <strong>VPN</strong></p>', short_description: 'VPN setup' } });
  await f.run('show', { id: 'KB001' });
  assert.equal(f.output[0].data.content, '<p>Connect <strong>VPN</strong></p>');
  assert.match(f.output[0].data._formatted, /Connect \*\*VPN\*\*/);
  assert.equal(new URL(f.calls[0][0]).searchParams.has('update_view'), false);
  assert.equal(new URL(f.calls[0][0]).searchParams.has('search_rank'), false);
  await assert.rejects(f.run('show', { id: '../featured' }));
  assert.equal(f.calls.length, 1);
});

test('knowledge is discoverable to basic users with search/show and the kb alias', () => {
  const registry = buildCLI([]).commandRegistry();
  const config = { activeProfile: 'work', profiles: { work: { username: 'u', instance_url: 'https://example.invalid', command_audience: { mode: 'basic', username: 'u', instance_url: 'https://example.invalid' } } } };
  const command = visibleCommandRegistry(registry, config).commands.find(c => c.name === 'knowledge');
  assert.ok(command.aliases.includes('kb'));
  assert.deepEqual(command.actions.map(a => a.name), ['search', 'show']);
});
