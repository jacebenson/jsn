// Tests for domains commands — structure + capability gating + detail formatter

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands } from './support/command-test-helpers.js';

describe('Domains Command Structure', () => {
  it('defines list, show, current, set subcommands', async () => {
    const { domainsCmd } = await import('../src/commands/domains.js');
    const wrap = (fn) => fn;
    const names = captureSubcommands(domainsCmd(wrap)).map((s) => s.command.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('show'));
    assert.ok(names.includes('current'));
    assert.ok(names.includes('set'));
  });

  it('isDomainSeparationInstalled returns false on an API error', async () => {
    const { isDomainSeparationInstalled } = await import('../src/commands/domains.js');
    const app = { sdk: { list: async () => { throw new Error('Invalid table domain'); } } };
    assert.strictEqual(await isDomainSeparationInstalled(app), false);
  });

  it('isDomainSeparationInstalled returns true when the domain table is queryable', async () => {
    const { isDomainSeparationInstalled } = await import('../src/commands/domains.js');
    const app = { sdk: { list: async () => [{ sys_id: 'x', name: 'TOP' }] } };
    assert.strictEqual(await isDomainSeparationInstalled(app), true);
  });
});

describe('Domains Detail Formatter', () => {
  it('formats a domain with path, parent, and record link', async () => {
    const { formatDomainDetail } = await import('../src/commands/domains.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: { list: async () => [{ sys_id: 'acme-id', name: 'ACME', parent: 'TOP', sys_domain_path: '!!! /!!&/'.replace(' ', ''), description: 'demo', active: 'true' }] },
    };
    const detail = await formatDomainDetail(app, { sys_id: 'acme-id', name: 'ACME' });
    assert.ok(detail._formatted.includes('Domain:   ACME'));
    assert.ok(detail._formatted.includes('Path:     !!!/!!&/'));
    assert.ok(detail._formatted.includes('Parent:   TOP'));
    assert.ok(detail._formatted.includes('Link:     https://dev.service-now.com/domain.do?sys_id=acme-id'));
  });

  it('marks root domains with "(none)" parent', async () => {
    const { formatDomainDetail } = await import('../src/commands/domains.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: { list: async () => [{ sys_id: 'top-id', name: 'TOP', parent: '', sys_domain_path: '!!! /'.replace(' ', ''), active: 'true' }] },
    };
    const detail = await formatDomainDetail(app, { sys_id: 'top-id', name: 'TOP' });
    assert.ok(detail._formatted.includes('Path:     !!!/'));
    assert.ok(detail._formatted.includes('Parent:   (none)'));
  });
});

// Run the actual handlers with the real profile resolver, without instance I/O.
describe('Configured domain reporting', () => {
  const profiles = {
    active: { instance_url: 'https://example.service-now.com', domain: 'active-id' },
    fallback: { instance_url: 'https://example.service-now.com', domain: 'fallback-id' },
    empty: { instance_url: 'https://example.service-now.com' },
  };
  for (const [name, selectors, activeProfile, expected] of [
    ['unconfigured', {}, undefined, ''],
    ['active profile', {}, 'active', 'active-id'],
    ['default profile', {}, undefined, 'fallback-id'],
    ['explicit profile', { profile: 'fallback' }, 'active', 'fallback-id'],
    ['explicit empty profile', { profile: 'empty' }, 'active', ''],
  ]) {
    it(name, async () => {
      const { resolveSession } = await import('../src/session.js');
      const { domainsCmd } = await import('../src/commands/domains.js');
      const config = { profiles, activeProfile, defaultProfile: name === 'unconfigured' ? undefined : 'fallback' };
      const before = structuredClone(config);
      const session = resolveSession(selectors, config);
      let output;
      const app = { session, sdk: { list: async (table, params) => {
        if (params.has('sysparm_query')) assert.equal(params.get('sysparm_query'), `sys_id=${expected}`);
        return [{ sys_id: expected, name: 'Selected' }];
      } }, ok: (data, meta) => { output = { data, meta }; } };
      const handler = captureSubcommands(domainsCmd(fn => fn)).find(c => c.command === 'current').handler;
      await handler(selectors, app);
      assert.equal(output.data.domain, expected);
      assert.equal(output.data.scoping, expected ? 'X-Now-Domain header' : 'none');
      assert.match(output.meta.summary, expected ? /Selected/ : /server session scoping/);
      assert.deepEqual(config, before);
    });
  }
});

describe('Domain probe error classification', () => {
  for (const status of [401, 403, 404, 429, 500, 0]) {
    it(`preserves unrelated error status ${status}`, async () => {
      const { isDomainSeparationInstalled } = await import('../src/commands/domains.js');
      const error = Object.assign(new Error('Request failed'), { status });
      await assert.rejects(isDomainSeparationInstalled({ sdk: { list: async () => { throw error; } } }), e => e === error);
    });
  }
});

