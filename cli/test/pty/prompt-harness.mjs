#!/usr/bin/env node
/**
 * PTY harness: drives the real prompt engine through a pseudo-terminal and
 * prints machine-readable markers. Synthetic data only; no config, profile,
 * provider or installed-jsn dependency.
 *
 * Usage: node test/pty/prompt-harness.mjs <scenario>
 * Markers: MARK:<name>:<json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scenario = process.argv[2];
const mark = (name, value) => process.stdout.write(`\nMARK:${name}:${JSON.stringify(value)}\n`);

const servers = Array.from({ length: 23 }, (_, index) => ({
  name: `server-${String(index + 1).padStart(2, '0')}${index % 3 === 0 ? ' database' : ' app'}`,
  value: index + 1,
}));

function paginatedSource(offsets) {
  return async (term, offset) => {
    offsets.push({ term: term ?? null, offset: offset ?? null });
    if (term) return servers.filter(server => server.name.includes(term));
    if (offset === undefined) return servers;
    return servers.slice(offset, offset + 10);
  };
}

async function run() {
  switch (scenario) {
    case 'filter-pick': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      const offsets = [];
      const picked = await paginatedSearch({
        message: 'Pick a server', pageSize: 10, totalCount: servers.length,
        source: paginatedSource(offsets),
      });
      mark('picked', picked ? picked.value : null);
      mark('lastQuery', offsets.at(-1));
      break;
    }
    case 'load-more': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      const offsets = [];
      const picked = await paginatedSearch({
        message: 'Pick a server', pageSize: 10, totalCount: servers.length,
        source: paginatedSource(offsets),
      });
      mark('picked', picked ? picked.value : null);
      mark('offsets', offsets.map(entry => entry.offset));
      break;
    }
    case 'escape': {
      const { select, PromptCancelled } = await import('../../src/prompts.js');
      try {
        const answer = await select({ message: 'Pick', choices: ['one', 'two'] });
        mark('answer', answer ?? null);
      } catch (error) {
        mark('cancelled', error instanceof PromptCancelled);
      }
      break;
    }
    case 'picker-escape': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      const picked = await paginatedSearch({
        message: 'Pick a server', pageSize: 10, totalCount: servers.length,
        source: paginatedSource([]),
      });
      mark('answer', picked ?? null);
      break;
    }
    case 'ctrl-c': {
      const { select } = await import('../../src/prompts.js');
      try {
        await select({ message: 'Pick', choices: ['one'] });
        mark('answer', 'unexpected');
      } catch (error) {
        mark('cancelled', error.name);
      }
      break;
    }
    case 'stale-source': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const picked = await paginatedSearch({
        message: 'Search', pageSize: 10, totalCount: 2,
        source: async term => {
          if (term === 'a') { await delay(600); return [{ name: 'stale-a', value: 'stale-a' }]; }
          if (term === 'ab') { await delay(20); return [{ name: 'fresh-ab', value: 'fresh-ab' }]; }
          return [];
        },
      });
      mark('picked', picked ? picked.value : null);
      break;
    }
    case 'sequential': {
      const { input, confirm } = await import('../../src/prompts.js');
      const name = await input({ message: 'Name', default: 'fallback' });
      const ok = await confirm({ message: 'Continue', default: false });
      mark('name', name);
      mark('confirmed', ok);
      break;
    }
    case 'empty-and-failure': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      const { search } = await import('../../src/prompts.js');
      const empty = await paginatedSearch({ message: 'Empty', totalCount: 0, source: async () => [] });
      mark('empty', empty ?? null);
      const failed = await paginatedSearch({ message: 'Broken', totalCount: 1, source: async () => { throw new Error('synthetic source failure'); } });
      mark('failure', failed ?? null);
      const none = await search({ message: 'Find', source: async term => (term === 'zzz' ? [] : servers) });
      mark('search', none ?? null);
      break;
    }
    case 'password': {
      const { password, mfaCode } = await import('../../src/prompts.js');
      const secret = await password({ message: 'Password', mask: '*' });
      mark('secretLength', secret.length);
      mark('secretIsExpected', secret === 'hunter2');
      const code = await mfaCode({ message: 'Authenticator code' });
      mark('code', code);
      break;
    }
    case 'confirm-yes':
    case 'confirm-no': {
      const { confirm } = await import('../../src/prompts.js');
      const answer = await confirm({ message: 'Proceed?', default: scenario === 'confirm-yes' });
      mark('confirmed', answer);
      break;
    }
    case 'checkbox': {
      const { checkbox } = await import('../../src/prompts.js');
      const picked = await checkbox({
        message: 'Pick findings', required: true,
        choices: [{ name: 'One', value: 'one' }, { name: 'Two', value: 'two' }, { name: 'Three', value: 'three' }],
      });
      mark('picked', picked);
      break;
    }
    case 'editor': {
      // A controlled fake editor: writes fixed content, never opens a real one.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-pty-editor-'));
      const fake = path.join(directory, 'fake-editor.sh');
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "fixed editor content" > "$1"\n', { mode: 0o755 });
      process.env.EDITOR = fake;
      const { editor } = await import('../../src/prompts.js');
      const content = await editor({ message: 'Notes', default: 'seed' });
      mark('content', content);
      fs.rmSync(directory, { recursive: true, force: true });
      break;
    }
    case 'setup-hub': {
      const { authHubPrompt } = await import('../../src/commands/setup.js');
      const choices = [
        { section: 'Connections', name: 'Check connections', value: 'status' },
        { section: 'Connections', name: 'Add a connection', value: 'add' },
        { section: 'Cleanup', name: 'Remove a connection', value: 'remove' },
      ];
      const action = await authHubPrompt({ message: 'jsn setup', choices });
      mark('action', action ?? null);
      break;
    }
    case 'demo': {
      await import('../../scripts/prompt-demo.mjs');
      break;
    }
    case 'pending-cancel': {
      const { paginatedSearch } = await import('../../src/paginated-search.js');
      let signal;
      const picked = await paginatedSearch({ message: 'Pending', source: (_term, _offset, context) => {
        signal = context.signal;
        return new Promise(() => {});
      } });
      mark('answer', picked ?? null);
      mark('sourceAborted', signal.aborted);
      break;
    }
    case 'eof': {
      const { input } = await import('../../src/prompts.js');
      try { await input({ message: 'EOF input' }); }
      catch (error) { mark('cancelled', error.name); }
      break;
    }
    case 'text-validation': {
      const { input, mfaCode } = await import('../../src/prompts.js');
      const answer = await input({ message: 'Mixed input', validate: value => value === 'A+é@x.test!' || 'Try again.' });
      mark('exactText', answer === 'A+é@x.test!');
      const code = await mfaCode({ message: 'Code' });
      mark('validCode', code === '654321');
      break;
    }
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
  mark('done', true);
}

run().then(() => {
  process.exitCode = 0;
}, error => {
  mark('error', `${error.name}: ${error.message}`);
  process.exitCode = 1;
});
