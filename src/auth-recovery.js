import { errAPI, errAuth } from './errors.js';
import { canUsePicker, quoteShellArg } from './helpers.js';
import { confirm } from './prompts.js';

// Recovery is scoped to the SDK's resolved identity, never the mutable default.
// error supplies the same safe guidance if the single retry is also rejected.
export function createAuthRecovery({ app, session, argv = () => app._authArgv || {},
  canInteract = canUsePicker, prompt = confirm,
  renewBrowser = async (request, targetApp) => {
    const { refreshProfile } = await import('./commands/auth.js');
    return refreshProfile(request, targetApp);
  },
}) {
  const { instance, profileName, username, profile } = session;
  const target = profileName ? `--profile ${quoteShellArg(profileName)}` : quoteShellArg(instance);
  const label = profileName ? `profile ${quoteShellArg(profileName)}` : 'the active profile';
  function failure(method = profile?.auth_method) {
    const error = errAPI(401, '');
    const login = `jsn auth login ${target}`;
    error.message = `Authentication rejected for ${label} (HTTP 401).`;
    error.profile = profileName || null;
    error.recovery = method === 'basic'
      ? `jsn auth login --basic ${quoteShellArg(instance)}${profileName ? ` --profile ${quoteShellArg(profileName)}` : ''}`
      : method === 'gck' ? `jsn auth refresh ${target} --browser`
      : method === 'oauth' ? `jsn auth refresh ${target}` : login;
    error.hint = method === 'basic'
      ? `Set SN_USERNAME/SN_PASSWORD to the correct credentials, then run: ${error.recovery}`
      : method === 'oauth'
        ? `Run interactively: ${error.recovery}. If refresh fails, run: ${login}`
        : `Run: ${error.recovery}`;
    return error;
  }
  // Keep the settled promise too: this provider gets only one recovery attempt.
  let recoveryAttempt;
  const provider = {
    error: failure(),
    credentialError(cause) {
      // Local validation can fail before any HTTP response. Keep its precise
      // reason, but target recovery to this invocation rather than the default.
      const error = errAuth(`${cause.message} (${label}).`);
      error.profile = profileName || null;
      error.recovery = `jsn auth login ${target}`;
      error.hint = `Run: ${error.recovery}`;
      return error;
    },
    async recover({ status }) {
      if (status !== 401) return false;
      return recoveryAttempt ??= recoverOnce();
    },
  };
  async function recoverOnce() {
    let creds;
    try {
      creds = await app.auth.getCredentialsFor(instance, username, {
        username, authMethod: profile?.auth_method, refresh: false,
      });
    } catch { throw provider.error; }
    const method = profile?.auth_method || creds.auth_method;
    provider.error = failure(method);
    if (method === 'oauth' && creds.refresh_token) {
      try {
        await app.auth.refreshToken(instance, creds, username ?? null);
        return true;
      } catch { throw provider.error; }
    }
    if (method === 'gck' && profileName && ['auto', 'confirm'].includes(profile?.reauth ?? 'confirm')
      && canInteract(app, argv())) {
      try {
        if ((profile?.reauth ?? 'confirm') === 'confirm'
          && !await prompt({ message: `Sign in again in a browser for ${label}?`, default: false })) throw provider.error;
        // Reuse the canonical GCK refresh/login operation without emitting a
        // second success envelope or replacing the in-flight command's SDK.
        const targetApp = Object.create(app);
        targetApp.ok = () => {};
        targetApp.sdk = app.getSDKForProfile(instance, { profile, authMethod: 'gck', username });
        await renewBrowser({ profile: profileName, browser: true }, targetApp);
        return true;
      } catch { throw provider.error; }
    }
    throw provider.error;
  }
  return provider;
}
