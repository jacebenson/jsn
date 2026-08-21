// Session resolver unit tests — src/session.js
//
// The session answers one question: "which instance am I talking to, as
// whom, with what profile flags?" Precedence (observable behavior, pinned
// by these tests):
//
//   --instance flag  >  --profile reference  >  active profile  >
//   default profile  >  legacy bare instanceURL
//
// resolveSession is pure: it never mutates cfg and never touches argv.
// applySession is the only place cfg.activeProfile / app._overrideInstance
// change, and it's invoked from exactly one middleware in cli.js.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveSession, applySession, refreshSession } from '../src/session.js';
import { App } from '../src/app.js';
import { createConfig } from '../src/config.js';

const DEV = 'https://dev.service-now.com';
const PROD = 'https://prod.service-now.com';

function cfgWith(overrides = {}) {
  return {
    ...createConfig(),
    ...overrides,
  };
}

function twoProfileCfg() {
  return cfgWith({
    profiles: {
      dev: { instance_url: DEV, username: 'admin', read_only: true },
      prod: { instance_url: PROD, domain: 'abc123' },
    },
    defaultProfile: 'dev',
    activeProfile: 'dev',
  });
}

describe('resolveSession — precedence matrix', () => {
  it('resolves from the active profile by default', () => {
    const s = resolveSession({}, twoProfileCfg());
    assert.strictEqual(s.instance, DEV);
    assert.strictEqual(s.profileName, 'dev');
    assert.strictEqual(s.profile.instance_url, DEV);
    assert.strictEqual(s.username, 'admin');
    assert.strictEqual(s.readOnly, true);
    assert.strictEqual(s.domain, '');
    assert.strictEqual(s.override, null);
    assert.strictEqual(s.profileExplicit, false);
    assert.strictEqual(s.unknownProfile, null);
  });

  it('falls back to defaultProfile when activeProfile is empty', () => {
    const cfg = twoProfileCfg();
    cfg.activeProfile = '';
    const s = resolveSession({}, cfg);
    assert.strictEqual(s.instance, DEV);
    assert.strictEqual(s.profileName, 'dev');
  });

  it('falls back to legacy bare instanceURL when no profiles exist', () => {
    const s = resolveSession({}, cfgWith({ instanceURL: 'https://legacy.service-now.com' }));
    assert.strictEqual(s.instance, 'https://legacy.service-now.com');
    assert.strictEqual(s.profileName, null);
    assert.strictEqual(s.profile, null);
    assert.strictEqual(s.username, null);
    assert.strictEqual(s.readOnly, false);
  });

  it('returns an empty session when nothing is configured', () => {
    const s = resolveSession({}, cfgWith());
    assert.strictEqual(s.instance, '');
    assert.strictEqual(s.profileName, null);
    assert.strictEqual(s.domain, '');
  });

  it('--profile selects that profile (name, instance, username, flags)', () => {
    const s = resolveSession({ profile: 'prod' }, twoProfileCfg());
    assert.strictEqual(s.profileName, 'prod');
    assert.strictEqual(s.instance, PROD);
    assert.strictEqual(s.username, null);
    assert.strictEqual(s.domain, 'abc123');
    assert.strictEqual(s.readOnly, false);
    assert.strictEqual(s.profileExplicit, true);
    // cfg is untouched — mutation happens in applySession, not here
  });

  it('--profile does NOT mutate cfg.activeProfile', () => {
    const cfg = twoProfileCfg();
    resolveSession({ profile: 'prod' }, cfg);
    assert.strictEqual(cfg.activeProfile, 'dev');
  });

  it('--instance beats --profile beats active profile', () => {
    const cfg = twoProfileCfg();
    const s = resolveSession({ instance: 'https://override.service-now.com', profile: 'prod' }, cfg);
    assert.strictEqual(s.instance, 'https://override.service-now.com');
    // The profile still resolves (flags/domain track the referenced profile)
    assert.strictEqual(s.profileName, 'prod');
    assert.strictEqual(s.override, 'https://override.service-now.com');
  });

  it('--instance normalizes bare hosts (adds https://, strips trailing slash)', () => {
    const s = resolveSession({ instance: 'dev99999.service-now.com/' }, cfgWith());
    assert.strictEqual(s.instance, 'https://dev99999.service-now.com');
  });

  it('--instance alone leaves the active profile intact', () => {
    const s = resolveSession({ instance: PROD }, twoProfileCfg());
    assert.strictEqual(s.instance, PROD);
    assert.strictEqual(s.profileName, 'dev');
    assert.strictEqual(s.profileExplicit, false);
  });

  it('unknown --profile is surfaced as data, not thrown (cli.js renders the guard)', () => {
    const s = resolveSession({ profile: 'nope' }, twoProfileCfg());
    assert.strictEqual(s.unknownProfile, 'nope');
    // Instance falls through to the active profile — the guard exits before
    // this is ever used, and defensive callers see a coherent session.
    assert.strictEqual(s.instance, DEV);
  });

  it('env-loaded instanceURL flows through config (loadConfig owns env precedence)', () => {
    const s = resolveSession({}, cfgWith({ instanceURL: 'https://env.service-now.com', sources: { instance_url: 'env' } }));
    assert.strictEqual(s.instance, 'https://env.service-now.com');
  });

  it('read_only surfaces true ONLY for explicit true', () => {
    const cfg = twoProfileCfg();
    cfg.profiles.dev.read_only = 1; // truthy but not the armed boolean
    const s = resolveSession({}, cfg);
    assert.strictEqual(s.readOnly, false);
  });
});

