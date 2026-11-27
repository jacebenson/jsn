// Credential bookkeeping and refresh coalescing (#620).
//
// Every successful SDK request used to load and save the credential just to
// stamp last_seen, and concurrent expired-token requests each POSTed
// /oauth_token.do. Both are counted here with an injected store and a fixture
// transport — no keyring, no instance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../src/auth.js';

const instance = 'https://example.service-now.com';
const key = (user) => `${instance}|${user ?? ''}`;

function countingStore(seed = {}) {
  const state = new Map(Object.entries(seed));
  const calls = { load: 0, save: 0, delete: 0 };
  return {
    calls, state,
    store: {
      load: (target, username) => {
        calls.load++;
        const value = state.get(`${target}|${username ?? ''}`);
        return value ? structuredClone(value) : null;
      },
      save: (target, creds, username) => {
        calls.save++;
        state.set(`${target}|${username ?? ''}`, structuredClone(creds));
      },
      delete: (target, username) => {
        calls.delete++;
        state.delete(`${target}|${username ?? ''}`);
      },
    },
  };
}

const managerFor = (store, options = {}) => new AuthManager({ getUsername: () => 'fixture' }, { credentialStore: store, ...options });

test('last_seen bookkeeping is coalesced per identity', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { calls, store } = countingStore({ [key('fixture')]: { auth_method: 'basic', username: 'fixture', password: 'p', last_seen: 1 } });
  const auth = managerFor(store);

  auth.touchLastSeen(instance);
  assert.deepEqual({ load: calls.load, save: calls.save }, { load: 1, save: 1 }, 'the first stamp persists');

  // Nine more successful requests inside the window cost nothing.
  for (let i = 0; i < 9; i++) auth.touchLastSeen(instance);
  assert.deepEqual({ load: calls.load, save: calls.save }, { load: 1, save: 1 });

  // Past the window, exactly one more load and save.
  t.mock.timers.tick(301_000);
  auth.touchLastSeen(instance);
  assert.deepEqual({ load: calls.load, save: calls.save }, { load: 2, save: 2 });
});

test('an already-fresh last_seen is not rewritten', () => {
  const now = Math.floor(Date.now() / 1000);
  const { calls, store } = countingStore({ [key('fixture')]: { auth_method: 'basic', username: 'fixture', password: 'p', last_seen: now } });
  const auth = managerFor(store);
  auth.touchLastSeen(instance);
  assert.deepEqual({ load: calls.load, save: calls.save }, { load: 1, save: 0 });
});

test('concurrent expired-token requests share one refresh', async (t) => {
  const expired = { auth_method: 'oauth', access_token: 'old', refresh_token: 'r1', expires_at: 1, last_seen: 1 };
  const { calls, store } = countingStore({ [key('fixture')]: expired });
  const auth = managerFor(store);

  let fetches = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    // Give the other callers time to arrive while this refresh is in flight.
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }) };
  };
  t.after(() => { globalThis.fetch = saved; });

  const results = await Promise.all(Array.from({ length: 6 }, () => auth.getCredentialsFor(instance, 'fixture')));
  assert.equal(fetches, 1, 'six expired reads must trigger one token endpoint call');
  assert.equal(calls.save, 1, 'one refreshed credential is persisted');
  for (const result of results) assert.equal(result.access_token, 'new');
});

test('a failed refresh is not cached and is retried by the next caller', async (t) => {
  const { store } = countingStore({ [key('fixture')]: { auth_method: 'oauth', access_token: 'old', refresh_token: 'r1', expires_at: 1 } });
  const auth = managerFor(store);
  const saved = globalThis.fetch;

  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: false, status: 400, text: async () => 'nope' }; };
  t.after(() => { globalThis.fetch = saved; });

  await assert.rejects(auth.getCredentialsFor(instance, 'fixture'), /Token refresh failed/);
  await assert.rejects(auth.getCredentialsFor(instance, 'fixture'), /Token refresh failed/);
  assert.equal(fetches, 2, 'each attempt retries instead of reusing a rejected promise');
});

test('logout invalidates the bookkeeping so a later login stamps again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { calls, state, store } = countingStore({ [key('fixture')]: { auth_method: 'basic', username: 'fixture', password: 'p', last_seen: 1 } });
  const auth = managerFor(store);

  auth.touchLastSeen(instance);
  assert.equal(calls.save, 1);
  auth.logout(instance, 'fixture');
  assert.equal(state.has(key('fixture')), false);

  // Re-login inside the same coalescing window must still persist last_seen.
  state.set(key('fixture'), { auth_method: 'basic', username: 'fixture', password: 'p', last_seen: 1 });
  auth.touchLastSeen(instance);
  assert.equal(calls.save, 2);
});

test('bookkeeping never creates a credential that does not exist', () => {
  // Read-only profiles and logged-out identities reach the same path: a
  // successful call must not be able to conjure a stored credential.
  const { calls, state, store } = countingStore();
  const auth = managerFor(store);
  auth.touchLastSeen(instance);
  assert.deepEqual({ load: calls.load, save: calls.save }, { load: 1, save: 0 });
  assert.equal(state.size, 0);
});
