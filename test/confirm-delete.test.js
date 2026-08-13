import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('confirmDelete', () => {
  let confirmDelete;

  const makeApp = (profile) => ({
    config: {
      activeProfile: 'test',
      defaultProfile: 'test',
      profiles: { test: profile || {} },
    },
  });

  it('allows when profile has skip_confirmations', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({ skip_confirmations: true }), {}, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('allows when --force is passed (no profile flag)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({}), { force: true }, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('rejects non-interactive deletes without --force (default ask)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete(makeApp({}), {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });

  it('rejects even when --force is absent but read_only is set (flags are independent)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete(makeApp({ read_only: true }), {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });

  it('allows when both flags are set', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({ skip_confirmations: true }), { force: true }, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('handles missing active profile gracefully (throws, does not crash)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete({ config: { profiles: {} } }, {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });
});

describe('canPrompt', () => {
  let canPrompt;
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.JSN_NO_PROMPTS;
    delete process.env.CI;
    delete process.env.NONINTERACTIVE;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.TERM;
    delete process.env.CLAUDE_CODE;
    delete process.env.GITHUB_COPILOT_AGENT;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('returns false when JSN_NO_PROMPTS=1', async () => {
    ({ canPrompt } = await import('../src/helpers.js'));
    process.env.JSN_NO_PROMPTS = '1';
    assert.strictEqual(canPrompt(), false);
  });

  it('returns false when CI=true even with a TTY', async () => {
    ({ canPrompt } = await import('../src/helpers.js'));
    process.env.CI = 'true';
    // Simulate agent PTY: streams report TTY but env says automation
    const origOut = process.stdout.isTTY;
    const origIn = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    try {
      assert.strictEqual(canPrompt(), false);
    } finally {
      process.stdout.isTTY = origOut;
      process.stdin.isTTY = origIn;
    }
  });

  it('returns false when a known agent marker is set (e.g. GITHUB_COPILOT_AGENT)', async () => {
    ({ canPrompt } = await import('../src/helpers.js'));
    process.env.GITHUB_COPILOT_AGENT = 'true';
    const origOut = process.stdout.isTTY;
    const origIn = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    try {
      assert.strictEqual(canPrompt(), false);
    } finally {
      process.stdout.isTTY = origOut;
      process.stdin.isTTY = origIn;
    }
  });

  it('returns true in a plain human TTY (no agent markers)', async () => {
    ({ canPrompt } = await import('../src/helpers.js'));
    const origOut = process.stdout.isTTY;
    const origIn = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    try {
      assert.strictEqual(canPrompt(), true);
    } finally {
      process.stdout.isTTY = origOut;
      process.stdin.isTTY = origIn;
    }
  });
});
