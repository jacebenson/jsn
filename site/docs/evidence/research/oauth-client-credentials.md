# OAuth client credentials for JSN — onboarding and unattended-use spike

Issue: [#404](https://github.com/jacebenson/jsn/issues/404) — research spike, not an
implementation commitment. Nothing in this document changes a production instance and
no instance setup step was performed.

Status of this document: **no live instance was available to the author**, so every
claim about *runtime behaviour* (what a token can actually reach) is reasoning over
primary documentation plus JSN's own source, and is labelled **not live-verified**.
Every claim that a *configuration exists* is source-cited.

## Method and provenance

Read for this spike: `cli/src/auth/oauth.js`, `cli/src/auth/credential-store.js`,
`cli/src/auth/browser-session.js`, `cli/src/auth.js`, `cli/src/sdk.js`,
`cli/src/config.js`, `cli/src/commands/auth.js`, `cli/src/commands/setup.js`,
`cli/src/commands/{atf,eval,platform}.js`, `cli/src/scan.js`, `docs/AUTH_LIFECYCLE.md`,
`docs/DECISIONS.md`.

Primary external sources:

- SDK 4.14.0 CI guide, `https://servicenow.github.io/sdk/4.14.0/config/ci-integration`
  — static HTML, read live 2026-11-04. [^1]
- Platform docs, `client-credentials.html`, `create-cc-sys-prop.html`,
  `configure-an-oauth-client-credential-grant.html`. [^2] [^3] [^4]

The three ServiceNow documentation pages are a JavaScript application: a plain HTTP
fetch returns the shell only. I retrieved the underlying topics through the docs
site's own content API (`/api/khub/maps/<Brazil Platform security>/topics/<id>/content`),
which returned the article bodies with the page headers `Release version: Brazil`,
`Updated September 10, 2026`. The URLs above are the canonical reader URLs for those
topics and are what a human would cite; the *text* came from the same site's topic
API. Treat the citations as live-verified article text for release **Brazil**;
treat anything about an older family release as "topic exists in that release's map",
which is weaker evidence than the same text.

## 1. Prerequisites and supported-version matrix

| Claim | Detail | Source | Verified? |
|---|---|---|---|
| Grant is off by default | Inbound client-credentials is controlled by `glide.oauth.inbound.client.credential.grant_type.enabled`; "By default the system property is false" | [^2] | Source-cited |
| Property name and type | `glide.oauth.inbound.client.credential.grant_type.enabled`, type `true\|false`, value `true`; created in `sys_properties.list` | [^3] | Source-cited |
| Who may create the property | Role required `oauth_admin`; plugin required **OAuth 2.0** | [^3] | Source-cited |
| Who may configure the client | Roles `oauth_admin`, `mi_admin`, `admin` | [^4] | Source-cited |
| Current UI path | **Machine Identity Console → Inbound integrations → New integration → OAuth - Client credential grant** | [^4] | Source-cited (Brazil) |
| Alternate/"old experience" path | **System OAuth → Application Registry → New → New Inbound Integration Experience → New Integration → OAuth Client Credentials Grant** | [^1] | Source-cited (SDK guide) |
| Client record must name an application user | Any request with grant type Client Credentials + client id + secret "is passed for the associated OAuth Application User"; if no application user is set, or the property is false, "the authorization request isn't passed" | [^5] | Source-cited |
| The form field may be hidden | On older clients the `OAuth Application User` field has to be added through **Configure → Form Design** before it can be set | [^5] | Source-cited |
| Access is scoped/limited | `Allow access only to APIs in selected scope` restricts to listed scopes; `Enforce token restriction` limits the client to REST API Access Policies; unselecting it leaves access to "other REST APIs based on the user ACL permissions" | [^4] | Source-cited |
| Token shape | JWT or Opaque, selectable; JWKS at `api/now/oauth/jwks`; rotated inactive keys drop after 105 days | [^4] | Source-cited |
| Token lifetime | `Access token lifespan`, default **1800 seconds** | [^4] | Source-cited |
| No refresh token | "There is no refresh token in this grant — each invocation fetches a fresh token" | [^1] | Source-cited |
| Token endpoint | `POST /oauth_token.do` with `grant_type=client_credentials`, client id and secret | [^1] | Source-cited |
| SDK installer needs an admin, Human-type user | SDK's service user "must have `admin` role sufficient to install your app" and `Identity Type = Human` because "the SDK's installer processor requires a human type user account" | [^1] | Source-cited **for the SDK installer only** |
| Minimum platform family | Topic present in Xanadu, Yokohama, Zurich, Australia and Brazil Platform-security maps; Machine Identity Console topic appears only from **Zurich** onward (Xanadu/Yokohama only document the Application Registry flow) | [^6] | Verified by topic inventory, not by reading each release's text |
| Exact minimum family where the grant first shipped | Not established — the Xanadu article (updated 2024-08-01) already describes it, but no source states a "first available in" release | — | **Unverified** |

Practical reading of the version matrix:

- Anything from **Zurich** to **Brazil** has both documented paths and is the safe
  target for instructions.
- **Xanadu / Yokohama**: the grant and property exist in the docs, but the
  Machine Identity Console path does not exist in those release docs, so instructions
  must fall back to System OAuth → Application Registry.
- **Washington / Vancouver**: not present in the current docs site's release maps at
  all; do not claim support. If a user reports it working there, that is
  instance-specific evidence, not documentation.

## 2. Admin setup vs runtime identity

These are two different people with two different permission sets, and JSN must never
collapse them.

**One-time, administrator (or OAuth administrator) work**

1. Confirm the `OAuth 2.0` plugin is active (`oauth_admin`). [^3]
2. Create/enable `glide.oauth.inbound.client.credential.grant_type.enabled=true`
   (`oauth_admin`). This is a *system-wide* switch: enabling it turns the grant on for
   the whole instance, for every OAuth client, not just the one being onboarded. [^2] [^3]
3. Decide the runtime user — a dedicated integration user, *not* an admin. [^4] [^5]
4. Create the inbound integration (`oauth_admin` / `mi_admin` / `admin`), set
   `OAuth application user`, copy the client id and secret once. [^4]
5. Choose scope validation: restrict to selected scopes/APIs, or leave broader access
   governed by the user's ACLs. [^4]

**Runtime identity**

- The token "represents the application itself, and not the user" as an authentication
  artifact, but authorization is evaluated **as the OAuth application user**, so ACLs,
  role grants, domain separation and scoped-app access of that user apply. [^4] [^5]
- Therefore the runtime account can be a non-admin, least-privilege integration user:
  nothing in the platform documentation requires `admin` at runtime. The `admin`
  requirement that appears in the SDK page is explicitly about *the SDK installer
  processor* — JSN does not run that processor, so its elevation requirement must not
  be generalised to normal JSN use. [^1]
- Minimum roles are per task, not per method: table reads need read ACL/role on those
  tables; `sys_properties` reads need whatever protects that table; ATF execution needs
  the ATF roles plus access to the test records; Performance Analytics stats need the PA
  viewer role. None of this is provided by the grant.

**Onboarding contract this implies for JSN**: an administrator can provision a limited
integration for a team *without* giving the team administrative rights, provided the
secret is handed over out-of-band. What the admin hands over is exactly two values plus
a URL — client id, client secret, instance. That is a smaller and more auditable handoff
than `admin` credentials or a person's refresh token.

## 3. What JSN can detect read-only, and what it must instruct

Read-only detection is limited by ACLs: an unauthenticated client cannot read
`sys_properties`, and a client without the right token cannot read anything.

| Question | Can JSN answer read-only? | How |
|---|---|---|
| Is the instance reachable / is the URL right? | Yes | `auth status --local` plus one bounded unauthenticated probe |
| Is the grant property enabled instance-wide? | Only with a token that can read `sys_properties` | `records list --table sys_properties` filtered on the property name; otherwise "unknown" |
| Are my client id/secret valid? | Yes, by performing the token exchange | `POST /oauth_token.do`; `invalid_client` vs `unsupported_grant_type` cleanly separates bad secret from disabled grant |
| Which identity will my calls run as? | Only *after* a token exists | One bounded GET as that token, same rule as the existing read-only current-user probe |
| Does that identity have the roles my command needs? | No, not reliably | Role checks need `sys_user_has_role` reads that the integration user usually cannot see; report the 403 instead of guessing |
| Is the secret about to expire / was it rotated? | No | ServiceNow has no client-secret expiry metadata in the documented form; rotation is externally scheduled by the admin |

Rules that follow:

- **JSN must not create `sys_properties`, edit forms, or create OAuth records.** These
  are privileged instance mutations and out of scope for a CLI login path — the same
  boundary the repo already holds for "no implicit privileged instance setup".
- When the exchange fails, JSN should print the exact admin recipe (property name, path,
  roles, both UI variants) rather than attempt a fix. The two failure modes are
  distinguishable and must not be merged into one message: `unsupported_grant_type` →
  property/plugin, `invalid_client` → id/secret or inactive record.
- When the token works but a command 403s, that is an authorization result about the
  application user, and must be reported as such (matching `AUTH_LIFECYCLE.md`'s
  "HTTP 403 is `forbidden` with authorization/ACL/role guidance, not a request to log in").

## 4. Profile and setup UX sketch

Reuse the existing profile concepts rather than inventing a new one: a profile already
selects one instance, one auth method, an optional username, and (for browser sessions)
a `reauth` policy. Client credentials adds a **grant**, not a new identity model.

```
profiles:
  ci-prod:
    instance: https://acme.service-now.com
    auth_method: client_credentials
    client_id: 0a1b2c...            # not secret; safe in config
    username: svc_jsn_ci            # the OAuth application user, filled after verification
    reauth: never                   # there is no interactive renewal for this method
```

Credential record (keyring or 0600 file, unchanged storage path):

```
{ auth_method: "client_credentials", client_id, client_secret,
  access_token, expires_at, created_at, username, auth_source }
```

CLI surface, mirroring the existing `auth login` shapes:

```bash
# interactive (secret read with echo off, never echoed back)
jsn auth login --client-credentials --instance https://acme.service-now.com \
  --client-id 0a1b2c... --profile ci-prod

# automation: secret from a file, "-" for stdin; never from argv
jsn auth login --client-credentials --client-id ... \
  --client-secret-file - --profile ci-prod

# verify without acquiring anything
jsn auth status --profile ci-prod --local
```

Design constraints, each derived from an existing repo rule:

- **No `--client-secret` value on the command line.** `AUTH_LIFECYCLE.md` already
  establishes "no session data in command arguments" with `--headers-file -`; the secret
  follows the same pattern.
- **Explicit grant selection.** `--client-credentials` is a discrete flag, not a
  fallback: existing methods must not silently degrade into it, and it must not be
  selected because a refresh token is missing.
- **Profile selection stays authoritative.** `--profile` pins the credential identity;
  the new method does not retarget the active profile (same rule as
  `AUTH_LIFECYCLE.md`).
- **Credential key is not the username.** The application user is unknown until after
  the first exchange, and two integrations on one instance may map to the same user.
  Key the credential on `client:<client_id>@<instance>` so a client-credentials profile
  cannot overwrite a human's `<username>@<instance>` entry, then record the verified
  username inside the record.
- **Setup wizard** gains one choice in the grant list — after OAuth (browser) and before
  Basic, labelled with the cost: "OAuth client credentials — unattended, needs admin
  setup first". The wizard collects instance, client id, secret reference, and then
  prints the verified identity; it does not attempt to discover or create the client.
- **`auth status`** reports method `client_credentials`, source (keyring/file/env), local
  credential availability, and a live probe result — with no token or secret in any
  output, consistent with the read-only diagnostics contract.

## 5. Credential storage, CI injection, rotation, revocation, expiry, errors

**Storage.** Same two backends as today: OS keyring via `secret-tool`, else a 0600 JSON
file under the XDG config dir (`credential-store.js`). The client secret is a bearer-grade
secret and inherits the same weaknesses as a stored refresh token; client credentials does
not improve at-rest security, only *what* is stored (a rotatable integration secret
instead of a person's refresh token).

**CI / headless injection.** Follow the shape the platform SDK already proves out [^1]:
non-secret values in plain env (`SN_CLIENT_ID`, `SN_INSTANCE_URL`), secret in a distinct
variable or file (`SN_CLIENT_SECRET` or `SN_CLIENT_SECRET_FILE`), and CI mode only takes
effect when the *selected profile* says `client_credentials`. That preserves the existing
"configured method is authoritative, environment credentials are not a fallback for an
explicit profile" rule.

**Rotation.** The admin regenerates the secret on the client record and updates the
secret store/pipeline variable. JSN cannot rotate it (that is an instance write) and
should not try. A rotated secret surfaces as `invalid_client` on the next exchange; the
error must name the profile, the client id's last 4 characters if anything, and instruct
rotation — never echo the secret, never retry in a loop.

**Revocation.** Two admin actions: deactivate the client record (all future exchanges
fail) or `oauth_revoke_token.do?token=…` which marks an issued token expired and needs no
authentication to call [^7]. Local `auth logout --profile` deletes the stored secret so
JSN cannot mint another token. Because tokens are short-lived (default 1800 s), revocation
of a live token has a bounded blast radius even without the revoke call.

**Expiry.** There is no refresh token [^1]. `getCredentialsFor` currently refreshes when
`expires_at - 300s` has passed and otherwise throws `Token expired, please login again`
(`cli/src/auth.js:335-337`). A client-credentials record needs a third branch: re-exchange
instead of refresh, and *not* the "login again" guidance (which would send an unattended
job to a browser prompt). Reuse the same 5-minute skew.

**Errors to distinguish**, all without leaking the secret:

| Condition | Signal | Guidance |
|---|---|---|
| Property off / plugin off | `unsupported_grant_type` (or a non-JSON/HTML body) | Admin recipe, instance-wide switch warning |
| Wrong or rotated secret, inactive client | `invalid_client` | Rotation instructions, profile name, no secret echo |
| Scope/API restriction | `invalid_scope` or 403 on a specific API | Which scope/policy to widen; do not suggest admin credentials |
| Token expired/revoked mid-run | 401 `invalid_token` | Re-exchange once, then fail |
| Application user lacks access | 403 | ACL/role guidance for that table/API, not "log in" |
| Identity differs from profile username | verified user ≠ `username` | `account_mismatch`, same as the browser-import rule |

## 6. Endpoint compatibility matrix

JSN is not a pure REST client. It reaches several browser-style surfaces, which is where
"we got a token" stops being evidence that a command works. The table records JSN's
actual code path for each surface.

| Surface | JSN path | Applies to commands | With client credentials | Confidence |
|---|---|---|---|---|
| Table API `/api/now/table/...` | `sdk.js:260-306`, Bearer header `sdk.js:96` | `records`, most CRUD, catalog reads | Expected to work; access limited by the application user's ACLs and any scope/API policy | High (documented REST + SDK CI precedent [^1]) — runtime **not live-verified** |
| Stats / aggregate `/api/now/stats/...` | `sdk.js:684,735` | `records aggregate` | Expected to work only if the user has the Performance Analytics role; grant adds nothing | Medium — role requirement **not live-verified** |
| Attachment API `/api/now/attachment` | `sdk.js:329,340,366` | attachments | Expected to work; may be scope-restricted | Medium |
| GraphQL `/api/now/graphql` | `commands/graphql.js:82` | `graphql` | Expected to work if the API is in scope and the user has table access | Medium |
| ATF `/api/now/atf/test/{id}/run` + `sys_atf_*` writes | `commands/atf.js:167` and table writes | `atf run`, `atf run-suite`, `atf results` | Expected to work as REST; ATF "legacy" API is not covered by the docs read here | **Low** — no primary source for ATF-with-CC |
| ProcessFlow `/api/now/processflow/flow/{id}` | `sdk.js:467` | flow inspector | Expected REST behaviour, plugin/role-gated | Low |
| GlideAjax processor `/xmlhttp.do?sysparm_processor=ScanAjaxProcessor` | `scan.js:99`, POST, no bearer-specific handling | `scan` | **Uncertain.** Script/export processors *can* be bound to an OAuth authentication profile via Processor Access Policies, but "public processors are not supported" for that policy and `xmlhttp.do` is normally a public-processor path | **Low** — needs live test |
| `xmlstats.do` | `commands/platform.js:151` | `platform health` | **Uncertain** — same processor family; historically session-oriented | **Low** |
| Form/metadata UI posts `/angular.do?sysparm_type=...` | `sdk.js:987-1030` (`_warmSession`) | session warm for OAuth paths | JSN's warm-session dance is built for browser-OAuth tokens; a client-credentials token has no human login to convert into a UI session | **Low** — see below |
| Background scripts `/sys.scripts.do` (+ CSRF from the HTML form) | `sdk.js:854-880`, `1036-1048` | `eval` | **Expected to fail.** JSN already reports "Not authorized to access scripts page. Your OAuth token may not support UI sessions" (`sdk.js:1065`) | Medium-high that it fails, from JSN's own code |
| Scheduled reports / nightly jobs | none — JSN has no scheduler | — | Not enabled by the grant. A CLI needs external cron/CI; the token only removes the interactive login step | High (repo evidence) |

The decisive uncertainty is the middle of that table. JSN's OAuth path does not simply
send a bearer header: it first tries `_warmSession()`, which POSTs
`/angular.do?sysparm_type=get_user` unauthenticated, performs one Bearer-authenticated REST
GET, then repeats `get_user` with the collected cookies and captures
`x-usertoken-response` (`sdk.js:987-1008`). Every browser-style surface then rides on those
cookies and that user token. Whether a client-credentials access token can seed the same
exchange — and whether ServiceNow issues a UI session for a machine-identity token — is
**not documented in anything read here and was not tested**. A successful bearer REST
probe does *not* prove the cookie/CSRF path works; issue #403 says the same thing from the
other direction.

So the honest split is:

- **REST-only JSN usage**: very likely portable to client credentials.
- **Processor/UI-page/background-script usage**: unknown to likely-broken, and it is
  exactly the part that makes `eval`, `scan`, `platform health` and update-set
  export/upload work.

## 7. Comparison with existing JSN auth methods

| | Browser OAuth (PKCE + refresh) | Supplied bearer token (`SERVICENOW_OAUTH_TOKEN`) | Basic | Browser session (`gck`) | Client credentials |
|---|---|---|---|---|---|
| Human at setup | Yes, once | No | No | Yes | No |
| Human at runtime | Refresh token renews up to 100 days [^8] | No | No | Browser renewal flow or manual pasting | No |
| Identity | The person who consented | Whoever the token was minted for | The person | The person | The OAuth application user |
| Rotation | Re-login | Re-mint externally | Password change | Re-import | Admin regenerates client secret |
| Broken by SSO/MFA/password policy | Yes (interactive) | Depends on minter | Yes | Yes | No |
| Secret in CI | Refresh token | Short-lived token | A real user password | Session cookies | Integration secret |
| Long-running job survival | Good (refresh) | Poor (30-min default, no renewal) | Good | Poor | Good (re-mint) |
| Works with `eval`/UI processors | Yes (warm session) | Partially today | Yes (warm session) | Yes | **Unknown / likely no** |
| Extra instance setup | SDK OAuth client exists | None | None | None | Property + integration + app user |

The gap client credentials closes is narrow but real: **a non-human identity that survives
SSO/MFA/password policy and can be rotated without touching a person's account.** Basic
auth technically covers unattended runs today but stores a real user's password in CI, and
the browser/supplied-token methods are tied to a human session that expires.

The gap it does *not* close: it creates no scheduler, grants no permissions, and its
default 30-minute token still needs re-acquisition inside very long jobs.

## 8. Is it worth it? (value vs extra setup)

Where client credentials is clearly better than what JSN has:

- CI pipelines and unattended agents that must not hold a person's password or refresh
  token, especially where SSO/MFA make Basic and interactive OAuth brittle.
- Multiple pipelines sharing an integration identity that an admin can revoke in one place.
- Audit: instance-side, the actor is the named integration user, not a human.

Where it is *not* worth the setup, today:

- A single developer running commands interactively — browser OAuth is already better.
- Anything that needs `eval`, `scan`, `platform health`, or update-set export/upload,
  until processor/session behaviour is verified.
- Anyone who can already mint a token with `curl` and set `SERVICENOW_OAUTH_TOKEN` — that
  is the same grant, minus the CLI plumbing, and JSN already accepts it
  (`cli/src/auth.js:316`).

That last point matters for the recommendation: **the main capability client credentials
offers is already reachable in JSN without any code change**, by minting the token
externally and supplying it as a bearer token. What a first-class method would add is
convenience (no external minting), secret-at-rest handling, identity verification, and
re-acquisition during long runs — not a new capability class.

## 9. Coordination with #403

#403 adds bounded session recovery after a real 401, and explicitly requires that "a
successful bearer-only probe does not prove a cookie/CSRF processor session is valid".
Client credentials must not be folded into that recovery path:

- There is no session to warm, so `reauth: auto|confirm|never` is meaningless; a
  client-credentials profile should be created with `reauth: never` and JSN should refuse
  to launch a browser for it.
- Recovery for this method is a token re-exchange, not a replay of the failed request.
  Replaying a mutation after a fresh token is still a replay; #403's rule (only after a
  definitive 401, at most once) has to be the ceiling, and writes still need explicit
  per-operation eligibility.
- If #403's recovery is implemented, it needs a method dimension from day one, or
  client-credentials profiles will inherit browser-renewal semantics they cannot satisfy.

## 10. Recommendation: **defer**

Do not add a client-credentials auth path to `main` now. Reasons, in order of weight:

1. **The part that decides the value is unverified.** Whether a client-credentials token
   can drive JSN's processor/UI-session surfaces (`_warmSession`, `xmlhttp.do`,
   `xmlstats.do`, `sys.scripts.do`) is unknown, and those surfaces back `eval`, `scan`,
   `platform health` and update-set transfer. Shipping the method before that is known
   would produce a login that succeeds and then fails confusingly on a subset of commands.
