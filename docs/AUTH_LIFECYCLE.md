# Authentication lifecycle review

This document records the issue #209 auth lifecycle contract. It describes the current implementation and the boundaries that regression tests must preserve.

## Profile identity is the credential boundary

A configured profile selects one instance URL, authentication method, and optional username. Credential store operations receive the selected instance and username explicitly:

- `<username>@<instance>` is the normal credential identity.
- A bare `<instance>` key is legacy/no-profile storage only.
- Logout and remove delete the selected username or the bare key only when the bare identity is unambiguous.
- Two named profiles may share an instance URL without sharing credentials.

Commands that target a named profile pass that profile's username through login, refresh, status, SDK construction, logout, and remove. An explicit profile selection is authoritative; it is not retargeted by the active profile or interactive picker.

Legacy bare credentials are reported as legacy when a username-scoped profile exists. They are not silently assigned to another profile. Migration occurs only after a successful login has verified the username, and the old bare entry is then removed by the AuthManager boundary.

## Authentication methods do not fall back

OAuth, Basic Auth, and GCK are separate methods:

- OAuth uses access/refresh tokens and is the only refreshable method.
- Basic Auth uses username/password credentials and does not consume OAuth or GCK credentials.
- GCK uses the browser session token and cookies and does not fall back to bearer-token environment credentials.

For an explicitly configured profile, the configured method is authoritative. Conflicting environment credentials and stored credentials are unavailable or rejected rather than used as an implicit fallback. Unconfigured, legacy usage retains the documented environment precedence for compatibility.

## Browser import verifies the selected account

`auth login --browser` is an experimental acquisition path for GCK credentials.
It normally launches a chosen installed Chromium-family browser with a fresh
temporary profile, assigns a loopback debugging port automatically, and waits
up to five minutes for login. Guest sessions do not complete login. Setup asks
for the installed browser choice without debugging details. The owned browser
and temporary directory are cleaned up on success, cancellation, and failure.
`--browser-url` connects to an existing browser as an advanced alternative.
The import selects
one exact-origin tab, and reads `g_ck` plus cookies applicable to the instance's
current-user API. Missing tokens, multiple matching tabs, and origin changes
fail before persistence. The account is verified with a bounded current-user
GET that rejects redirects. Import requires a returned username and rejects
an account that differs from an existing profile's username. Setup persists
the verified username, and reauthentication preserves profile safety settings.
Browser debugging responses and credentials are never printed.

## Diagnostics are read-only

`auth status` uses safe metadata and a read-only current-user probe. It does not refresh tokens, update `last_seen`, migrate credentials, or persist credentials. JSON diagnostics contain method, source, state, and probe classification only; access tokens, refresh tokens, passwords, cookies, and browser-session headers are never serialized.

The default human status is a compact table of profile, method, credentials,
connection, access, delete confirmations, and result counts. Usernames and
instance URLs require `--details` in all output formats. Without it, the JSON
omits `default_instance` and profile `instance`, `username`, and `verified_as`;
`--get` paths for these fields also require `--details`. The details table labels
the identity column **User**. The envelope and non-identity fields retain their
existing paths. Human status separates credential availability from live
verification and retains corrective commands without exposing identity fields.
`auth status --local` performs no instance request and reports its probe as
`not_attempted` / `not_requested`. A live account differing from the configured
username is reported as `account_mismatch`, never verified. Probe failures are
classified without returning provider response bodies.

New profiles created by direct `auth login` receive the same interactive
read-only, delete-confirmation, and result-count choices as setup. Explicit
flags bypass their corresponding questions. Noninteractive login provides
setting hints through output breadcrumbs. Reauthentication preserves settings
without repeating onboarding. Profile names and interactive choices pin the
credential identity even when multiple accounts share an instance URL.

## Setup and auth share operations

Setup only collects human answers and dispatches the same operations registered
under `auth`. Its wizard performs no independent profile or credential writes.
Basic username/password answers are passed in memory to AuthManager; OAuth uses
the same PKCE login/code-exchange path as direct login. Browser sign-in continues
through the shared GCK verification/store path. Domain discovery remains a
best-effort part of new interactive login.