describe('applySession — the single mutation point', () => {
  it('--profile switches cfg.activeProfile so downstream auth/context see it', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    const s = resolveSession({ profile: 'prod' }, cfg);
    applySession(app, s);
    assert.strictEqual(cfg.activeProfile, 'prod');
    assert.strictEqual(app._overrideInstance, PROD);
    assert.strictEqual(app.getEffectiveInstance(), PROD);
    assert.strictEqual(app.session.profileName, 'prod');
  });

  it('--instance pokes the override without touching cfg.activeProfile', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    const s = resolveSession({ instance: 'https://other.service-now.com' }, cfg);
    applySession(app, s);
    assert.strictEqual(cfg.activeProfile, 'dev');
    assert.strictEqual(app._overrideInstance, 'https://other.service-now.com');
    assert.strictEqual(app.getEffectiveInstance(), 'https://other.service-now.com');
  });

  it('no flags: override stays null, config-sourced instance is used', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    applySession(app, resolveSession({}, cfg));
    assert.strictEqual(app._overrideInstance, null);
    assert.strictEqual(app.getEffectiveInstance(), DEV);
  });

  it('rebuilds the SDK client against the override instance', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    assert.strictEqual(app.sdk.baseURL, DEV);
    applySession(app, resolveSession({ instance: PROD }, cfg));
    assert.strictEqual(app.sdk.baseURL, PROD);
  });

  it('accepts a bare argv shape ({ instance, profile }) too', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    applySession(app, { profile: 'prod' });
    assert.strictEqual(cfg.activeProfile, 'prod');
    assert.strictEqual(app.getEffectiveInstance(), PROD);
  });
});

describe('refreshSession — config edits re-resolve', () => {
  it('picks up a new active profile without an explicit override', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    cfg.activeProfile = 'prod';
    cfg.profiles.prod.username = 'root';
    const s = refreshSession(app);
    assert.strictEqual(s.profileName, 'prod');
    assert.strictEqual(app.context.profileName, 'prod');
    assert.strictEqual(app.context.username, 'root');
  });

  it('an explicit --profile override pins the session across refreshes', () => {
    const cfg = twoProfileCfg();
    const app = new App(cfg);
    applySession(app, resolveSession({ profile: 'prod' }, cfg));
    cfg.profiles.prod.domain = 'changed';
    const s = refreshSession(app);
    assert.strictEqual(s.profileName, 'prod');
    assert.strictEqual(s.domain, 'changed');
  });
});

describe('requireInstance (session-backed)', () => {
  it('throws the usage error when no instance resolves', () => {
    const app = new App(cfgWith());
    assert.throws(() => app.requireInstance(), /Instance URL required/);
  });

  it('passes when any source resolves an instance', () => {
    const app = new App(cfgWith({ instanceURL: DEV }));
    assert.doesNotThrow(() => app.requireInstance());
  });
});
