# Auth and performance acceptance

These modules use the guarded acceptance context and Node's built-in test runner. Offline tests exercise orchestration and run the checked-out `cli/bin/jsn.js` against synthetic loopback HTTP fixtures. They do not prove live provider behavior.

## Auth fixtures and scenarios

`cli/test/acceptance/auth.mjs` exports eight scenarios:

| ID | Assertions or current blocker |
| --- | --- |
| `auth.fixtures` | Verified selected-profile OAuth bootstrap; domain observation; two owned users; explicit login settings; optional least-privilege roles and independent readback |
| `auth.basic-valid-permissions` | Actual Basic CLI login, exact current-user identity, allowed self read, denied update of the other owned account, unchanged independent OAuth readback, still-valid self read |
| `auth.basic-invalid` | Invalid generated Basic password rejected as authentication failure, followed by successful valid identity read |
| `auth.basic-rotation` | OAuth rotates the owned account password using a private file; old credential rejected; new credential independently authenticates. This is credential revocation, not UI-session expiry |
| `auth.basic-expired-session` | Blocked. The REST Basic boundary is stateless; proving cached SDK UI-session expiry needs a same-process CLI/UI operation and an approved exact-owned-session invalidation adapter |
| `auth.cookie-valid-permissions` | Blocked without real isolated browser acquisition. When provided, CLI gck login, exact non-admin current-user read and the same allowed/denied permission checks run |
| `auth.cookie-invalid` | Deliberately invalid header/cookie pair supplied through a private headers file must produce authentication rejection. This is not an expired-session claim |
| `auth.cookie-expired-renewal` | Blocked without a valid owned browser session, approved real expiry/readback and renewal adapters. Then checks stale-session rejection, CLI auth refresh from a new private headers file and exact current-user recovery |

A missing prerequisite throws an error with `status: 'blocked-prerequisite'` from the exported scenario wrapper. A runner that ignores returned scenario values therefore cannot accidentally count these blockers as passes.

### Account policy

The OAuth fixture path uses registered `users create --data-file`, `users update --data-file`, and `records create --table sys_user_has_role --data-file`. It does not alter production auth code. User names derive from the run-key digest and stay short. Passwords are generated in memory and written only to private 0600 payload files, never command arguments or artifact manifests.

Both accounts are active, unlocked, have no required password reset and are not internal integration users. The Basic account is web-service-only; the browser account is not. Default roles are explicitly empty. These targeted self-read/other-user-denial checks do not need admin. Optional `ctx.state.set('auth.config', { roles: ['itil'], domain: '<observed domain sys_id>' })` resolves role names independently and checkpoints each owned role link. Any requested administrative role, observed administrative inheritance, unreadable role identity or a full ten-row role-read bound fails closed. Do not grant admin to work around a failure.

Domain setup probes the `domain` table read-only. Explicit invalid-table evidence permits creation without a domain field. A readable domain table requires a configured domain observed by exact query before account creation. ACL/network ambiguity creates no accounts. A `sys_domain` dictionary field alone is never domain-separation evidence.

An allocated user ID is checkpointed before readback, role creation or further children. Role artifacts depend on the exact owned parent ID. The runner performs dependency-ordered exact-ID cleanup and independent absence readback. No prefix/table cleanup is provided. Ambiguous creation without an ID stops for reconciliation rather than retrying. Auth-generated payload/config/header files are deleted by scenario cleanup, and password/session memory references are cleared, including on failure and `--keep`. Raw command receipts remain private diagnostics; never publish them.

### Isolated credential environment

Each test identity has a private config/HOME/cache/data directory below the run output, with a profile having the same explicit runner profile name and guarded target. `options.env` clears ambient OAuth and instance-specific Basic precedence, and supplies generated Basic credentials privately. An empty run-owned PATH prevents `secret-tool` from accessing the desktop keyring. The runner must launch Node by its absolute executable path. No `SERVICENOW_INSTANCE_URL` override or target argument is supplied by this module.

The runner must validate these private directory/environment overrides narrowly against this run's fixture ownership, retaining its explicit profile/instance guards. Do not permit arbitrary target/config redirection. stdout/stderr may contain private account data from normal CLI output and must remain in 0600 private receipts; never spread them into the public report.

### Browser adapter prerequisite