2. **No instance was available to run the minimal proof of concept** the issue asks for.
   Every runtime claim here is documentation-plus-code reasoning; that is not enough
   evidence to add a permanent auth method with a security-sensitive secret.
3. **The headline benefit is already obtainable.** Non-human identity in CI works today by
   minting a client-credentials token externally and setting `SERVICENOW_OAUTH_TOKEN`
   (`auth.js:316`, `sdk.js:96`). The marginal value of a first-class method is
   convenience, not capability.
4. **Cost is not trivial for the maintainer.** A new method touches the authoritative-method
   matrix, credential keying, expiry branch, `auth status`, setup wizard, docs, and the
   #403 recovery design — with a permanent support surface across Xanadu→Brazil UI paths.

What to do instead (cost now, ordered):

- **Now, docs only**: a short section in the auth docs — "unattended CI with a
  client-credentials token" — showing the external mint (`POST /oauth_token.do`,
  `grant_type=client_credentials`) plus `SERVICENOW_OAUTH_TOKEN`, the 30-minute default,
  and the explicit warning that processor/UI-page commands may not work with it. This
  delivers most of the practical benefit at documentation cost and is honest about the
  boundary.
- **Next, a scoped POC issue** (requires a disposable sub-production instance and a
  non-admin application user): mint a token, then run, in order, (a) a table read,
  (b) `xmlstats.do`, (c) `xmlhttp.do` GlideAjax, (d) `sys.scripts.do` read, and record
  status codes and whether cookies/`X-UserToken` appear. Read-only; no mutations. That
  one page of results converts every "Low" in §6 into a fact.
