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
