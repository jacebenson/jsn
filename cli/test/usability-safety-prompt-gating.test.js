// Audit #7 (+ raw-payload echo): prompt gates must consult canPrompt()
// (agent markers, CI, JSN_NO_PROMPTS, both stdio descriptors) and machine
// output (`--json`/`--quiet`/`--get`), and a missing target in
// non-interactive mode must fail with a structured usage error instead of
// silently succeeding or writing config.
//
// Reproduction (pre-fix): with synthetic TTYs + JSN_NO_PROMPTS=1,
// canPrompt() was false while App.isInteractive() returned true, so
// `jsn auth login`, `jsn skill install` and `jsn perf show` could still
// reach a picker; `jsn auth switch` with several profiles silently switched
// the active profile; `jsn perf show` exited 0 with no output.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { canPrompt, canUsePicker, parseDataArg } = await import('../src/helpers.js');
const { App } = await import('../src/app.js');
const { FormatAuto, FormatJSON } = await import('../src/output.js');
const { perfCmd } = await import('../src/commands/perf.js');
const { authCmd } = await import('../src/commands/auth.js');

// ─── env + TTY harness ───

const MARKER_KEYS = ['JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'TERM',
  'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT'];

let savedEnv;
let savedTTY;

function clearMarkers() {
  for (const key of MARKER_KEYS) delete process.env[key];
}

function setTTY(value) {
  process.stdout.isTTY = value;
  process.stdin.isTTY = value;
}

before(() => {
  savedEnv = { ...process.env };
  savedTTY = { out: process.stdout.isTTY, in: process.stdin.isTTY };
});

after(() => {
  process.env = { ...savedEnv };
  process.stdout.isTTY = savedTTY.out;
  process.stdin.isTTY = savedTTY.in;
});

function fakeApp(format = FormatAuto) {
  return { output: { getFormat: () => format } };
}

// ─── canUsePicker ───

describe('canUsePicker', () => {
  it('is true only in a plain human TTY', () => {
    clearMarkers();
    setTTY(true);
    assert.equal(canUsePicker(fakeApp(FormatAuto), {}), true);
  });

  it('is false when prompts are disabled even with both TTYs', () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';
    assert.equal(canPrompt(), false);
    assert.equal(canUsePicker(fakeApp(FormatAuto), {}), false);
  });

  it('is false for agent/CI markers even with both TTYs', () => {
    clearMarkers();
    setTTY(true);
    for (const marker of ['CI', 'CLAUDE_CODE', 'GITHUB_ACTIONS']) {
      process.env[marker] = marker === 'CI' || marker === 'GITHUB_ACTIONS' ? 'true' : '1';
      assert.equal(canUsePicker(fakeApp(FormatAuto), {}), false, marker);
      delete process.env[marker];
    }
  });

  it('is false when stdout is redirected even if stdin is a TTY', () => {
    clearMarkers();
    process.stdout.isTTY = false;
    process.stdin.isTTY = true;
    assert.equal(canUsePicker(fakeApp(FormatAuto), {}), false);
  });

  it('is false for explicit machine output and for --get extraction', () => {
    clearMarkers();
    setTTY(true);
    assert.equal(canUsePicker(fakeApp(FormatJSON), {}), false);
    assert.equal(canUsePicker(fakeApp(FormatAuto), { get: 'data.records' }), false);
  });
});

// ─── App.isInteractive ───

describe('App.isInteractive shares the canPrompt gate', () => {
  it('is false for an agent PTY with prompts disabled', async () => {
    clearMarkers();
    setTTY(true);
    const app = new App({ instanceURL: '', profiles: {}, activeProfile: '' });
    assert.equal(app.isInteractive(), true, 'plain TTY is interactive');
    process.env.JSN_NO_PROMPTS = '1';
    assert.equal(app.isInteractive(), false, 'agent PTY is not interactive');
  });
});

// ─── auth ───

function authSubcommands() {
  const wrap = (fn) => async (argv) => fn(argv, argv.app);
  const subs = [];
  const mockYargs = {
    command: (c, ...rest) => {
      subs.push({
        def: typeof c === 'string' ? c : c.command,
        builder: typeof c === 'object' ? c.builder : rest[0],
        handler: typeof c === 'object' ? c.handler : rest[1],
      });
      return mockYargs;
    },
  };
  authCmd(wrap).builder(mockYargs);
  return subs;
}

function authSub(name) {
  const found = authSubcommands().find(s => s.def.startsWith(name));
  assert.ok(found, `auth ${name} not registered`);
  return found;
}

describe('auth refuses to guess without a prompt', () => {
  it('switch with several profiles fails instead of silently switching', async () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';
    const app = {
      config: {
        profiles: {
          dev: { instance_url: 'https://dev.service-now.com' },
          prod: { instance_url: 'https://prod.service-now.com' },
        },
        activeProfile: 'dev',
        defaultProfile: 'dev',
      },
      output: fakeApp(FormatAuto).output,
      ok() { throw new Error('switch must not report success'); },
    };

    await assert.rejects(
      () => authSub('switch').handler({ app, _: ['switch'] }),
      (err) => {
        assert.equal(err.code, 'usage_error');
        assert.match(err.message, /Which profile\? 2 profiles are configured: dev, prod/);
        assert.match(err.hint, /jsn auth switch <name>/);
        return true;
      }
    );
    assert.equal(app.config.activeProfile, 'dev', 'no config write on the failure path');
  });

  it('switch with a single profile still works without a prompt', async () => {
    clearMarkers();
    process.env.JSN_NO_PROMPTS = '1';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-usability-auth-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const app = {
        config: {
          profiles: { solo: { instance_url: 'https://solo.service-now.com' } },
          activeProfile: 'solo',
          defaultProfile: 'solo',
        },
        ok() {},
      };
      await authSub('switch').handler({ app, _: ['switch'] });
      assert.equal(app.config.activeProfile, 'solo');
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('login with no instance and no profiles is a usage error with no side effect', async () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';
    const app = {
      config: { profiles: {} },
      output: fakeApp(FormatAuto).output,
      auth: { login: async () => { throw new Error('must not attempt a login'); } },
      ok() { throw new Error('must not report success'); },
    };

    await assert.rejects(
      () => authSub('login').handler({ app, _: ['auth', 'login'] }),
      /Instance URL required/
    );
    assert.deepEqual(app.config.profiles, {}, 'no profile may be created');
  });
});

