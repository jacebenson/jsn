import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCLI } from '../src/cli.js';
import { mutationPaths, isLocalPreview } from '../src/capabilities.js';
import { isMutationCommand } from '../src/mutations.js';

// The CLI's command tokens are its vocabulary. A new verb is a user-facing
// promise that has to beat the verbs already in use, so it may not appear
// without a reviewed entry in command-verbs.json.
const vocabulary = JSON.parse(fs.readFileSync(new URL('./command-verbs.json', import.meta.url), 'utf8'));
const approved = vocabulary.approved || {};
const existing = new Set(vocabulary.existing);

function commandTree() {
  const cli = buildCLI();
  const tokens = new Map();
  const walk = (node, prefix) => {
    node.build();
    for (const child of node.children) {
      const path = [...prefix, child.name];
      if (!child.name.startsWith('<')) {
        if (!tokens.has(child.name)) tokens.set(child.name, []);
        tokens.get(child.name).push(path.join(' '));
      }
      walk(child, path);
    }
  };
  walk(cli.root, []);
  return { root: cli.root, tokens };
}

// A declared mutation path must name a command that exists. Aliases count: the
// registry keeps them beside the node, and argv can arrive through one.
function resolves(root, path) {
  let node = root;
  for (const token of path) {
    node.build();
    node = node.children.find(child => child.name === token || (child.aliases || []).includes(token));
    if (!node) return false;
  }
  return true;
}

test('every registered command token is vocabulary someone reviewed', () => {
  const { tokens } = commandTree();
  const unknown = [...tokens.keys()].filter(token => !existing.has(token) && !approved[token]);
  assert.deepEqual(unknown.sort(), [],
    `new command verb(s) ${unknown.join(', ')}: add an entry to cli/test/command-verbs.json under "approved" whose why names the verb you chose it over, and why that one does not fit`);
});

test('an approved verb says why it beats a verb already in use', () => {
  const vocabularySet = new Set([...existing, ...Object.keys(approved)]);
  for (const [verb, entry] of Object.entries(approved)) {
    const why = String(entry?.why || '').trim();
    assert.ok(why.length >= 40, `${verb}: why must say in a sentence why the existing verbs do not fit`);
    const named = [...vocabularySet].filter(other => other !== verb
      && new RegExp(`(^|[^a-z-])${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z-]|$)`).test(why));
    assert.ok(named.length >= 1, `${verb}: why must name at least one verb already in use, so the comparison is reviewable`);
  }
});

test('a token no command uses any more leaves the vocabulary', () => {
  const { tokens } = commandTree();
  const stale = [...existing, ...Object.keys(approved)].filter(token => !tokens.has(token));
  assert.deepEqual(stale.sort(), [], 'these tokens are no longer registered; delete them from cli/test/command-verbs.json rather than leaving a wish list');
});

// A command is a read or a write. That class follows the path, never an
// option: an option that adds a mutation makes the same command readable or
// blocked depending on argv, which a read-only profile cannot audit. The one
// documented exception is a declared local preview, which removes a write
// rather than adding one.
test('a command keeps its read or write class whatever options are passed', () => {
  const { tokens } = commandTree();
  const flags = [{ dryRun: true }, { force: true }, { yes: true }, { execute: true }, { on: true }, { off: true }, { include: 'x' }, { exclude: 'x' }, { deletes: 'off' }, { audit: true }];
  const paths = [...new Set([...tokens.values()].flat())]
    .map(path => path.split(' '))
    .filter(parts => !parts.some(part => part.startsWith('<')));
  const changed = [];
  for (const parts of paths) {
    const base = isMutationCommand({ _: parts });
    for (const flag of flags) {
      const argv = { _: parts, ...flag };
      if (isLocalPreview(argv)) continue;
      if (isMutationCommand(argv) !== base) changed.push(`${parts.join(' ')} ${JSON.stringify(flag)}`);
    }
  }
  assert.deepEqual(changed.sort(), [], 'these commands change read/write class because of an option; move the change to a subcommand');
});

test('every declared mutation path resolves to a command that exists', () => {
  const { root } = commandTree();
  const broken = mutationPaths().filter(path => !resolves(root, path)).map(path => path.join(' '));
  assert.deepEqual(broken.sort(), [],
    'a mutation path that matches no command cannot be enforced: a typo here lets a write through a read-only profile');
});
