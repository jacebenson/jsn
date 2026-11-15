# Browser-extension session handoff for remote authentication

Design proposal for [#302](https://github.com/jacebenson/jsn/issues/302). This
document is an exploration, not an implementation claim. Nothing described here
is wired into `jsn` yet except the existing flows it references, and the
protocol helpers noted at the end.

## The gap

Three acquisition paths exist today for GCK (browser-session) credentials:

| Path | Where the browser is | What it needs | Remote/SSH use |
|---|---|---|---|
| `jsn auth login --browser` | Launched **on the CLI host** (`cli/src/browser-launch.js:73`) | A Chromium-family binary and a display on the machine running `jsn` | Fails: the window opens on the remote host, where the user cannot see or sign in to it |
| `--browser --browser-url http://127.0.0.1:9222` | The user's laptop | A browser started with `--remote-debugging-port` and an `ssh -L` tunnel | Works, but exposes a full CDP endpoint (arbitrary script execution and cookie reads in *every* tab) for the length of the login |
| `--gck` / `--headers` / `--headers-file` | The user's laptop | Finding the right request in DevTools → Network and copying cURL/headers (`cli/src/auth/browser-session.js:7`) | Works, but is the friction the issue describes |

`readBrowserSession` (`cli/src/browser-auth.js:116`) and `localEndpoint`
(`:27`) deliberately confine browser access to loopback HTTP/WS with no
credentials, query, or fragment. That is the right default and should not be
loosened. The missing capability is narrower: **capture on the machine with the
browser, transfer once, verify and store on the machine with the CLI.**

## Shape of the proposal

1. An MV3 extension captures the token and cookies for exactly one
   user-approved origin.
2. It posts them once to a loopback listener owned by the pending
   `jsn auth login` process, reached through the user's existing SSH session
   (`ssh -L`). No relay server, no persistent file, no debugging port.
3. The CLI runs the **existing** GCK verification and store path unchanged, so
   the trust boundary, error text, and credential identity stay where they are.

The extension never talks to ServiceNow on the CLI's behalf and never accepts a
password. It reads what the user's already-authenticated browser already holds.

## 1. Instance-scoped permissions and custom domains

### Permission model

An MV3 extension cannot read cookies without a host permission for the origin,
and install-time `host_permissions` for every ServiceNow domain would be both
over-broad and wrong for customer-hosted domains. The proposal:

- Declare `optional_host_permissions` only. Grant nothing at install.
- On the "Connect this session to JSN" click (a user gesture, which
  `chrome.permissions.request` requires), request exactly one origin:
  `chrome.permissions.request({ origins: [origin + '/*'] })`.
- Cache the grant per origin so repeat logins for the same instance do not
  re-prompt; never grant a pattern wider than the single origin.
- Declare `http://127.0.0.1/*` (and `http://localhost/*`) so the extension may
  POST to the tunnel endpoint.

Custom domains need no allow-list. The rule is structural, not name-based:

- The origin must be a bare origin: no path, query, fragment, username, or
  password — the same rule `normalizeInstanceURL` applies (`cli/src/config.js:29`)
  and `localEndpoint` applies to the debugging URL (`cli/src/browser-auth.js:27`).
- `https:` only, with `http:` permitted for `127.0.0.1`, `localhost`, and `[::1]`
  development instances.
- `chrome:`, `file:`, `data:`, `chrome-extension:`, and IP-literal hosts other
  than loopback are rejected.
- The popup shows the origin in full and requires an explicit confirm; the user
  sees `https://acme.service-now.com`, not "this site".
- **The CLI is the authority.** The handoff payload carries the instance the
  extension captured from, and the receiver rejects it unless it equals
  `normalizeInstanceURL()` of the instance the pending login was started for. A
  capture for the wrong instance cannot be stored even if the extension is
  confused or compromised.

### Cookies, including HttpOnly

`chrome.cookies.getAll({ url: origin })` returns `HttpOnly` cookies; the
HttpOnly flag restricts `document.cookie`, not the extension API. It also
returns parent-domain cookies (`Domain=.service-now.com`), `Secure`,
`SameSite=None`, and session cookies — the same set CDP returns for
`Network.getCookies({ urls: [origin + '/api/now/table/sys_user'] })`
(`cli/src/browser-auth.js:146`).

Two constraints matter:

- Scope by **URL**, never by domain pattern. `getAll({ domain: 'service-now.com' })`
  would sweep every instance the user is signed in to. The URL form matches what
  the current CDP path already does.
- Only `name` and `value` are transferred (`name=value; name=value`). Attributes
  are dropped, exactly as in the CDP path (`cli/src/browser-auth.js:152`). The
  existing name/value validation (`/^[!#$%&'*+.^_`|~0-9a-z-]+$/i`, no CR/LF/`;`
  in values) is applied on **both** ends; the receiver must not trust the
  extension's copy of the rule.

SSO cookies live on the identity provider's domain, not the instance's. That is
fine: after SSO completes, the instance sets its own session cookies, which is
what the API needs. An instance that requires an IdP cookie per API request
would already fail the existing `--gck` path and is out of scope (open question
Q-3).

### Capturing `g_ck` across page layouts

`g_ck` is a page-global user token, so a content script's isolated world cannot
see it. The extension reads it with
`chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func })`,
which mirrors the frame walk already implemented in `TOKEN_EXPRESSION`
(`cli/src/browser-auth.js:100`) — same-origin frames only, first non-empty
value wins, exceptions swallowed per frame.

| Layout | Token location | Capture strategy |
|---|---|---|
| Classic UI / CMS forms | `window.g_ck` in the top frame; `gsft_main` frame in list/embedded layouts | MAIN-world `allFrames` walk, same as `TOKEN_EXPRESSION` |
| Next Experience / UI Builder workspaces (Agent Workspace, CSM Configurable Workspace) | SPA shell; `g_ck` may not be a plain `window` property at arbitrary moments | MAIN-world walk first; fallback: `fetch(origin + '/', { credentials: 'include' })` and extract `var g_ck = '…'` from the server-rendered HTML (the same value the CLI reads) |
| Service Portal / Employee Center | `g_ck` on the portal page | MAIN-world walk; fallback as above |

The fallback is the honest weak point: it assumes the instance emits `g_ck` in
the root HTML for that version and plugin set. Verifying it across a PDI,
a workspace, and a portal widget page is Phase 1 work and is listed as an open
question (Q-1). When no token is found, the extension must say so and point at
`--headers-file`; it must not send a token-less payload.

Token lifetime is short (rotated per session, and an idle `g_ck` may rotate on
activity), which is why the handoff TTL below is minutes, not hours, and why
verification happens immediately on receipt.

## 2. Explicit destination and one-time transfer over SSH

### Chosen mechanism: loopback receiver behind an SSH local forward

On the machine running `jsn`:

```text
$ jsn auth login dev12345 --extension
Open in the browser you are signed in with:
  ssh -L 8765:127.0.0.1:41773 you@this-host     (run this on your laptop)