// ─── perf ───

function perfCommand(name) {
  const commands = [];
  const yargs = { command(definition) { commands.push(definition); return this; }, option() { return this; } };
  perfCmd(fn => fn).builder(yargs);
  const found = commands.find(c => c.command === name);
  assert.ok(found, `perf ${name} not registered`);
  return found;
}

function perfApp() {
  const shown = [];
  return {
    app: {
      output: fakeApp(FormatAuto).output,
      ok(data, opts) { shown.push({ data, opts }); },
      requireInstance() {},
      getEffectiveInstance: () => 'https://dev.example',
      session: { profileName: 'admin' },
    },
    shown,
  };
}

describe('perf fails loudly when a run ID is required', () => {
  it('show without a run ID reports a usage error instead of exiting silently', async () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';
    const { app, shown } = perfApp();

    await assert.rejects(
      () => perfCommand('show [run_id]').handler({ _: ['perf', 'show'] }, app),
      (err) => {
        assert.equal(err.code, 'usage_error');
        assert.match(err.message, /Missing run ID/);
        return true;
      }
    );
    assert.equal(shown.length, 0, 'no success envelope may be emitted');
  });

  it('compare without run IDs reports a usage error instead of exiting silently', async () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';
    const { app, shown } = perfApp();

    await assert.rejects(
      () => perfCommand('compare [baseline] [new]').handler({ _: ['perf', 'compare'] }, app),
      /Compare requires exactly two run IDs/
    );
    assert.equal(shown.length, 0);
  });

  it('--json suppresses the picker too', async () => {
    clearMarkers();
    setTTY(true);
    const { app } = perfApp();
    app.output = { getFormat: () => FormatJSON };

    await assert.rejects(
      () => perfCommand('show [run_id]').handler({ _: ['perf', 'show'], json: true }, app),
      /Missing run ID/
    );
  });
});

// ─── skill install ───

describe('skill install honors the prompt gate', () => {
  it('never opens the picker with prompts disabled and installs to the documented default', async () => {
    clearMarkers();
    setTTY(true);
    process.env.JSN_NO_PROMPTS = '1';

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-usability-hermes-'));
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-usability-skillcfg-'));
    const prevBase = process.env.JSN_HERMES_BASE_DIR;
    const prevProfile = process.env.HERMES_PROFILE;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevFetch = globalThis.fetch;
    process.env.JSN_HERMES_BASE_DIR = base;
    process.env.HERMES_PROFILE = 'usability';
    process.env.XDG_CONFIG_HOME = configHome;

    let fetchCalls = 0;
    globalThis.fetch = async (url) => {
      fetchCalls += 1;
      assert.match(String(url), /SKILL\.md$/);
      return { ok: true, status: 200, text: async () => '# jsn skill\nversion: 9.9.9\n' };
    };

    try {
      const { skillCmd } = await import('../src/commands/skill.js');
      const subs = [];
      const mockYargs = {
        command(c) { subs.push(c); return mockYargs; },
        positional() { return mockYargs; },
        option() { return mockYargs; },
      };
      skillCmd(fn => fn).builder(mockYargs);
      const install = subs.find(s => (typeof s === 'string' ? s : s.command).startsWith('install'));
      assert.ok(install, 'skill install not registered');

      let result = null;
      const app = {
        output: fakeApp(FormatAuto).output,
        ok(data, opts) { result = { data, opts }; },
      };
      await install.handler({ _: ['skill', 'install'] }, app);

      assert.equal(fetchCalls, 1, 'the bundled/remote fetch is stubbed — no live network');
      assert.deepEqual(Object.keys(result.data.installed), ['Hermes Agent'],
        'a disabled picker must fall back to the single documented default target');
      const installedPath = result.data.installed['Hermes Agent'];
      assert.equal(fs.existsSync(installedPath), true, `expected ${installedPath} to exist`);
      assert.equal(path.resolve(installedPath).startsWith(path.resolve(base)), true,
        'installs stay inside the isolated hermes base dir');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevBase === undefined) delete process.env.JSN_HERMES_BASE_DIR; else process.env.JSN_HERMES_BASE_DIR = prevBase;
      if (prevProfile === undefined) delete process.env.HERMES_PROFILE; else process.env.HERMES_PROFILE = prevProfile;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });
});

// ─── parseDataArg payload echo ───

describe('parseDataArg never echoes the raw payload', () => {
  it('reports the parse failure without repeating the payload text', () => {
    const secret = '{"password": "super-secret-value", "oops": }';
    assert.throws(
      () => parseDataArg({ data: secret }),
      (err) => {
        assert.match(err.message, /Invalid JSON/);
        assert.doesNotMatch(err.message, /super-secret-value/);
        assert.doesNotMatch(err.message, /Raw value/);
        return true;
      }
    );
  });
});
