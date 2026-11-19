import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm, editor, PromptCancelled } from '../src/prompts.js';
import { paginatedSearch } from '../src/paginated-search.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 25));
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let visible = '';
  output.on('data', chunk => { visible += chunk; });
  return { input, output, visible: () => visible };
}

for (const size of [2, 10]) {
  test(`obsolete load-more cannot move the filtered highlight after ${size} browse rows`, async () => {
    const io = terminal();
    let release;
    const filtered = Array.from({ length: size + 2 }, (_, i) => ({ name: `filtered-${i}`, value: `filtered-${i}` }));
    const answer = paginatedSearch({ message: 'Synthetic race', pageSize: size, totalCount: size * 2, source(term, offset) {
      if (term) return filtered;
      if (offset === 0) return Array.from({ length: size }, (_, i) => ({ name: `browse-${i}`, value: i }));
      return new Promise(resolve => { release = resolve; });
    } }, io);
    await tick();
    io.input.write('\x1b[B'.repeat(size));
    await tick();
    assert.equal(typeof release, 'function');
    io.input.write('x');
    await tick();
    release([{ name: 'obsolete', value: 'obsolete' }]);
    await tick();
    io.input.write('\r');
    assert.equal((await answer).value, 'filtered-0');
    assert.equal(io.input.listenerCount('keypress'), 0);
  });
}

test('failed load-more preserves selection and can retry the same offset', async () => {
  const io = terminal();
  const offsets = [];
  let attempts = 0;
  const answer = paginatedSearch({ message: 'Retry page', totalCount: 2, source(_term, offset) {
    offsets.push(offset);
    if (offset === 0) return [{ name: 'One', value: 1 }];
    if (++attempts === 1) throw new Error('synthetic page failure');
    return [{ name: 'Two', value: 2 }];
  } }, io);
  await tick();
  io.input.write('\x1b[B');
  await tick();
  assert.match(io.visible(), /synthetic page failure/);
  io.input.write('\x1b[B');
  await tick();
  io.input.write('\r');
  assert.equal((await answer).value, 2);
  assert.deepEqual(offsets, [0, 1, 1]);
});

test('confirmation stays pending after y, permits backspace/no, commits only on Enter', async () => {
  const io = terminal();
  let settled = false;
  const answer = confirm({ message: 'Synthetic mutation', default: false }, io).then(value => { settled = true; return value; });
  io.input.write('y');
  await tick();
  const pendingAfterY = !settled;
  io.input.write('\x7fno\r');
  assert.equal(await answer, false);
  assert.equal(pendingAfterY, true);
});

for (const [keys, config, expected] of [['y\r', {}, true], ['n\r', { default: true }, false], ['\r', { default: false }, false], ['\r', { default: true }, true], ['\r', {}, true]]) {
  test(`confirmation submits ${JSON.stringify(keys)} with default ${config.default}`, async () => {
    const io = terminal();
    const answer = confirm({ message: 'Confirm', ...config }, io);
    io.input.write(keys);
    assert.equal(await answer, expected);
  });
}

test('confirmation y can still be cancelled without committing', async () => {
  const io = terminal();
  const answer = confirm({ message: 'Do not mutate', default: false }, io);
  const rejected = assert.rejects(answer, PromptCancelled);
  io.input.write('y');
  await tick();
  io.input.write('\x03');
  await rejected;
});

function fakeEditor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-correction-editor-'));
  const marker = path.join(directory, 'launched');
  const fake = path.join(directory, 'fake.cjs');
  fs.writeFileSync(fake, `const fs = require('node:fs'); const file = process.argv[2]; fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync(file, 'utf8')); fs.appendFileSync(file, '\\nedited');`);
  const visual = process.env.VISUAL;
  process.env.VISUAL = `${process.execPath} ${fake}`;
  t.after(() => {
    if (visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = visual;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return marker;
}

test('editor displays instructions and waits for Enter, retaining the default draft', async t => {
  const marker = fakeEditor(t);
  const io = terminal();
  const controller = new AbortController();
  const answer = editor({ message: 'Completion notes, one bullet per line', default: 'seed' }, { ...io, signal: controller.signal });
  const observed = answer.catch(error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.match(io.visible(), /Completion notes, one bullet per line/);
    assert.match(io.visible(), /Press Enter.*editor/);
    assert.equal(fs.existsSync(marker), false, 'editor launched before Enter');
    io.input.write('\r');
    assert.equal(await answer, 'seed\nedited');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'seed');
    assert.equal(io.input.listenerCount('keypress'), 0);
  } finally {
    controller.abort();
    await observed;
  }
});

test('Escape before launching the editor has no editor side effects', async t => {
  const marker = fakeEditor(t);
  const io = terminal();
  const answer = editor({ message: 'Safe notes', default: 'seed' }, io);
  const rejection = assert.rejects(answer, PromptCancelled);
  await new Promise(resolve => setTimeout(resolve, 120));
  io.input.write('\x1b');
  await rejection;
  assert.equal(fs.existsSync(marker), false);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('explicit waitForUserInput false launches the fake editor automatically', async t => {
  const marker = fakeEditor(t);
  const io = terminal();
  assert.equal(await editor({ message: 'Automatic test draft', default: 'auto', waitForUserInput: false }, io), 'auto\nedited');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'auto');
});