- **Only then** re-open implementation with a live-verified matrix.

Effort if it is later justified (rough, from the code read): ~300–500 lines including
tests — `auth.js` (method branch, exchange, expiry re-acquisition, error taxonomy),
`credential-store` keying, `commands/auth.js` flags and `auth status` fields,
`commands/setup.js` wizard step, `AUTH_LIFECYCLE.md` + `DECISIONS.md` updates, and a
handful of `test/auth-*.test.js` cases. Ongoing maintenance is low-moderate: one token
exchange plus the version-path drift between System OAuth (≤Yokohama) and Machine
Identity Console (≥Zurich), which is documentation churn rather than code.

Implementation outline, if/when approved (no code in this spike):

1. `cli/src/auth/oauth.js`: `exchangeClientCredentials(instance, clientId, secret)` —
   form POST to `/oauth_token.do`, `grant_type=client_credentials`, bounded by the
   existing request timeout; returns `{access_token, expires_at}` from `expires_in`.
2. `cli/src/auth.js`: `client_credentials` in the method matrix; credential key
   `client:<client_id>@<instance>`; expiry branch re-exchanges instead of "login again";
   identity captured from one bounded GET after exchange; refuse `reauth` other than
   `never`.
3. `cli/src/sdk.js`: no new transport — reuse the `oauth` branch's
   `Authorization: Bearer`. Explicitly skip `_warmSession()` for this method until it is
   proven, so failures are legible instead of silently falling back to cookie paths.
