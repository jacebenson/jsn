import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('App context', () => {
  it('exports App class', async () => {
    const { App } = await import('../src/app.js');
    assert.ok(App);
    assert.strictEqual(typeof App, 'function');
  });

  it('creates App with config', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.config, cfg);
    assert.ok(app.output);
    assert.ok(app.auth);
  });

  it('creates App without SDK when no instance', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.sdk, null);
  });

  it('requireInstance throws when no instance', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.throws(() => app.requireInstance(), /Instance URL required/);
  });

  it('requireInstance passes when instance is set', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.doesNotThrow(() => app.requireInstance());
  });

  it('requireAuth throws when not authenticated', async () => {
    const origToken = process.env.SERVICENOW_OAUTH_TOKEN;
    const origSnUser = process.env.SN_USERNAME;
    const origSnPass = process.env.SN_PASSWORD;
    delete process.env.SERVICENOW_OAUTH_TOKEN;
    delete process.env.SN_USERNAME;
    delete process.env.SN_PASSWORD;
    try {
      const { App } = await import('../src/app.js');
      const cfg = { instanceURL: 'https://test.service-now.com', profiles: {}, activeProfile: '' };
      const app = new App(cfg);
      assert.throws(() => app.requireAuth(), /Not authenticated/);
    } finally {
      if (origToken !== undefined) process.env.SERVICENOW_OAUTH_TOKEN = origToken;
      if (origSnUser !== undefined) process.env.SN_USERNAME = origSnUser;
      if (origSnPass !== undefined) process.env.SN_PASSWORD = origSnPass;
    }
  });

  it('isInteractive returns false for non-TTY', async () => {
    const { App } = await import('../src/app.js');
    const cfg = { instanceURL: '', profiles: {}, activeProfile: '' };
    const app = new App(cfg);
    assert.strictEqual(app.isInteractive(), false);
  });
});
