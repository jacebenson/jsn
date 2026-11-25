// --impersonate <user>: run one command as another user on a UI session
// private to this process. The session is driven by cookie and
// X-UserToken only (a per-request credential re-authenticates as the real
// user and silently undoes the switch), is never written to disk, is checked
// after the switch (the instance answers 201 even when it refused), and is
// reverted, logged out and confirmed gone on success, failure and Ctrl-C.
// A write runs only after a prompt naming the user or --impersonate-writes.
import { SDKClient } from './sdk.js';
import { AppError, CodeAPI, CodeUsage, CodeConfirmationRequired, errAuth, errAuthHint, errUsageHint, errNotFound } from './errors.js';
import { isMutationCommand } from './mutations.js';
import { needsMutationContext } from './mutation-context.js';
import { collectCapabilities } from './capabilities.js';
import { isSysId } from './resolve-record.js';
import { canUsePicker } from './helpers.js';
import { confirm } from './prompts.js';

const SESSION = '/api/now/sg/impersonation/session';
const IMPERSONATE = '/api/now/ui/impersonate/';
let open = false;
export const impersonating = () => open;

export function impersonationRefusal(argv, caps = collectCapabilities()) {
  const user = typeof argv.impersonate === 'string' ? argv.impersonate.trim() : '';
  if (!user) return 'name a user_name or sys_id to impersonate';
  if (/^-|[\^\p{Cc}]|javascript:/iu.test(user)) return `"${user}" is not a user_name or sys_id`;
  const cap = caps.get(argv._?.[0]) || {};
  if (cap.noInstance) return 'it manages local state rather than reading the instance';
  // Writes the context guard cannot place on an ordinary table count as customization, captured in that user's update set.
  if (needsMutationContext(argv) && cap.mutationContext !== 'table') return 'it may write customization, which would be captured in that user\'s update set';
  if (cap.noImpersonateSubcommands?.some(sub => sub === '' || sub === argv._?.[1])) return 'it would not run as that user: it reads through another profile or keeps running after the command returns';
  return null;
}

// Writing as another user is opt-in on top of the ordinary write guards.
export async function confirmImpersonatedWrite(app, argv, { interactive = canUsePicker(app, argv), ask = confirm } = {}) {
  if (!isMutationCommand(argv) || argv.impersonateWrites === true) return;
  const action = `"jsn ${argv._.join(' ')}" writes to the instance as ${argv.impersonate.trim()}`;
  if (interactive) {
    if (await ask({ message: `${action}. Continue?`, default: false })) return;
    throw new AppError(CodeUsage, 'Impersonated write cancelled. Nothing was sent.');
  }
  throw new AppError(CodeConfirmationRequired, `${action}: confirmation required. Pass --impersonate-writes only after your user approves writing as that user.`, 'Ask your user to approve this write as that user, then re-run the same command with --impersonate-writes. Nothing was sent.');
}

async function findUser(sdk, query, shown) {
  const rows = await sdk.listStrict('sys_user', { sysparm_query: query, sysparm_fields: 'sys_id,user_name', sysparm_limit: '2', sysparm_display_value: 'false' });
  if (!rows.length) throw errNotFound('user', shown);
  const [row] = rows;
  if (rows.length > 1 || !isSysId(row?.sys_id) || typeof row.user_name !== 'string' || !row.user_name) throw new AppError(CodeAPI, `Looking up "${shown}" in sys_user did not return exactly one usable user.`);
  return row;
}

export async function runImpersonated(app, name, command) {
  const creds = await app.sdk.authProvider.getCredentials();
  if (creds?.auth_method === 'gck') throw errUsageHint('--impersonate cannot use a browser-session profile: its cookies are your browser\'s own session.', 'Use a basic or OAuth profile: jsn --profile <name> ... --impersonate <user>');
  const real = app.sdk;
  const cookies = await real._warmSession();
  if (!cookies) throw errAuth('The profile could not open a UI session, which --impersonate runs on.');
  const session = new SDKClient(real.baseURL, { getCredentials: async () => ({ auth_method: 'gck', access_token: session.sessionUserToken, cookies }) }, { domain: real.domain, timeout: real.timeout, includeReferenceLinks: real.includeReferenceLinks });
  // Commands that warm a UI session of their own (update set export, background scripts) reuse this one.
  session.oauthCookies = cookies;
  session.sessionUserToken = real.sessionUserToken;
  const read = async () => {
    const body = await session.request(real.baseURL + SESSION, { readOnly: true });
    if (!body || typeof body.CurrentUser !== 'string' || !body.CurrentUser) throw new AppError(CodeAPI, 'The impersonation session endpoint did not name the current user.');
    if (body.SessionToken) session.sessionUserToken = body.SessionToken;
    return body;
  };
  let revert = null;
  let ending = null;
  const doEnd = async () => {
    // A failed revert still logs out; the read below decides whether the session ended.
    if (revert) await session.request(real.baseURL + IMPERSONATE + revert.sys_id, { method: 'POST', body: '{}' }).catch(() => {});
    const out = await fetch(real.baseURL + '/logout.do', { headers: { Cookie: cookies, 'X-UserToken': session.sessionUserToken }, redirect: 'manual' });
    await out.body?.cancel();
    let still;
    try { still = (await read()).CurrentUser; } catch (error) { if (error?.status === 401) return; throw error; }
    // shortcut: a session reverted but not logged out is accepted; it holds the real user and lapses at the idle timeout.
    if (revert && still.toLowerCase() === revert.user_name.toLowerCase()) return;
    throw new AppError(CodeAPI, `Could not end the impersonated session: it is still "${still}".`, 'Only this process held its cookies; it lapses at the instance idle timeout.');
  };
  const end = () => (ending ??= doEnd());
  const onSigint = () => end().catch(error => process.stderr.write(`Warning: ${error.message}\n`)).finally(() => process.exit(130));
  process.once('SIGINT', onSigint);
  open = true;
  try {
    try {
      const start = await read();
      if (start.CanImpersonate === false) throw errAuthHint(`"${start.CurrentUser}" cannot impersonate other users.`, 'Impersonation needs the admin or impersonator role.');
      const self = await findUser(session, `user_name=${start.CurrentUser}`, start.CurrentUser);
      const target = await findUser(session, `${isSysId(name) ? 'sys_id' : 'user_name'}=${name}`, name);
      revert = self;
      await session.request(real.baseURL + IMPERSONATE + target.sys_id, { method: 'POST', body: '{}' });
      const now = await read();
      if (now.CurrentUser.toLowerCase() !== target.user_name.toLowerCase() || String(now.OriginalUser).toLowerCase() !== self.user_name.toLowerCase()) {
        throw new AppError(CodeAPI, `Impersonation of "${target.user_name}" did not take effect: the instance accepted the request but the session is still "${now.CurrentUser}".`, 'Check the user is active and the caller holds the admin or impersonator role.');
      }
      app.sdk = session;
      await command();
    } catch (error) {
      await end().catch(cleanup => process.stderr.write(`Warning: ${cleanup.message}\n`));
      throw error;
    } finally {
      app.sdk = real;
    }
    await end();
  } finally {
    open = false;
    process.removeListener('SIGINT', onSigint);
  }
}