`--name` creates a new named connection, including another user on the same
instance. Existing names are not overwritten by that flag. `--profile` and
named picker choices reconnect the selected identity. A new connection without
a known username explicitly selects the bare pending credential identity;
it does not inherit the previous default user's slot.

Defaults change only after explicit human confirmation, `--make-default`, or
`auth switch`. First-login scripts do not silently select a default. Read-only,
count, and confirmation flags set values rather than toggle them. The positive
`--confirm-deletes` flag is the inverse of the compatible `--skip-confirmations`;
conflicting values fail before saving.

Noninteractive OAuth requires `--print-url` / `--code` (or a wait file). Browser
launch requires explicit `--browser`; missing settings for `auth modify` produce
a structured usage error. OAuth progress goes to stderr, final results and auth
errors honor JSON mode, and a failed wait-file exchange fails promptly instead
of silently retrying. Explicit refresh suppresses automatic refresh during
credential lookup so it performs only one token refresh.

## Shared-instance and concurrent behavior

Credential records for different usernames on one instance are independent. Refresh and logout operate on the explicitly selected identity, so updating or deleting one username does not affect another.

Pending OAuth PKCE state is also identity-scoped when the profile username is known. This prevents two concurrent same-instance profile logins from overwriting each other's verifier/state. No-profile OAuth flows retain the bare instance slot because the username is not known until verification; those flows must not be treated as concurrent named-profile flows.

The focused auth tests cover same-instance username isolation, explicit refresh/logout identity, method separation, read-only diagnostics, legacy handling, redaction, and concurrent username-scoped PKCE state.

## Basic-auth TOTP challenges (#402)

Basic credentials can require TOTP even for Table, Stats and Batch calls. Those
normal SDK request paths therefore bootstrap Basic login **before** dispatching
the pending operation. OAuth/token and GCK retain the endpoint-based stateless
policy: Table/Stats/Batch do not warm a UI session, while processors and other
cookie-dependent surfaces still do. `JSN_ALWAYS_WARM_SESSION=1` remains available.
This deliberate Basic-only exception costs login round trips; it prevents a
mutation from being used as a probe for an unresolved MFA challenge. Internal
auth bootstrap bypasses recursion, not a recognized challenge's terminal state.

Only JSON `status: "mfa_code_required"` enters MFA. Bad credentials, ACL failures,
transport errors and unrecognized login bodies are not guessed to be MFA; the
pre-existing non-MFA Basic behavior remains. The MFA lifecycle is:

1. POST the username/password login form and retain the response cookies.
2. Ask for a masked six-digit authenticator code with shared Escape cancellation.
   Non-TTY, CI/agent, `--json`, and `--get` invocations fail with `mfa_required`
   and guidance instead. Authentication methods never switch automatically.
3. GET `/validate_multifactor_auth_code.do`, retaining rotated cookies and reading
   `sysparm_ck` and `sysparm_process_nonce`. POST these with the ephemeral code
   to `/validate_mfa_code.do` using cookies only. An explicit invalid-code header
   permits a fresh code, up to three entries. Unexpected responses are terminal.
4. A same-origin 302 to a non-login/non-expired destination is only a candidate,
   not authentication proof. POST cookie-only `get_user`; require HTTP success
   and `x-usertoken-response`, and reject guest/login responses. Then read the
   authenticated current `sys_user` with cookies plus that token and require an
   exact username match to the selected Basic credentials. Require cookies too.
5. Only then publish the session cookie/token pair and dispatch the pending
   operation. The existing session-generation, verified-recovery, and safe-replay
   rules remain unchanged; Basic has no automatic credential renewal.

Every network exchange in this challenge, including form and verification body
consumption, is independently bounded by the SDK client's timeout (30 seconds by
default) and an AbortController. The pending operation's timeout starts only
after authentication, so human typing consumes none of it.