4. `cli/src/commands/auth.js` / `setup.js`: flags, secret input by file/stdin/env only,
   non-TTY rules, `auth status` fields.
5. `docs/AUTH_LIFECYCLE.md`, `docs/DECISIONS.md`, and the research matrix above updated
   with live results.

Reject was considered and is wrong: the grant is a legitimate, documented platform
capability with a real operational benefit for machines; what is missing is evidence, not
merit.

## 11. Open questions (each blocks a confident "implement")

1. Can a client-credentials access token authenticate `/xmlhttp.do` and `xmlstats.do`,
   and does `_warmSession()` (`/angular.do?sysparm_type=get_user`) succeed with one?
2. Does `sys.scripts.do` ever accept a client-credentials token (any role/plugin)?
3. Is `Identity Type = Human` genuinely required only by the SDK installer processor, or
   does any JSN path (e.g. ATF, background scripts) require a human-type application user?
4. What is the real minimum role set for: table reads, `records aggregate` (PA role),
   ATF run, attachment upload, GraphQL?
5. Which release family first shipped the grant, and does the property exist implicitly
   (create-on-demand) or need an admin to create it in every case?
6. Does scope validation ("Allow access only to APIs in selected scope") interact badly
   with ATF's `/api/now/atf/...` endpoints and with `/api/now/stats/...`?
