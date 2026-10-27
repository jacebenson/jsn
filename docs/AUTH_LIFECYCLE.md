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

The JSON envelope and existing `--get` paths remain compatible; profile rows
also expose the configured `username` and whether the profile is `active` for
this invocation. Human status separates credential availability from live
verification and shows profile settings plus corrective commands.
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

## Shared-instance and concurrent behavior

Credential records for different usernames on one instance are independent. Refresh and logout operate on the explicitly selected identity, so updating or deleting one username does not affect another.

Pending OAuth PKCE state is also identity-scoped when the profile username is known. This prevents two concurrent same-instance profile logins from overwriting each other's verifier/state. No-profile OAuth flows retain the bare instance slot because the username is not known until verification; those flows must not be treated as concurrent named-profile flows.

The focused auth tests cover same-instance username isolation, explicit refresh/logout identity, method separation, read-only diagnostics, legacy handling, redaction, and concurrent username-scoped PKCE state.

## Remaining boundary

A legacy bare credential or bare pending PKCE state has no reliable username identity. JSN therefore does not claim to distinguish users before a profile identity is known. Users should re-authenticate legacy/no-profile entries before operating multiple identities on the same instance.