Pairing code: 7F3K-2Q9D   (single use, expires in 5:00)

Then click "Connect this session to JSN" and enter 8765 and the code.
```

- The receiver binds `127.0.0.1:0` (OS-assigned port) and never `0.0.0.0`.
- `ssh -L 8765:127.0.0.1:41773` binds loopback on the laptop; only that
  machine's local processes can reach it, and only while the tunnel is open.
- Only `POST /v1/handoff` is served. Method, path, `Content-Type: text/plain`
  (a CORS "simple request", so no preflight), body ≤ 64 KiB, cookie header
  ≤ 8 KiB, one JSON object.
- The pairing code is in the **body**, not a header. A header would force a
  preflight that a malicious page could still pass; requiring a 40-bit code in
  the body means a page that can reach the port still cannot drive the handoff.
- The listener verifies `Host` is `127.0.0.1:<port>` (DNS-rebinding defense) and
  that any `Origin` header is a `chrome-extension://` origin.
- Three malformed or wrong-code requests close the listener. Success closes it
  immediately; timeout (default 300 s) closes it too.
- The response body is `{ status, user? }` with no credential echo. Nothing is
  printed except pass/fail and the verified username under the same
  `--details` rules as `auth status`.

### Why not the alternatives

| Alternative | Why rejected |
|---|---|
| Copy a JSON blob to the clipboard and paste into `jsn auth login --gck` | Same friction as `--headers-file`, and the clipboard is readable by every process on the laptop |
| `scp` a temporary file to the remote host | Creates exactly the persistent credential file the issue says to avoid |
| Hosted relay service | Introduces a third party that receives live sessions; unacceptable as a default, and a maintenance burden |
| HTTPS loopback callback with a self-signed cert (OAuth-style) | Requires trust-store changes on every laptop; the SSH tunnel already provides confidentiality and user authentication |
| SSH remote forward (`ssh -R`) | Would expose the receiver on the *remote* host's network, not the laptop's loopback; wrong direction for this problem |

