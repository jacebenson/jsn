// `jsn auth refresh` writes a new token, so it must not reach the token endpoint
// on a host that cannot store the result. Login already behaves this way; the
// refresh path used to fail later, at the save.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('refresh refuses before contacting the token endpoint when storage is unusable', async (t) => {
  const storageError = Object.assign(new Error('Secure credential storage is not usable on this host.'), {
    code: 'auth_error', hint: 'Repair: sudo apt-get install -y libsecret-tools gnome-keyring',
  });
  const { AppError, CodeAuth } = await import('../src/errors.js');

  // Replace the preflight with a refusal and count the network paths.
  t.mock.module('../src/auth/credential-storage-setup.js', {
    namedExports: {
      ensureCredentialStorage: async () => { throw new AppError(CodeAuth, storageError.message, storageError.hint); },
    },
  });
  t.after(() => t.mock.reset());

  const { refreshProfile } = await import('../src/commands/auth.js');

  let gotCredentials = 0;
  let tokenPosts = 0;
  const app = {
    config: {
      defaultProfile: 'fixture',
      profiles: { fixture: { instance_url: 'https://example.service-now.com', auth_method: 'oauth', username: 'fixture' } },
    },
    auth: {
      getCredentialsFor: async () => { gotCredentials++; return { auth_method: 'oauth', refresh_token: 'r1' }; },
      refreshToken: async () => { tokenPosts++; return {}; },
    },
  };

  await assert.rejects(
    refreshProfile({ profile: 'fixture' }, app),
    error => {
      assert.equal(error.code, 'auth_error');
      assert.match(error.hint, /libsecret-tools/);
      return true;
    },
  );
  assert.equal(gotCredentials, 0, 'no credential read before the storage decision');
  assert.equal(tokenPosts, 0, 'no token request before the storage decision');
});