Once recognized, all challenge failures (including transport/body failures,
timeouts, malformed forms, rejected codes and identity mismatches) terminate the
invocation with sanitized `mfa_code_rejected`, or preserve `PromptCancelled` /
`mfa_required`. The failure is cached on the client, never retried as a fresh
prompt and never downgraded to a Basic Authorization header. Interactive records
preserves these outcomes before aggregate-count fallback, list-probe wrapping
and source error handling. Escape retains `Cancelled.` with exit 0. No pending
operation or mutation-history outcome is emitted on these pre-dispatch failures.

Codes, passwords, cookies and CSRF/nonce values are not logged or added to errors
or mutation history. No TOTP seed is accepted or stored, and no code is generated
locally. Use an explicitly configured OAuth or browser-session profile when an
unattended workload cannot complete TOTP.

**Verification boundary:** this implementation is fixture/mock tested only.
Live MFA acceptance, provider-family form compatibility, and live invalid-code
retry behavior remain unverified; the available phone enrollment was deleted.
The earlier live runtime-recovery evidence below is not live TOTP acceptance.

## Runtime authentication recovery

Normal commands do not run an auth-status preflight or use a fixed session-age
heuristic. A rejected session permits one recovery attempt and at most one
replay of the request that proved it was stale. A second rejection is final.
Network failures, aborts, timeouts, 5xx and 403 never trigger recovery or
replay. Authentication bootstrap requests bypass recovery. Successful recovery
discards cached session cookies, the user token and the in-flight warm-up
promise as one unit, then rebuilds the authenticated session.

A rejection is one of three classified signals (`src/session-recovery.js`):

- **HTTP 401** — a definitive pre-execution rejection. The provider refused the
  credentials before dispatching the operation, so reads and writes may both be
  replayed once.
- **Login redirect** — the response (or its final URL, after following
  redirects) is the platform login page. This proves nothing ran for a read.
- **Login page** — a 2xx `text/html` body containing the login form
  (`user_name` plus `user_password`, or a `login.do` form action). JSN reads only
  a bounded 64 KiB prefix of the cloned body, so caller bodies stay intact and
  no response body is logged or echoed.

Replay eligibility is explicit per operation. Reads (`GET`/`HEAD`/`OPTIONS`)
are replayed once after successful recovery for any classified signal. A write
or stateful processor is replayed only on HTTP 401; when it is answered with a
login page or redirect instead, JSN refuses with an actionable error because a
heuristic body match is not proof that the operation never ran. Callers can opt
in through the SDK's `allowMutationReplay` setting; no JSN write path does.
Replaying preserves the original method, body, headers and endpoint.
Store install/update use GET-shaped mutation endpoints, so their SDK requests
explicitly carry `stateful: true`. A login page or redirect never causes those
operations to be resubmitted; ordinary reads and definitive HTTP 401 recovery
retain their existing behavior.

Before the replay, JSN verifies the recovered identity with one bounded
`GET /api/now/table/sys_user` current-user read issued through the same
`_setAuth` path the failed operation uses — with the re-established cookies and
`X-UserToken` for cookie/CSRF sessions, not a bearer-only probe. An unverified
session, a different account than the selected profile, or a failed probe ends
recovery with `auth_error` and the profile's recovery command; the request is
not replayed.

Session state is versioned. Concurrent requests share one in-flight recovery:
later rejections that were sent with the previous generation replay with the
rebuilt session instead of starting another refresh or browser login, and a
rejection observed at an older generation never triggers a second recovery.
Recovery attempts are therefore bounded by one in-flight attempt and one replay
per request.

OAuth recovery uses `AuthManager.refreshToken` with the selected instance and
username; expired tokens refresh rather than reopening a login. Basic
credentials have no renewal mechanism. Browser-session profiles
use `reauth: auto | confirm | never`, saved under `profiles.<name>.reauth`.
An absent setting means `confirm`. Configure it with:

    jsn auth modify --profile <name> --reauth confirm

`auto` opens the existing browser renewal flow only when a human is reachable.
`confirm` first asks one yes/no question. `never` refuses runtime browser renewal.
All policies refuse implicit renewal in non-TTY, CI and agent invocations, with
machine output or `--get`. The existing browser login timeout remains five minutes.
Renew explicitly with `jsn auth refresh --profile <name> --browser`.
Setup has no additional policy question; use `auth modify` for this preference.