### Threat model

Assets: the `g_ck` token and cookie string — a live, full-privilege session for
one instance as one user.

| Adversary | Capability | Mitigation | Residual risk |
|---|---|---|---|
| Passive network attacker on the SSH path | Sees tunnel bytes | SSH encryption + host-key verification | None beyond SSH's own trust |
| Other local users on the laptop | Can connect to `127.0.0.1:8765` while the tunnel is open | 40-bit single-use code, 3-attempt cap, 5-minute TTL, listener closed on success | Such a user can already read the browser profile; no new exposure class |
| Malicious web page in the same browser | Can send requests to `127.0.0.1:8765` | No preflight-free header channel; code is in the body and unknown; failed attempts close the listener | Small blind-guess window bounded by 3 attempts |
| Malicious or compromised extension | Holds origin permission and can read that origin's cookies anyway | Handoff grants no privilege the extension did not already have; per-origin grants and one-shot codes limit cross-instance reach | Inherent to any extension the user installs |
| Shoulder-surfing / terminal scrollback | Reads the printed pairing code | Code is useless before the browser click, single-use after, and expires | Same as observing the login itself |
| Log capture / shell history | Reads command output | The code is typed into the extension, never into a shell; credentials are never printed or written; errors reuse fixed strings (the "never echo provider errors" rule at `cli/src/browser-auth.js:70`) | Terminal scrollback retains the code until it expires |
| Replay after a successful handoff | Re-posts the payload | Listener exits; code consumed; credentials already replaced by then if the user logs in again | None |
| Wrong destination (`ssh -L` typo) | Payload goes to the wrong local port | Connection refused; if it reaches another instance of `jsn`, the instance check rejects it | None |

The pairing code is *not* a credential: it authorizes one delivery to one
loopback port, and it cannot be used to talk to ServiceNow.

## 3. Verifying instance and user before saving

The receiver calls the existing `AuthManager._verifyBrowserSession`
(`cli/src/auth.js:473`) with `requireIdentity: true`, which means the behaviour
is already specified by `AUTH_LIFECYCLE.md` and covered by existing tests:

- `GET {instance}/api/now/table/sys_user?sysparm_query=user_name=javascript:gs.getUserName()`
  with `X-UserToken` and `Cookie`, `redirect: 'error'`.
- `401`/`403` while pending → "not authorized for current-user verification",
  nothing saved.
- `guest` → still pending (the user is not signed in).
- Missing `user_name` → pending, nothing saved.
- `user_name` different from the profile's username → hard error, nothing
  saved (`cli/src/auth.js:509`).
- Success returns `{ ...creds, username }`, then
  `saveCredentials(normalizeInstanceURL(instance), creds, creds.username)`
  (`cli/src/auth.js:469`) writes the `<username>@<origin>` key through the
  existing GCK store: `secret-tool` first, then a `0600` file
  (`cli/src/auth/credential-store.js:144`). `auth_method`/`auth_source` stay
  `gck`, so `classifyCredentialState` (`cli/src/auth/credential-state.js:106`)
  and every status/refresh path keep working untouched.