No browser automation dependency or session acquisition implementation is included. Parent-approved isolated browser work can provide `ctx.state.set('auth.browserAdapter', adapter)` with:

- `acquire({ ctx, user, env })`: log into the newly created non-admin account in a dedicated isolated session. Register exact owned sessions and their user dependencies before returning. Return `{ source: 'isolated-browser-login', headersFile }`, with paired token/cookie headers in a non-symlink 0600 file beneath `user.root`.
- `expire({ ctx, user, session })`: invalidate only that exact registered session, independently verify expiry, and leave no personal sessions touched. Local file deletion or random token corruption does not count as expiry.
- `renew({ ctx, user, env })`: obtain another actual isolated login and register its attributable session cleanup. Return the same private file contract. The scenario executes the real `auth refresh --headers-file` path.

The source tag is an adapter contract, not evidence by itself. The parent must verify real acquisition, expiry and exact session cleanup before calling browser coverage live. Until that approved adapter exists these cases remain blocked, not finished. The suite never uses a personal browser session.

## Whole-suite performance hooks

`performance.mjs` exports `beginSuite(ctx)` and `endSuite(ctx)`. The integrated runner invokes begin after target preflight and before the first scenario, and end in `finally` after scenario execution, including failures/handled interruption. These are suite hooks, not per-scenario captures. The runner records every test duration using its monotonic clock, pins the actual CLI source revision/version and passes those timings to the public projection.

The hooks execute the registered commands through `ctx.command`:

```text
perf capture --label <run-key>-before --json
perf show <before-id> --json
# suite scenarios
perf capture --label <run-key>-after --json
perf show <after-id> --json
perf list --limit 1000 --json
perf compare <before-id> <after-id> --json
```

CLI storage is isolated by `JSN_DATA_HOME` beneath `performance-private/data`; normal selected OAuth credentials remain available for the parent live run. The capture schema is version 1 and requires all actual collector identities: `platform_health`, `transactions`, `error_warning_summary`, `event_queue`, `ecc_queue`, `flow_executions`, `record_counts`, `scheduled_and_cleanup`. Missing, duplicate, unknown or malformed collectors are visible failures, not empty successes.

Captures are instance observations. Transaction aggregates contain count and average/minimum/maximum response times, not percentiles. Queue/flow/record counts and node statistics are collected by the existing implementation. Dynamic metric names, node/user identities and collector reasons remain private. Successful capture with a failed collector is `incomplete`. Capture/compare/list errors remain visible in performance coverage but never create a performance release threshold or release gate.

Environment evidence records bounded `domain` table readability or explicit invalid-table absence and the source of that observation. Readability does not establish domain-separation activation. Effective auth, role and domain claims remain unknown when independent evidence is unavailable. No instance settings are toggled.

### Export contract

`publicSummary({ revision, version, timings, performance })` accepts the private state at `ctx.state.get('performance.suite')` and returns closed schema version 1:

- Exact full source revision and sanitized CLI version.
- Scenario `id`, monotonic `durationMs`, and one of `passed`, `failed`, `blocked`, `excluded`, `not-run`.
- Observational performance coverage, before/after collector names and statuses, and whitelisted environment traits.
- No username, instance/profile, raw command, credential, capture ID, error/reason text, provider metric labels, or raw capture.

Runner-specific detailed statuses must be mapped to the closed public outcome vocabulary before calling this helper. Raw state and command receipts are private. Capture JSON and SQLite db/WAL/SHM files are mode 0600 inside a 0700 run-owned directory. Export does not deploy a site, upload results or implement Rails ingestion.

## Offline checks

From `cli/`:

```bash
node --test test/acceptance-auth-perf.test.js
eslint test/acceptance-auth-perf.test.js test/acceptance/auth.mjs test/acceptance/performance.mjs
node --check test/acceptance/auth.mjs
node --check test/acceptance/performance.mjs
```

The tests deliberately reject invalid configuration/schema/provenance/timings, prove no fixture command after preflight refusal, fail wrong-identity and silently mutated denied-operation cases, check exact parent-before-child ownership and private projection, and execute real CLI users/perf commands on loopback. Normal OAuth session-bootstrap POSTs are distinguished from GET-only table/stats data collection. No live users or sessions are created by these checks. Live auth/ACL/settings/password/provider behavior, browser lifecycle and cleanup remain parent verification prerequisites.
