import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { authCmd } from '../src/commands/auth.js';
import { OutputWriter, FormatJSON } from '../src/output.js';

function app(format) {
  let text = '';
  const writer = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return {
    app: {
      output: new OutputWriter({ format, writer }),
      requireInstance: () => {},
      ok(data, opts) { this.output.ok(data, opts); },
      getEffectiveInstance: () => 'https://example.service-now.com',
    },
    text: () => text,
  };
}

const SURFACE = ['login', 'status', 'refresh', 'switch', 'modify', 'logout', 'remove'];

test('auth root lists every subcommand in a terminal', async () => {
  const { app: instance, text } = app('styled');
  await authCmd(fn => fn).handler({}, instance);
  const rendered = text();
  for (const name of SURFACE) assert.ok(rendered.includes(name), `terminal output is missing ${name}`);
  assert.match(rendered, /Available subcommands:/);
});

test('auth root keeps its structured list for scripts', async () => {
  const { app: instance, text } = app(FormatJSON);
  await authCmd(fn => fn).handler({}, instance);
  const envelope = JSON.parse(text());
  assert.deepEqual(envelope.data.commands, SURFACE);
  assert.equal(typeof envelope.data._formatted, 'string');
});
