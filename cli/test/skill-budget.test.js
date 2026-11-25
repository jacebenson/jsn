import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCLI } from '../src/cli.js';

// The skill is installed into every agent harness as one file, so it is a
// router: it says which command to reach for and what safety rule applies.
// Flags, examples and edge cases live in `--help`, which is always current.
// Twenty feature PRs each added a paragraph here before this budget existed.
// The cap is a ceiling, not a target: the file earns its place by saying which
// command to reach for, never by restating a flag.
const MAX_LINES = 72;
const MAX_WORDS = 600;

// Git checks Markdown out with CRLF on Windows; budgets and frontmatter are
// about content, not the checkout's line-ending convention.
const read = () => readFileSync(new URL('../skills/servicenow/SKILL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the bundled skill stays a router rather than a command reference', () => {
  const text = read();
  const lines = text.replace(/\n$/, '').split('\n').length;
  const words = text.trim().split(/\s+/).length;
  assert.ok(lines <= MAX_LINES,
    `SKILL.md is ${lines} lines, over the ${MAX_LINES}-line budget. Add a pointer to the command, not its flags or its history; --help carries those.`);
  assert.ok(words <= MAX_WORDS,
    `SKILL.md is ${words} words, over the ${MAX_WORDS}-word budget. Cut an existing sentence before adding a new one; every harness installs this file whole.`);
});

test('the skill declares a version the installer can compare', () => {
  const text = read();
  assert.match(text, /^---\n[\s\S]*?version: "\d+\.\d+\.\d+"[\s\S]*?\n---\n/, 'frontmatter must carry a quoted semantic version');
});

test('every command the skill names exists in the registry', () => {
  const registry = buildCLI().commandRegistry().commands;
  const known = new Set(registry.flatMap(command => [command.name, ...(command.aliases || [])]));
  const named = new Set([...read().matchAll(/`jsn ([a-z][a-z0-9-]*)/g)].map(match => match[1]));
  const missing = [...named].filter(name => !known.has(name));
  assert.deepEqual(missing, [], `the skill names commands the CLI does not register: ${missing.join(', ')}`);
});

test('the skill keeps one rule per line, with no repeated bullet', () => {
  const bullets = read().split('\n').filter(line => line.startsWith('- '));
  const seen = new Map();
  for (const bullet of bullets) {
    const key = bullet.slice(2).toLowerCase();
    assert.equal(seen.has(key), false, `duplicated bullet: ${bullet}`);
    seen.set(key, true);
  }
});
