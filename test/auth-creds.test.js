import { describe, it, before } from 'node:test';
import assert from 'node:assert';

/**
 * Each test gets its own instance URL so keyring entries never collide.
 * secret-tool is available on this system and doesn't respect XDG_CONFIG_HOME.
 */
let testCounter = 0;
function uniqueInstance() {
  testCounter++;
  return `https://jsn-test-${testCounter}-${Date.now()}.service-now.com`;
}

describe('saveCredentials / loadCredentials — round-trips', () => {
  let auth;

  before(async () => {
    auth = await import('../src/auth.js');
  });

  it('save then load under bare key (no username)', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'admin', password: 'sekret',
    });

    const loaded = auth.loadCredentials(inst);
    assert.ok(loaded, 'should load saved creds');
    assert.strictEqual(loaded.auth_method, 'basic');
    assert.strictEqual(loaded.username, 'admin');
    assert.strictEqual(loaded.password, 'sekret');
    assert.ok(loaded.last_seen, 'should have last_seen timestamp');
    assert.ok(loaded.auth_source, 'should have auth_source');

    auth.deleteCredentials(inst);
  });

  it('save under compound key, load with correct username', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'alice', password: 'a-pass',
    }, 'alice');

    const withUser = auth.loadCredentials(inst, 'alice');
    assert.ok(withUser, 'should find compound-key creds');
    assert.strictEqual(withUser.username, 'alice');

    // Bare key should NOT have it
    const bare = auth.loadCredentials(inst);
    assert.strictEqual(bare, null, 'bare key should not resolve compound creds');

    auth.deleteCredentials(inst, 'alice');
  });

  it('isolates different users on the same instance', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'alice', password: 'a-pass',
    }, 'alice');
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'bob', password: 'b-pass',
    }, 'bob');

    const alice = auth.loadCredentials(inst, 'alice');
    const bob = auth.loadCredentials(inst, 'bob');
    assert.ok(alice);
    assert.ok(bob);
    assert.strictEqual(alice.password, 'a-pass');
    assert.strictEqual(bob.password, 'b-pass');

    auth.deleteCredentials(inst, 'alice');
    auth.deleteCredentials(inst, 'bob');
  });

  it('returns a copy, not the stored object directly', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'admin', password: 'x',
    });

    const first = auth.loadCredentials(inst);
    const second = auth.loadCredentials(inst);
    assert.notStrictEqual(first, second);
    assert.deepStrictEqual(first, second);

    auth.deleteCredentials(inst);
  });

  it('returns null for unknown instance', () => {
    const loaded = auth.loadCredentials('https://nope.service-now.com');
    assert.strictEqual(loaded, null);
  });

  it('loadCredentials without username does not find compound-keyed creds', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'oauth', access_token: 'compound-only',
    }, 'admin');

    // Without username: should not find the compound key
    assert.strictEqual(
      auth.loadCredentials(inst),
      null,
      'bare key should not resolve compound-keyed creds'
    );

    // With username: should find it
    assert.ok(auth.loadCredentials(inst, 'admin'));

    auth.deleteCredentials(inst, 'admin');
  });
});

describe('deleteCredentials', () => {
  let auth;

  before(async () => {
    auth = await import('../src/auth.js');
  });

  it('deletes bare-key creds', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'admin', password: 'x',
    });
    assert.ok(auth.loadCredentials(inst));

    auth.deleteCredentials(inst);
    assert.strictEqual(auth.loadCredentials(inst), null);
  });

  it('deletes compound-key creds', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'charlie', password: 'x',
    }, 'charlie');
    assert.ok(auth.loadCredentials(inst, 'charlie'));

    auth.deleteCredentials(inst, 'charlie');
    assert.strictEqual(auth.loadCredentials(inst, 'charlie'), null);
  });

  it('delete without username does not affect compound-keyed creds', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'basic', username: 'dave', password: 'x',
    }, 'dave');
    assert.ok(auth.loadCredentials(inst, 'dave'));

    // Delete bare key only — compound key should survive
    auth.deleteCredentials(inst);
    assert.ok(auth.loadCredentials(inst, 'dave'));

    auth.deleteCredentials(inst, 'dave');
  });
});

describe('hasLegacyCredentials', () => {
  let auth;

  before(async () => {
    auth = await import('../src/auth.js');
  });

  it('returns false when no credentials exist', () => {
    const { AuthManager } = auth;
    const mgr = new AuthManager({
      config: { profiles: {}, activeProfile: null, defaultProfile: null },
      getEffectiveInstance() { return ''; },
    });
    assert.strictEqual(mgr.hasLegacyCredentials('https://dev328604.service-now.com'), false);
  });

  it('returns false when bare key has creds but profile has no username', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'oauth', access_token: 'tok',
    });

    const { AuthManager } = auth;
    const mgr = new AuthManager({
      config: {
        profiles: { dev: { instance_url: inst } },
        activeProfile: 'dev', defaultProfile: 'dev',
      },
      getEffectiveInstance() { return inst; },
    });
    assert.strictEqual(mgr.hasLegacyCredentials(inst), false);

    auth.deleteCredentials(inst);
  });

  it('returns true when bare key has creds but profile has username', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'oauth', access_token: 'old-tok',
    });

    const { AuthManager } = auth;
    const mgr = new AuthManager({
      config: {
        profiles: { dev: { instance_url: inst, username: 'admin' } },
        activeProfile: 'dev', defaultProfile: 'dev',
      },
      getEffectiveInstance() { return inst; },
    });
    assert.strictEqual(mgr.hasLegacyCredentials(inst), true);

    auth.deleteCredentials(inst);
  });

  it('returns false after migration (re-save under compound + delete bare)', () => {
    const inst = uniqueInstance();
    auth.saveCredentials(inst, {
      auth_method: 'oauth', access_token: 'old-tok',
    });
    auth.saveCredentials(inst, {
      auth_method: 'oauth', access_token: 'old-tok', username: 'admin',
    }, 'admin');
    auth.deleteCredentials(inst); // remove bare key

    const { AuthManager } = auth;
    const mgr = new AuthManager({
      config: {
        profiles: { dev: { instance_url: inst, username: 'admin' } },
        activeProfile: 'dev', defaultProfile: 'dev',
      },
      getEffectiveInstance() { return inst; },
    });
    assert.strictEqual(mgr.hasLegacyCredentials(inst), false);

    auth.deleteCredentials(inst, 'admin');
  });
});