Additions specific to this transport, applied **before** the HTTP verification:

1. `payload.instance === normalizeInstanceURL(pendingInstance)`; otherwise 400
   and a message naming the two origins (origins are not secrets).
2. `payload.protocol === 1`; a higher protocol is rejected with "update the
   extension" rather than being partially parsed.
3. Token and cookie strings re-validated with the same rules as
   `cli/src/browser-auth.js:152-157`.
4. Payload held in memory only. No temp file, no debug log. (A string in the V8
   heap cannot be zeroed; the current `--gck` and CDP paths have the identical
   property, so this is not a regression and should be stated, not hidden.)
5. A profile is created or updated only after a verified username is returned,
   matching the "import requires a returned username" rule.

### Account mismatch

Covered by the existing branch: the browser account must equal the selected
profile's username, and the error does not print either name unless `--details`
rules allow it. The extension may show the account it captured (from the
`sys_user` it can read in the page), but the CLI's verified value is the only
one persisted. A user who wants a second identity on the same instance uses
`--name`, exactly as today.

### Session and IP restrictions

The verification request originates from the **SSH host**, not the laptop. If
the instance binds sessions to a client IP (session-IP checks vary by version,
plugin, and property), the captured session is valid in the laptop's browser and
invalid from the remote host. The design:

- Treats that as a hard failure with the existing "Browser session rejected by
  `<instance>` (HTTP 401/403). Nothing was saved." message, plus one sentence
  naming the likely cause (session restricted to another address) and the
  alternatives: run `jsn` on the laptop, use `--headers-file` from the same
  host, or use OAuth if the instance offers it.
- Never stores unverified credentials to "try later". A GCK record that failed
  verification is worse than no record.
- Cannot relax the restriction, and does not try. Note that some instances also
  rotate `g_ck` on IP change, which surfaces as the same 401.

Other instance-side restrictions that surface as `401`/`403` — MFA step-up,
denied `sys_user` read for the current-user probe, KBA walls — are already
classified by `classifyProbeError` (`cli/src/auth/credential-state.js:79`).

## 4. Browser support, distribution, and updates

### Support matrix

| Browser | Status | Notes |
|---|---|---|
| Chrome, Edge, Chromium | Target (MV3) | Needs `cookies`, `scripting` with `world: 'MAIN'`, `optional_host_permissions`, and `permissions.request` from a click. Treat Chrome 116+ as the working minimum and pin the real minimum in Phase 1 |
| Brave, Vivaldi, Opera | Expected, untested | Chromium APIs; the store listing will not claim support until tested |
| Firefox | Not in v1 | MV3 event pages, `browser.cookies` semantics, and host-permission UX differ enough to be a separate implementation; `--headers-file` covers Firefox users meanwhile |
| Safari | No | Different extension packaging and review; out of scope |

The CLI must never require the extension. Every new error message has to end at
a path that works without it: `--headers-file <path|->`, the pasted `--gck`
flow, or OAuth.

### Distribution

- Chrome Web Store, then Edge Add-ons. Both review `cookies` and host
  permissions as sensitive; the listing's justification is narrow and true:
  "reads cookies and the page token only for the origin the user selects at
  click time; sends them only to 127.0.0.1 on the user's own machine; no
  analytics, no remote code, no server."
- Unpacked/enterprise install (`ExtensionInstallForcelist`) documented for
  organizations that cannot use public stores. This also gives a no-review
  escape hatch if the store rejects the cookie permission.
- The extension is **not** shipped in the npm tarball. `cli/package.json`
  `files` already limits the package to `bin/jsn.js`, `src/`, `skills/`,
  `README.md`, `LICENSE`; the extension lives at repo root
  `extensions/browser-auth/` and stays out of that list.

### Updates and version skew