7. Does the existing 401 recovery path (#403) attempt a refresh on a client-credentials
   record, and how does it fail?

---

[^1]: ServiceNow Now SDK 4.14.0, "CI/CD integration", <https://servicenow.github.io/sdk/4.14.0/config/ci-integration> — read live 2026-11-04. States the `client_credentials` env-var contract, `/oauth_token.do` usage, absence of a refresh token, the property, the Application Registry path, and the SDK-installer admin/Human-type requirement.

[^2]: ServiceNow product documentation, "Client Credentials" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/client-credentials.html> — release Brazil, updated 2026-09-10. Property defaults to false; also documents adding the `OAuth Application User` field to the OAuth entity form.

[^3]: "Create the Client Credentials system property" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/create-cc-sys-prop.html> — role `oauth_admin`, plugin `OAuth 2.0`, property name/type/value.

[^4]: "Configure an OAuth Client credential grant" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/configure-an-oauth-client-credential-grant.html> — roles, Machine Identity Console path, scope validation, token restriction, token format, default 1800 s lifespan.

[^5]: "Add the OAuth Application User" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/add-oauth-application-user.html> — form-design step; requests are "passed for the associated OAuth Application User"; failure when unset.

[^6]: ServiceNow docs topic inventories for the Xanadu/Yokohama/Zurich/Australia/Brazil Platform-security release maps (`/api/khub/maps/<id>/topics`), checked 2026-11-04: `client-credentials` and `create-cc-sys-prop` topics exist in all five; `machine-identity-console` only in Zurich and later.

[^7]: "Revoke an OAuth token" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/t_RevokeOAuthToken.html> — `oauth_revoke_token.do?token=…`, endpoint requires no authentication, token marked expired.

[^8]: "Manage OAuth tokens" (Brazil), <https://www.servicenow.com/docs/r/platform-security/authentication/t_ManageTokens.html> — default 30-minute access token and 100-day refresh token lifespan when the instance is the OAuth provider; tokens stored in `oauth_credential`.