Captured GCK/browser-session credentials contain nothing JSN can renew on its
own. When a browser session is rejected and cannot be renewed interactively,
the error says so and marks `recapture_required`: it names
`jsn auth refresh <profile> --browser` as the recapture step instead of implying
that a retry alone can recover it.

HTTP 401 is `auth_error` with status, profile and an exact recovery command in
JSON, plus the same guidance in text. OAuth guidance names
`jsn auth refresh --profile <name>` and login as the fallback. Basic guidance
names `jsn auth login --basic <instance> --profile <name>` and
`SN_USERNAME`/`SN_PASSWORD`. HTTP 403 is `forbidden` with authorization/ACL/role
guidance, not a request to log in. Neither classification includes provider
response bodies. Errors without a usable HTTP status retain their existing
classification rather than guessing whether authentication failed.

### Verification status

Live-verified against the dev366743 PDI instance on 2026-11-05 (Node v26.8.1,
throwaway XDG config with a copied profile; the real credential file was not
modified):

- A stale access token on a read produced HTTP 401, one OAuth refresh, one
  bounded `sys_user` verification over the rebuilt cookie/`X-UserToken` session
  with no `Authorization` header, and exactly one replay that returned real
  records.
- Five concurrent reads sent with the same stale token shared one refresh and
  one verification. Each request was sent once with the stale session, rejected
  once, then replayed once with the rebuilt session.
- A replay forced to receive HTTP 401 after a successful recovery stopped after
  two attempts with `auth_error`; there was no third request.
- A forced failure of the verification probe ended recovery without replaying
  the rejected request.
- An OAuth 401 with no refresh token produced one request, an actionable
  `auth_error`, and no retry.
- A junk GCK browser session produced one request, `recapture_required: true`
  in the JSON envelope, and no replay.
- A write whose first POST received HTTP 401 was refreshed, verified, and
  replayed once; exactly one incident existed afterwards (count 1 before the
  probe delete, 0 after). A normal CLI write recovers on its current-user
  context read before dispatching the mutation, so a stale token is generally
  repaired before the write itself is sent.
- The login-page classifier was run against the instance's real 47,535-byte
  `login.do` body and classified it correctly. No command was driven into a
  200 `text/html` login-page response because the instance answered junk
  sessions with JSON 401s; that end-to-end path remains mock-only.

Still mock-only: login redirects and 200 login pages as command responses,
account-mismatch rejection, interactive GCK renewal (`auto`/`confirm` prompts),
Basic-auth recovery guidance, `allowMutationReplay` opt-in, and batch/stateful
processor replay. The unit suite covers each of those; they are not claimed as
live-verified here.

Missing, invalid or expired credentials can fail locally before any request.
Those errors preserve the validation reason and identify the selected profile
with an explicit `jsn auth login --profile <name>` recovery command, even when
another profile is the default. They do not claim an HTTP status or trigger a
network preflight. `auth status` remains available for explicit diagnostics.

The existing declared-expiry refresh in `AuthManager.getCredentialsFor` remains:
it uses the token's own `expires_at`, not elapsed session age. Read-only auth
status SDKs do not install runtime recovery. Offline commands do not require it.

## Remaining boundary

A legacy bare credential or bare pending PKCE state has no reliable username identity. JSN therefore does not claim to distinguish users before a profile identity is known. Users should re-authenticate legacy/no-profile entries before operating multiple identities on the same instance.

For a browser-session profile, `jsn auth refresh` renews the session through the shared browser login flow. In an interactive terminal it opens the browser; automation must explicitly pass `--browser` or supply `--headers-file <path>` (`-` reads stdin). OAuth profiles continue using their refresh token.

`auth login` accepts the same `--headers-file` input. Files and piped input use
the existing captured-session parser and verification, without a paste prompt or
session data in command arguments. Empty/unreadable input and conflicting method
flags fail before authentication changes. Inline `--headers` remains available
for compatibility. `setup --help` maps all wizard actions to scriptable commands;
Basic uses environment credentials, and OAuth can read its code through the
existing `--print-url --wait-file <path>` flow.
