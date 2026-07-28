import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docsCmd } from '../src/commands/docs/docs.js';
import {
  tokenize, encodeText, phasesToBytes, bytesToPhases, similarity,
} from '../src/commands/docs/hrr.js';
import { getDocsDbPath, getDocsSourceDir, getDocsSourceMarkdownDir } from '../src/commands/docs/db.js';

function fakeWrap(handler) {
  return async (...args) => handler(...args);
}

describe('Docs Command', () => {
  it('should export docsCmd function', () => {
    assert.strictEqual(typeof docsCmd, 'function');
  });

  it('should define docs command with correct properties', () => {
    const cmd = docsCmd(fakeWrap);
    assert.strictEqual(cmd.command, 'docs [subcommand]');
    assert.strictEqual(typeof cmd.describe, 'string');
    assert.strictEqual(typeof cmd.builder, 'function');
    assert.strictEqual(typeof cmd.handler, 'function');
  });

  it('should define sync, status, search, serve, embed, refresh subcommands', () => {
    const cmd = docsCmd(fakeWrap);
    const yargs = {
      command: (c) => {
        yargs.commands.push(typeof c === 'function' ? c(fakeWrap) : c);
        return yargs;
      },
      commands: [],
    };
    cmd.builder(yargs);
    const names = yargs.commands.map((c) => c.command || c);
    assert.ok(names.some((n) => n.toString().startsWith('sync')));
    assert.ok(names.some((n) => n.toString().startsWith('status')));
    assert.ok(names.some((n) => n.toString().startsWith('search')));
    assert.ok(names.some((n) => n.toString().startsWith('serve')));
    assert.ok(names.some((n) => n.toString().startsWith('embed')));
    assert.ok(names.some((n) => n.toString().startsWith('refresh')));
  });
});

describe('Docs DB paths', () => {
  it('should resolve docs DB path under XDG cache home', () => {
    const dbPath = getDocsDbPath();
    assert.ok(dbPath.includes('servicenow-cli/docs/docs.db'));
  });

  it('should resolve source markdown dir under source dir', () => {
    const src = getDocsSourceDir();
    const md = getDocsSourceMarkdownDir();
    assert.ok(md.startsWith(src));
    assert.ok(md.endsWith('/markdown'));
  });
});

describe('HRR helpers', () => {
  it('should tokenize text', () => {
    assert.deepEqual(tokenize('Hello, world!'), ['hello', 'world']);
  });

  it('should encode text to a vector', () => {
    const vec = encodeText('hello world', 64);
    assert.strictEqual(vec.length, 64);
  });

  it('should round-trip packed phases', () => {
    const original = encodeText('test phrase', 128);
    const bytes = phasesToBytes(original);
    const restored = bytesToPhases(bytes);
    assert.strictEqual(restored.length, 128);
    const sim = similarity(original, restored);
    assert.ok(sim > 0.99, `round-trip similarity ${sim} should be > 0.99`);
  });
});
