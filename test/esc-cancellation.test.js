// Escape must cancel every interactive command through one mechanism.
// These tests are keyboard-level: they drive real Inquirer prompts with a
// PassThrough TTY stand-in and assert the command stops before it mutates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { select, confirm, checkbox, PromptCancelled } from '../src/prompts.js';
import { cancelled } from '../src/flow-designer-interactive.js';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'docs' ? [] : jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('only src/prompts.js imports @inquirer/prompts directly', () => {
  const direct = jsFiles(srcRoot)
    .filter(file => /from '@inquirer\/prompts'|import\('@inquirer\/prompts'\)/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(path.join(srcRoot, '..'), file));

  // @inquirer/core is the pagination primitive, not a prompt surface.
  assert.deepEqual(direct, ['src/prompts.js']);
});

test('Escape on a nested confirmation cancels the flow before it mutates', async () => {
  const stream = new PassThrough();
  const output = new PassThrough();
  const entered = [];
  let mutations = 0;

  const flow = async () => {
    const action = await select({ message: 'Retain or revert', choices: ['retain', 'revert'] }, { input: stream, output });
    entered.push(action);
    if (!await confirm({ message: `Apply ${action}?`, default: false }, { input: stream, output })) return;
    mutations += 1;
  };

  const pending = flow();
  const cancelledRun = assert.rejects(pending, PromptCancelled);
  setImmediate(() => stream.write('\r'));
  setImmediate(() => setImmediate(() => stream.write('\x1b')));
  await cancelledRun;

  assert.deepEqual(entered, ['retain']);
  assert.equal(mutations, 0);
  assert.equal(stream.listenerCount('keypress'), 0);
});

test('Escape on the first nested prompt never reaches the next one', async () => {
  const stream = new PassThrough();
  const output = new PassThrough();
  let confirmations = 0;

  const flow = async () => {
    await select({ message: 'Pick a scope', choices: ['global', 'app'] }, { input: stream, output });
    confirmations += 1;
    await confirm({ message: 'Save?', default: false }, { input: stream, output });
    confirmations += 1;
  };

  const pending = flow();
  const cancelledRun = assert.rejects(pending, PromptCancelled);
  setImmediate(() => stream.write('\x1b'));
  await cancelledRun;

  assert.equal(confirmations, 0);
  assert.equal(stream.listenerCount('keypress'), 0);
});

test('multi-select checkbox cancels instead of returning an empty selection', async () => {
  const stream = new PassThrough();
  const output = new PassThrough();
  const pending = checkbox({ message: 'Select findings', choices: [{ name: 'One', value: 'one' }] }, { input: stream, output });
  const cancelledRun = assert.rejects(pending, PromptCancelled);
  setImmediate(() => stream.write('\x1b'));
  await cancelledRun;
  assert.equal(stream.listenerCount('keypress'), 0);
});

test('guided designer commands stop on cancellation instead of continuing without a value', async () => {
  const result = await cancelled(async () => {
    throw new PromptCancelled();
  });
  assert.equal(result, undefined);
});

test('the record picker advertises the same Escape convention', () => {
  const picker = fs.readFileSync(path.join(srcRoot, 'paginated-search.js'), 'utf8');
  assert.match(picker, /\(type to search, Esc to cancel\)/);
});