describe('Browser session domains', () => {
  function mockApp(request) {
    return { sdk: { baseURL: 'https://example.service-now.com', domain: 'configured',
      authProvider: { getCredentials: async () => ({ auth_method: 'gck' }) },
      request: async (url, opts) => {
        assert.equal(opts.domain, '');
        return request(url, opts);
      } } };
  }
  it('reads actual session independently from profile domain', async () => {
    const { readSessionDomain } = await import('../src/commands/domains.js');
    const app = mockApp(async () => ({ result: { currentDomain: { value: 'global' } } }));
    assert.equal((await readSessionDomain(app)).value, 'global');
    assert.equal(app.sdk.domain, 'configured');
  });
  it('paginates and supports prefix/substring search without switching', async () => {
    const { listSessionDomains } = await import('../src/commands/domains.js');
    for (const [search, query] of [['TOP', 'nameSTARTSWITHTOP'], ['*TOP', 'nameCONTAINSTOP']]) {
      const app = mockApp(async (url, opts) => {
        assert.match(url, /angular.do\?sysparm_type=ref_list_data$/);
        assert.equal(opts.method, 'POST');
        assert.deepEqual(JSON.parse(opts.body), {
          sysparm_domain: 'picker', table: 'domain', sysparm_for_impersonation: false,
          qualifier: 'active=true', count: 2, start: 4,
          p: `domain;q:${query}^nameISNOTEMPTY;r:active=true`,
        });
        return { items: [{ sys_id: 'one' }, { sys_id: 'two' }] };
      });
      assert.equal((await listSessionDomains(app, { search, offset: 4, limit: 2 })).next_offset, 6);
    }
  });
  for (const target of ['global', 'a'.repeat(32)]) {
    it(`switches to ${target} and verifies readback without touching session keepalive`, async () => {
      const { switchSessionDomain } = await import('../src/commands/domains.js');
      let selected = 'original';
      const calls = [];
      const app = mockApp(async (url, opts) => {
        calls.push(url);
        if (opts.method === 'PUT') {
          assert.match(url, /concoursepicker\/domain$/);
          assert.equal(opts.body, target === 'global' ? undefined : JSON.stringify({ value: target }));
          selected = target;
          return {};
        }
        return { result: { currentDomain: { value: selected } } };
      });
      assert.equal((await switchSessionDomain(app, target)).value, target);
      assert.equal(calls.length, 3);
      assert.equal(app.sdk.domain, 'configured');
    });
  }
  it('rejects failed readback and non-browser authentication', async () => {
    const { switchSessionDomain, readSessionDomain } = await import('../src/commands/domains.js');
    const app = mockApp(async () => ({ result: { currentDomain: { value: 'original' } } }));
    await assert.rejects(switchSessionDomain(app, 'global'), /verification failed/);
    app.sdk.authProvider.getCredentials = async () => ({ auth_method: 'basic' });
    await assert.rejects(readSessionDomain(app), /require browser-session/);
  });
  it('surfaces authentication errors before any switch', async () => {
    const { switchSessionDomain } = await import('../src/commands/domains.js');
    let calls = 0;
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    const app = mockApp(async () => { calls++; throw error; });
    await assert.rejects(switchSessionDomain(app, 'global'), e => e === error);
    assert.equal(calls, 1);
  });
});

describe('Session domain mutation guards', () => {
  it('declares only reset and selection as session mutations', async () => {
    await import('../src/cli.js');
    const { isMutationCommand } = await import('../src/mutations.js');
    for (const command of ['session-set', 'session-reset']) {
      assert.equal(isMutationCommand({ _: ['domains', command] }), true);
    }
    for (const command of ['session-current', 'session-list']) {
      assert.equal(isMutationCommand({ _: ['domains', command] }), false);
    }
  });
  it('rejects malformed responses and invalid picker arguments', async () => {
    const { readSessionDomain, listSessionDomains, switchSessionDomain } = await import('../src/commands/domains.js');
    const app = { sdk: { baseURL: 'https://example.service-now.com',
      authProvider: { getCredentials: async () => ({ auth_method: 'gck' }) }, request: async () => ({}) } };
    await assert.rejects(readSessionDomain(app), /Invalid session domain response/);
    await assert.rejects(listSessionDomains(app), /Invalid domain picker response/);
    await assert.rejects(listSessionDomains(app, { offset: -1 }), /Picker offset/);
    await assert.rejects(listSessionDomains(app, { search: 'TOP^ORactive=false' }), /./);
    await assert.rejects(switchSessionDomain(app, 'TOP'), /Supply a domain sys_id/);
  });
});
