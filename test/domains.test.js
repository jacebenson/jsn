// Tests for domains commands — structure + capability gating + detail formatter

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureSubcommands } from './support/command-test-helpers.js';

describe('Domains Command Structure', () => {
  it('should export domainsCmd', async () => {
    const { domainsCmd } = await import('../src/commands/dev/domains.js');
    assert.strictEqual(typeof domainsCmd, 'function');
  });

  it('defines list, show, current, set subcommands', async () => {
    const { domainsCmd } = await import('../src/commands/dev/domains.js');
    const wrap = (fn) => fn;
    const names = captureSubcommands(domainsCmd(wrap)).map((s) => s.command.split(' ')[0]);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('show'));
    assert.ok(names.includes('current'));
    assert.ok(names.includes('set'));
  });

  it('isDomainSeparationInstalled returns false on an API error', async () => {
    const { isDomainSeparationInstalled } = await import('../src/commands/dev/domains.js');
    const app = { sdk: { list: async () => { throw new Error('Invalid table domain'); } } };
    assert.strictEqual(await isDomainSeparationInstalled(app), false);
  });

  it('isDomainSeparationInstalled returns true when the domain table is queryable', async () => {
    const { isDomainSeparationInstalled } = await import('../src/commands/dev/domains.js');
    const app = { sdk: { list: async () => [{ sys_id: 'x', name: 'TOP' }] } };
    assert.strictEqual(await isDomainSeparationInstalled(app), true);
  });
});

describe('Domains Detail Formatter', () => {
  it('formats a domain with path, parent, and record link', async () => {
    const { formatDomainDetail } = await import('../src/commands/dev/domains.js');
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
    const { formatDomainDetail } = await import('../src/commands/dev/domains.js');
    const app = {
      getEffectiveInstance: () => 'https://dev.service-now.com',
      sdk: { list: async () => [{ sys_id: 'top-id', name: 'TOP', parent: '', sys_domain_path: '!!! /'.replace(' ', ''), active: 'true' }] },
    };
    const detail = await formatDomainDetail(app, { sys_id: 'top-id', name: 'TOP' });
    assert.ok(detail._formatted.includes('Path:     !!!/'));
    assert.ok(detail._formatted.includes('Parent:   (none)'));
  });
});
