#!/usr/bin/env node
/**
 * Interactive demo for JSN's local prompt engine (no dependencies, no
 * ServiceNow calls, no profile or config writes).
 *
 *   node cli/scripts/prompt-demo.mjs
 *
 * Keys:
 *   list/search : type to filter, ↑/↓ move, Enter select, Esc cancel
 *   paginated   : ↓ past the last loaded row loads the next page
 *   confirm     : y / n, Enter accepts the shown default
 *   checkbox    : Space toggles, ↑/↓ move, Enter confirms
 *   password    : input is never echoed
 *   text        : Enter submits the default when the line is empty
 */
import process from 'node:process';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('prompt-demo needs a real terminal (stdin and stdout must be TTYs).');
  process.exit(1);
}

const { input, password, confirm, select, search, checkbox, editor } = await import('../src/prompts.js');
const { paginatedSearch } = await import('../src/paginated-search.js');

const servers = Array.from({ length: 23 }, (_, index) => ({
  name: `srv-${String(index + 1).padStart(2, '0')} ${['database', 'app', 'web'][index % 3]} (10.0.0.${index + 1})`,
  value: { sys_id: `synthetic-${index + 1}`, name: `srv-${String(index + 1).padStart(2, '0')}` },
}));

console.log('\nJSN prompt engine demo — synthetic data only. Esc cancels, Ctrl+C exits.\n');

try {
const mode = await select({
  message: 'Which prompt?',
  choices: [
    { name: 'Paginated server picker (23 rows, load-more, search)', value: 'paginated' },
    { name: 'Search with async source', value: 'search' },
    { name: 'Text, password, confirm, checkbox', value: 'forms' },
    { name: 'Editor ($EDITOR)', value: 'editor' },
  ],
});

if (mode === 'paginated') {
  const picked = await paginatedSearch({
    message: 'Select a server',
    pageSize: 10,
    totalCount: servers.length,
    source: async (term, offset) => (term
      ? servers.filter(server => server.name.includes(term))
      : servers.slice(offset || 0, (offset || 0) + 10)),
  });
  console.log(picked ? `\nPicked ${picked.value.name} (${picked.value.sys_id})` : '\nNo server picked.');
} else if (mode === 'search') {
  const value = await search({
    message: 'Find a server name',
    source: async term => servers.filter(server => server.name.includes(term ?? '')).map(server => ({
      name: server.name, value: server.value.name,
    })),
  });
  console.log(`\nSelected ${value}`);
} else if (mode === 'forms') {
  const name = await input({ message: 'Display name', default: 'synthetic-profile', validate: value => value.length > 2 || 'Use at least 3 characters.' });
  const secret = await password({ message: 'Password (never echoed)', mask: '*' });
  const proceed = await confirm({ message: 'Proceed with these answers?', default: false });
  const picked = await checkbox({
    message: 'Which synthetic tables?',
    required: true,
    choices: ['incident', 'change_request', 'problem'],
  });
  console.log(`\nname=${name} secretLength=${secret.length} proceed=${proceed} tables=${picked.join(',')}`);
} else if (mode === 'editor') {
  const notes = await editor({ message: 'Write demo notes', default: '# synthetic notes\n' });
  console.log(`\nEditor returned ${notes.length} characters.`);
} else {
  console.log('\nNothing selected.');
}
} catch (error) {
  if (error.name !== 'PromptCancelled') throw error;
  console.log('\nCancelled.');
}
