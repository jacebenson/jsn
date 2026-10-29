# Feature-specific connected PDI verification

Run 2026-10-29 at 04:46 UTC against main commit
`59a7875683b3aff5f9a5a76b1d85ab7d50b68c76`, containing the merged features below.
The shared verify doctor first passed with authenticated/verified `pdi` and a
successful probe. Its hostname and identity are deliberately omitted here.

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
node docs/verification/pdi-pr-proof.mjs pdi
```

The [reproducible proof script](pdi-pr-proof.mjs) and
[sanitized observations](pdi-pr-proof.json) retain feature-specific outcomes,
not credentials, private records, update-set names, record IDs or hostnames.
SDK lanes use existing credentials with refresh and UI-session warming disabled.
Ordinary CLI reads use the normal CLI. The shared doctor is test safety gating;
it is not an application requirement to run auth status before each operation.
The real profile configuration was unchanged and its credentials remained available.

## PR 329: authentication recovery

A safe metadata GET used one deliberately invalid bearer **in memory only**.
The PDI returned **401**. The SDK invoked one recovery callback, which selected
the existing valid scoped credential without changing stored auth. The same GET
was replayed exactly once and returned **200**, with one limited metadata row.
Observed sequence: `[401, 200]`; callback count: `1`; attempts: `2`.

This is a real PDI rejection and SDK transport-replay proof. The callback is an
in-memory credential source switch, not a real OAuth refresh or browser renewal.
Browser renewal, refresh failures and concurrent recovery remain fixture-covered;
no credential was revoked and no repeated failed login was induced.

## PR 330: logout approval, skill pairing and help

```text
$ node bin/jsn.js --profile pdi auth logout --json
exit: 1; code: confirmation_required
approval hint pins pdi and requires --force
credentials available before/after: true/true
profile retained: true
```

No `--force` was passed and no logout occurred. Help explains local clearing and
unaffected ServiceNow/Chrome sessions. Offline `skill show` matched the bundled
source; installation to a temporary directory with an **isolated temporary XDG
configuration** produced the exact bundled bytes. The scratch installation and
configuration were removed. This packaging check is local, not an instance test.
Approved credential deletion and subsequent reauthentication were intentionally
not exercised against the connected profile.

## PR 332: direct commands without mandatory auth preflight

```text
$ node bin/jsn.js --profile pdi records list --table sys_db_object --query name=incident --columns name --limit 1 --json
exit: 0; ok: true; result rows: 1
```

No separate `auth status` command was invoked for this operation. This proves the
ordinary direct-command path with existing authenticated credentials; PR 329's
separate test above proves actual 401 transport recovery.

## PR 333: scriptable setup discovery

Noninteractive `node bin/jsn.js setup --json` returned structured `usage_error`
with exit **2** and actionable explicit auth commands. `setup --help` documented
scriptable status and secure `--headers-file` input. Selected-profile
`auth status --local --json` returned one authenticated profile.

These are read-only checks against the configured PDI connection. New-profile
login, credential import, preference changes and connection removal were not
performed against the live configuration; their input/write paths remain
fixture-covered.

## PR 336: capture-context safeguard

The guard read the actual current context: **Global**, **named update set**,
**in progress**. It required no context approval and returned no diagnostics.
This read-only probe had no mutation handler, so no write could dispatch.

A separate [disposable CLI CRUD proof](pdi-crud-live.md) validates that ordinary
creates/updates and cleanup work in that real context. The test did not change
scope or select Default. Global + Default continue/cancel/override and
no-write-on-decline remain fixture-covered, not induced on the PDI.

## PR 337: local mutation history

Filtered history visibility returned retention **7 days**, with **0** matching
`sys_db_object` entries before and after a real read. SDK instrumentation observed
**0 mutation events** for GETs and the read-only batch envelope POST.

The separate [disposable CLI CRUD proof](pdi-crud-live.md) exercises real history
capture: exactly **3 successful create/update/delete** events match the single
test-created record's resolved ID and reason; final read confirms it was deleted.
No existing record was changed. Seven-day aging/pruning and failed/unknown write
outcomes remain fixture-covered in this validation, rather than claiming a read
proves those behaviors.

## PR 339: native Batch API support

The actual PDI used **native batch** for two GET subrequests. Both returned
**200**: limited metadata returned **1 row**, and its aggregate returned **count
1**. Counts were total **2**, successful **2**, failed **0**. Observed
`fallback_observed: false`; no SDK mutation-history event was emitted.

Native endpoint support is proven. Unsupported-endpoint fallback, malformed
responses and partial-failure coverage are fixtures; no such condition was
fabricated against the live instance. Earlier independent live proof is also
available in [sdk-batch-live-check.md](sdk-batch-live-check.md).
