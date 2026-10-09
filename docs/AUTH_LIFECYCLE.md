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

## Diagnostics are read-only

`auth status` uses safe metadata and a read-only current-user probe. It does not refresh tokens, update `last_seen`, migrate credentials, or persist credentials. JSON diagnostics contain method, source, state, and probe classification only; access tokens, refresh tokens, passwords, cookies, and browser-session headers are never serialized.

The existing JSON envelope, human rendering, `--get` paths, and structured error codes remain unchanged. Probe failures are classified without returning provider response bodies.

## Shared-instance and concurrent behavior

Credential records for different usernames on one instance are independent. Refresh and logout operate on the explicitly selected identity, so updating or deleting one username does not affect another.

Pending OAuth PKCE state is also identity-scoped when the profile username is known. This prevents two concurrent same-instance profile logins from overwriting each other's verifier/state. No-profile OAuth flows retain the bare instance slot because the username is not known until verification; those flows must not be treated as concurrent named-profile flows.

The focused auth tests cover same-instance username isolation, explicit refresh/logout identity, method separation, read-only diagnostics, legacy handling, redaction, and concurrent username-scoped PKCE state.

## Remaining boundary

A legacy bare credential or bare pending PKCE state has no reliable username identity. JSN therefore does not claim to distinguish users before a profile identity is known. Users should re-authenticate legacy/no-profile entries before operating multiple identities on the same instance.