- Store builds auto-update; unpacked builds do not. Therefore the wire contract
  is versioned and negotiated: the payload carries `protocol: 1`, the receiver
  rejects anything else with an actionable message ("this JSN expects extension
  protocol 1; update the extension" or "this extension is newer than this JSN").
- Protocol 1 is frozen once Phase 1 ships. Adding a field is backward compatible
  only if the receiver ignores unknown fields and the extension tolerates
  missing ones; changing semantics requires protocol 2 plus a dual-read window.
- The CLI prints the protocol it speaks in `--extension` startup output so a
  user can match versions without reading release notes.

## 5. Recommendation

**Pursue, but not extension-first.** The valuable, verifiable part is the
transport and verification contract; the extension is a capture UI for it. The
extension alone cannot be reviewed, tested, or shipped from this repository
without Chrome and a live instance, and it is the part most likely to change.

### Phase 0 — the first verifiable step

Add `jsn auth login <instance> --handoff` to the CLI: loopback receiver,
pairing code, `ssh -L` instruction, single-use + TTL + attempt cap, then the
existing `_verifyBrowserSession` and `saveCredentials`. No browser, no
extension.

Why this is the right first step:

- It is fully testable in this repo: unit tests for code generation/normalisation,
  TTL, single-use consumption, attempt cap, Host/Origin checks, instance
  mismatch, and oversize payloads; plus a manual `curl` run over a real
  `ssh -L` between two machines.
- It is useful on its own: a laptop-side bookmarklet or a two-line `curl` script
  can drive it, replacing the DevTools Network hunt.
- It proves the threat model assumptions before any store review, and it is the
  contract the extension must satisfy.

### Phase 1 — MVP extension speaking protocol 1

Unpacked only, manual test plan across Classic UI, a workspace, and Enterprise
Portal; verifies the `g_ck` fallback and the cookie-set equivalence with
`Network.getCookies`.

### Phase 2 — distribution

Store listings, enterprise policy docs, and a support matrix backed by tests.

### What could not be verified here

No Chrome and no ServiceNow instance were available, so nothing about extension
capture, store review, or IP-restricted instances is proven. That is stated in
the PR as a design proposal, not an implementation.

## 6. Open questions

| ID | Question | Why it matters |
|---|---|---|
| Q-1 | Does the root-HTML `var g_ck` fallback work on Next Experience workspaces and Service Portal pages for current releases? | If not, workspace users need a different capture (possible per-layout endpoint) or the feature only covers Classic UI at launch |
| Q-2 | Does `chrome.cookies.getAll({url})` return a cookie set equivalent to CDP's `Network.getCookies` for the same instance (including partitioned/`CHIPS` cookies)? | A shorter list could pass capture but fail the verification GET |
| Q-3 | Do any supported deployments require an IdP-domain cookie alongside instance cookies? | Would need an explicit extra-origin capture step and a corresponding CLI allowance |
| Q-4 | Is `ssh -L` available in the environments that need this (jump hosts, containers, VS Code Remote, Tailscale)? | If not, the fallback is `--headers-file`, and the extension's value drops |
| Q-5 | Does Chrome Web Store accept `optional_host_permissions` for a broad pattern with per-origin requests, or demand an enumerated host list? | Would change the manifest and possibly force a fixed domain list plus custom-domain opt-in |
| Q-6 | What is the practical cookie/token size ceiling per instance? | Sets the 8 KiB/64 KiB caps and whether compression is needed |
| Q-7 | Should the receiver live on `auth login` or a separate `auth receive` subcommand? | `auth login` keeps discovery; a separate command keeps the login surface free of a listening socket |

## Appendix: protocol 1 helpers in this branch

`extensions/browser-auth/lib/handoff.js` contains the pure, side-effect-free
pieces of the extension half of protocol 1 — origin eligibility, pairing-code
normalisation and comparison, and payload construction/validation. It has no
`chrome.*` calls, no manifest, and no capture code, and it is not in the npm
package. `cli/test/extension-handoff.test.js` exercises it so the contract is
executable rather than prose. This is a sketch of the wire format, not a
working extension.
