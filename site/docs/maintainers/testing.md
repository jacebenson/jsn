---
title: Maintainer testing and parity reports
---

Source-only test audits, CI acceptance and historical parity reports. Evidence, not current public guidance.

## Behavior-first test audit

Issue [#365](https://github.com/jacebenson/jsn/issues/365), reviewed against
`73fb796` on 2026-10-29. This is a bounded pilot and safety/auth review, not a
claim that every suite has been audited. Keep `node:test`. The proposed 50-test
goal is abandoned: there is no count ceiling, deletion percentage, or coverage
quota. Count changes below describe the result, not a target.

## Combined audit scope

The completed review inventories all **153 tracked test files** on this base:
17 safety/authentication files below, 31 in [the CLI/SDK report](testing.md#cli-and-sdk-test-audit--issue-365),
and 105 in [the remaining-suite report](testing.md#remaining-suite-test-audit-issue-365). The manifests
are disjoint and their union matches the tracked suite. Every file received
source screening; candidate changes received detailed test/production review.
This does not establish exhaustive behavior or mutation coverage. The earlier
116-file count described an older checkout and is superseded by this inventory.

All changes are test or contributor-guidance changes. Keep the suite's
meaningful scenarios rather than reducing it to a predetermined size.

| Area | Files reviewed | Cases before | Cases after |
| --- | ---: | ---: | ---: |
| Safety/authentication and pilot | 17 | 249 | 239 |
| CLI/SDK | 31 | 326 | 321 |
| Remaining suite | 105 | 1,063 | 1,051 |
| Total | 153 | 1,638 | 1,611 |

The clean baseline executed 1,638 cases: 1,636 passed, two skipped, no failures.
The final combined run executed 1,611 cases: **1,609 passed, two skipped, no
failures**, with full-tree ESLint and diff checks passing. A per-file event
reporter measured the final partition above; original registrations and the
verified change deltas reconcile the safety/remaining baseline partitions with
the whole-suite baseline. CLI/SDK also had an independently executed baseline.
The same integration gates remain skipped; their internal live cases were not
executed. Baseline/final full-run durations were 154.7/82.9 seconds, but differing
concurrent host load makes these diagnostic samples, not a speedup claim.

## Upstream examples examined before updating AGENTS.md

| Source | Concrete pattern to adopt | What not to import |
| --- | --- | --- |
| [yargs helper tests](https://github.com/yargs/yargs/blob/main/test/helpers.mjs) | The `applyExtends` tests assert merged configuration and reject prototype pollution; check useful results and negative side effects at the helper boundary. | Do not copy Mocha/Chai or assume every internal helper needs an export/type assertion. |
| [oclif parser error tests](https://github.com/oclif/core/blob/main/test/parser/error-codes.test.ts) | A shared `runCommand` helper exercises real command parsing, verifies error exit codes, and fails explicitly if a command unexpectedly succeeds. Distinguish default and configured behavior. | Its Cache prototype stub is framework-specific; avoid making JSN's incidental private structure a contract. |
| [npm ping tests](https://github.com/npm/cli/blob/latest/test/lib/commands/ping.js) | Shared mock-NPM and registry fixtures exercise command output, JSON shape, malformed responses, and unreachable-registry errors without a real registry. | Do not adopt tap or a universal coverage threshold merely to match npm. |
| [Prettier fixture runner](https://github.com/prettier/prettier/blob/main/tests/config/format-test/run-format-test.js) | Normalize fixture context once and run every fixture through a shared runner, preserving parser/options distinctions and explicit error fixtures. | Do not import a formatter-sized runner or snapshot everything; JSN's small tables can share setup while retaining explicit expectations. |

These lessons inform the contract/layer/fixture/failure/verification recipe in
`AGENTS.md`. No framework migration or new test dependency is needed.

## Implemented changes and retained coverage

| File | Cases before → after | Decision and remaining coverage |
| --- | --- | --- |
| `test/unit.test.js` | 8 → 5 | Remove export-only and duplicate trailing-slash checks; SDK construction and slash normalization remain in `sdk-client.test.js`. Remove the prototype-name blacklist: no matching documented invariant was found, and SDK has real domain operations already. Keep public method availability in SDK tests. Replace keyring-dependent boolean-type auth check with injected stored credentials and exact available/missing outcomes. Keep URL normalization, constructor defaults, HTML script output, and no-instance authentication. |
| `test/helpers.test.js` | 25 → 24 | Share JSON-file setup for simple typed data and exact multiline script text, with labeled deep equality for both and guaranteed cleanup. All seven write-back cases are unchanged. |
| `test/auth-manager-basics.test.js` | 5 → 4 | Remove the misleading PKCE test that only checks `httpClient` exists. Real URL/token-exchange coverage is strengthened below. Exact authentication true/false checks remain. |
| `test/auth-oauth.test.js` | 4 → 3 | Merge duplicate default-URL/type-length assertions into parsed URL expectations. The same case now captures a mocked token exchange and independently hashes the exchanged verifier to verify the emitted S256 challenge. Profile-concurrency and hostname-normalization cases remain. |
| `test/sdk-client.test.js` | 19 → 17 | Remove export-only and prototype-name blacklist checks. Actual SDK construction, requests, auth, script outputs/failures, uploads, export transport and public method availability remain. |
| `test/auth-command.test.js` | 11 → 10 | Remove export-only check; the next tests construct the command and verify registration, and auth handler/workflow suites exercise it. |
| `test/updatesets.test.js` | 25 → 24 | Remove export-only check; command registration, resolver behavior, detail formatting and actual export handlers remain. Completion/readback and fallback suites are untouched. |

The pilot's 33 cases become 29, with 370 → 316 lines of test code. Across all
seven changed files, 97 cases become 87 and 1,525 → 1,437 lines. Loops inside
one test still exercise multiple scenarios; reducing declarations is not evidence
of reducing behavior coverage. No production code changed.

Safety review also included `mutations`, `capabilities`, `auth-credentials`,
`auth-shared-workflow`, `auth-creds`, `confirm-delete`, `updatesets-resolve`,
`updatesets-complete`, `usability-safety-group-mutations`, and `security` test
files. The 17 owned files contain 249 registered cases before and 239 after,
including 19 generated/ordinary group-mutation cases. This source-derived
inventory is distinct from an executed whole-suite result.

Retain distinct scenarios for credential identities, method precedence,
redaction, read-only and alias middleware, force/profile confirmation policy,
unsafe query identifiers, update-set scope fallbacks, denied/cancelled writes,
unreadable descriptions, platform-dropped fields and failed readback. Helper
coverage alone cannot replace command-level proof that denied operations do not
write. No auth, confirmation, update-set or write-back safety cases were removed.

## Verification

The pilot passed 33/33 before and 29/29 after using Node 24.19.0:

```bash
node --experimental-test-module-mocks --test --test-isolation=none \
  --test-reporter=tap test/unit.test.js test/helpers.test.js
```

One local sample was 165 ms before and 108 ms after; this is noisy diagnostic
data, not a performance claim. Seven changed files also passed together with
normal process isolation. This environment's sandboxed process-isolated reporter
summarized files instead of individual cases, so that result is seven passing
files, not seven total cases. Independent no-isolation runs can expose case
counts; do not run all module-mocked suites together without isolation.

The parent ran the full non-live suite outside the sandbox with isolated
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME`: 1,628 tests, 1,626 passed, two skipped,
zero failures, 162.6 seconds. Cached ESLint passed for `src/ bin/ test/`.
The parent also ran clean-main baseline with isolated configuration: 1,638 tests,
1,636 passed, two skipped, zero failures, 154.7 seconds. Before/after whole-suite
runs overlapped other work; neither those times nor the pilot sample establish
a speed improvement. A sandboxed run encountered local-server/process
restrictions and is excluded from the comparable baseline.
Tests that create real ServiceNow records were not run.

## Prioritized follow-up review

1. **Safety proof before shortening tests.** Strengthen the group read-only CLI
   cases with a controlled transport/request spy: currently they assert a
   read-only error and absence of lookup errors, which is weaker than directly
   proving no request. Preserve primary and alias command paths.
2. **Document or replace architecture checks.** `auth-credentials.test.js` scans
   command source for credential-method spellings. Decide whether this is a
   deliberate boundary invariant and document why, or replace it with a setup
   workflow proving identity-preserving persistence through injected AuthManager.
   Existing injected-store and shared-workflow tests are useful context, not an
   automatic justification for deletion.
3. **Consolidate mutation examples cautiously.** `mutations.test.js` repeats
   catalog create/list assertions across default and explicitly derived paths.
   Preserve generation and classifier boundaries, old invalid command spellings,
   list/show negatives and trailing positional arguments when sharing cases.
4. **Reduce fixture duplication separately.** Auth tests repeat temporary config,
   environment and credential-store fixtures. Extract only narrow stable seams;
   retain cleanup and same-instance/profile identity distinctions. SDK constructor
   and script examples still overlap between unit and SDK suites; decide their
   owner in a later focused pass rather than expand this pilot further.
5. **Reconcile the remaining suite inventories.** Apply each area audit's concrete
   evidence in separate changes, report actual executed counts, skips and runtime,
   and review output changes deliberately. Do not extrapolate this pilot's ratio.

The separate flow-editing/update-set capture issue #295 remains out of scope.

## CLI and SDK test audit — issue #365

Audited against `73fb7962be0ded60d9e234720538bc5e0d12260f` (main, package 4.3.13).
This review covers the 31 files below, including their fixture setup, assertions and
relevant production seams. The auth/safety audit owns `capabilities.test.js`,
`helpers.test.js`, `unit.test.js` and `sdk-client.test.js`; the remaining-suite
audit owns `customizations-command.test.js`. The upgrade command is absent on this base.
No live-instance tests were enabled and no production code changed.

### Measurements

| Measure | Before | After |
| --- | ---: | ---: |
| Owned test files | 31 | 31 |
| Static `test(...)` / `it(...)` declaration sites | 263 | 258 |
| Expanded cases observed by the runner | 326 | 321 |
| Lines in owned test files | 4,527 | 4,519 |

Declaration sites are **not executed cases**: loops generate additional tests,
while inline loops exercise several inputs inside one case. Five registrations
were removed: two export-only checks and three repeated completion-script
registrations. No behavior scenario was removed. Expanded cases were measured outside the restricted sandbox with the same
31-file manifest. Baseline: 325 passed, 1 skipped, 0 failed; initial changed run:
319 passed, 1 skipped, 1 existing host-time flake. The flake is addressed below.
Concurrent-run durations were 86.926s before and 85.361s after; these are
diagnostic measurements, not evidence of a performance improvement. Sandbox
file-level failures were excluded from the expanded counts.

### Implemented findings

- `test/completion.test.js:41`: four tests invoked the identical
  `jsn completion` path. One was an exact duplicate of marker/exit assertions.
  Combine their checks in one invocation: successful exit, both markers,
  function name, shell registration and no context/update banners. Prefix,
  alias, subcommand, option, install-help and hidden-command regressions stay
  separate. This removes three CLI subprocess launches.
- `test/cli-adapter.test.js:88`: checking that `completionFilter` is a function
  did not establish that custom completion results reach stdout. Capture output
  and require both `records` and callback-provided `related`; retain current
  token and argv compatibility checks. Restore stdout even on failure.
- `test/docs-command.test.js:13`: remove the export-only case; constructing and
  exercising `docsCmd` in the remaining tests already fails if it is missing or
  unusable. The purported empty-install status test only checked types and
  consulted ambient documentation paths. Give it its own data/cache directory
  and assert `not downloaded` plus false download/index/embedding flags. Remove
  its unused first builder pass. Report a missing prior index as an explicit
  skip in the opt-in incremental-sync test rather than a silent pass.
- `test/setup.test.js:10`: remove the export-only test; command construction and
  the separate zero-profile handler test cover the usable export. Two switch
  tests previously selected the already-active `dev` profile and the second
  only asserted a truthy result. Cover ambiguous noninteractive selection
  failing without changing the profile, then explicitly switch `dev` to `prod`
  and verify active/default values in memory and persisted config. Clean each
  fixture directory after restoring cwd/environment.

- `test/sdk-processflow-actions.test.js:391`: a concurrent validation run exposed
  an existing CPU-load flake in the `<500ms` host wall-clock assertion (679ms).
  Model the context read consuming the 30ms budget with an automatically restored
  clock mock, require exactly one context poll, and preserve per-request timeout,
  context error and single-dispatch/no-cancellation checks. This verifies deadline
  behavior without making machine scheduling a pass condition.

### Per-file assessment

Line references describe this branch unless noted. Keep means no justified
coverage removal or rewrite identified, rather than a claim of exhaustive
mutation testing.

| File | Assessment and evidence |
| --- | --- |
| `test/actions-root-help.test.js` | Keep both styled and JSON root cases (lines 21, 30): the same command inventory serves distinct terminal/script consumers. |
| `test/cli-adapter.test.js` | Rewrite completion callback output (line 88); keep nine parser cases: option coercion, positional/default handling, global value consumption, nested help and failure behavior cover distinct contracts. |
| `test/cli-e2e.test.js` | Keep production pipe/boolean/array probes and selector conflict boundary (lines 65–194). They exercise the real entry point, unlike adapter unit tests. Preserve opt-in read-only/delete/injection cases without running them. |
| `test/command-aliases.test.js` | Keep `cs` and `pages` ownership regressions (lines 11–26). Alias metadata is consumed by dispatch/completion; these assert documented collision choices, not only export shape. |
| `test/command-audience.test.js` | Keep three cases: role resolution, account scoping and real CLI help/discovery/completion filtering (lines 14–65). Explicit hidden command access is intentionally retained. |
| `test/command-discovery.test.js` | Keep seven cases (lines 18–89), including registration replacement and profile metadata changes. Skill-text checks protect shipped agent guidance; they do not inspect production JavaScript syntax. |
| `test/completion.test.js` | Consolidate repeated script-generation path; preserve ten registrations covering distinct completion/help inputs. |
| `test/diff-command.test.js` | Keep five cases: equal raw references, changed/missing fields, missing record, forbidden state, read-only capability (lines 45–113). Forbidden must remain distinct from empty/equal. |
| `test/docs-command.test.js` | Remove export-only check, strengthen empty-state assertion and isolate paths, remove dead mock-builder pass, explicitly skip missing integration prerequisite. Keep registration, incremental-sync and listener cases. |
| `test/flow-versioning.test.js` | Keep three cases (lines 30–59): exact new version, stale/unreadable result and multiple concurrent candidates. Similar version rows encode different verification risks. |
| `test/flows-command.test.js` | Keep command-handler tests distinct from SDK inspection tests: output envelopes, interactive selection, manifest preview, confirmation, publish action routing, status and doctor table contracts (lines 53–370). |
| `test/forms-metadata-cli.test.js` | Keep HTTP fixture case (line 17): selected profile/auth, structured and styled metadata, extraction, bounded metadata reads and one-read generic get are one cross-layer regression. |
| `test/graphql-command.test.js` | Keep handler parsing/validation and transport cases (lines 23–137). Handler mocks cannot establish actual authenticated request serialization, so transport coverage is complementary. |
| `test/manifest-help.test.js` | Keep two real CLI help cases (lines 15–26). They protect schema-discovery instructions and avoid misleading hardcoded schema examples. |
| `test/midserver-remote-cli.test.js` | Keep remote dispatch/ownership/approval cases (lines 57–155): identical loops vary runtime or identity; no equivalent cases were proven redundant. Private SDK stubs model approval ordering, not a requirement on source syntax. |
| `test/mutation-context-cli.test.js` | Keep JSON/quiet guard cases and forced/ordinary create plus REST read-only boundaries (lines 35–65). The formats and approval states represent different externally observed contracts. |
| `test/output.test.js` | Keep OSC8, format methods, header suppression, numeric cells, preformatted replacement, stamped records, relationships and newline variants (lines 4–160). Trailing-newline variants protect a real output boundary. |
| `test/perf-command.test.js` | Keep five output cases (lines 81–168): capture/list/show/compare/top produce different envelopes and data. The existing 1.1s wait prevents timestamp-derived fixture ID collision; changing that requires separate fixture design. |
| `test/records-rest-help.test.js` | Keep two cases (lines 17–32): list picker examples and REST read-only policy are shipped user guidance contracts. |
| `test/sdk-batch.test.js` | Keep request/status/auth/fallback/chunking/malformed-response/no-replay cases (lines 33–161). Looped HTTP statuses distinguish unsupported endpoints from rejection; do not collapse them into fewer tested inputs. |
| `test/sdk-flows.test.js` | Keep decoding, hydration, public inspection, fallback, caching/depth and JSON-shape cases (lines 7–413). Retain the explicit narrow export-surface invariant (line 353; `site/docs/maintainers/domain-model.md:313`): public inspection is the supported seam and internal formatting helpers should stay private. SDK and command tests catch different serialization boundaries. |
| `test/sdk-processflow-actions.test.js` | Rewrite the host-time timeout assertion deterministically; keep full-definition, identity/scope, readback, partial-write, output/schema and protected-ID cases (lines 54–542). Repeated mismatch tables vary independent nested constraints; removal could permit a verified-success claim after data loss. |
| `test/sdk-request-contract.test.js` | Keep four transport contracts (lines 10–69): JSON/text/raw-response shapes, headers, bootstrap policy, error normalization and response-body timeout differ intentionally. Private auth setup is fixture control; policy checks warrant preservation pending a dedicated end-to-end rewrite. |
| `test/setup-hub.test.js` | Keep menu inventory and distinct q/Escape key paths (lines 20–42). Keyboard cancellation is behavior, not a duplicate export check. |
| `test/setup-parity.test.js` | Keep canonical browser-session workflow parity (line 14), including secret redaction, early rejection/no config mutation and retained profile preferences. It covers real CLI routing beyond unit dispatch. |
| `test/setup-wizard.test.js` | Keep isolated module-mock case (line 16): no-profile wizard routing and optional-doc prompt cannot share the already-imported setup module used in hub tests. |
| `test/setup.test.js` | Remove export-only case; replace duplicated active-profile switch input with ambiguous-selection failure and real named switch/persistence checks. Keep remove/modify dispatch cases. |
| `test/skipped-updates-command.test.js` | Keep five cases (lines 24–79): one extractable envelope, interactive review, exact preview/refused confirmation, extraction and automation refusal. Multiple preview/outcome envelopes are intentional for guided processing. |
| `test/update-set-transfer-commands.test.js` | Keep export naming/no overwrite/no mutation, conflicting output early failure, reopen allowed/refused states and import confirmation (lines 27–61). Distinct state inputs must remain. |
| `test/usability-output-contract.test.js` | Keep parse/handler format matrix, parent/root discovery, falsy extraction and token ownership (lines 74–565). Private tree assertions justify deliberate adapter invariants and guard the handler-less fallback fixture. No equivalent public-only coverage was proven sufficient for safe deletion. |
| `test/version-channel.test.js` | Keep three cases (lines 7–48): installed-channel selection, registry failure tolerance and dev update messaging. The filesystem stub supplies installed version; no source-text assertion. |

### Validation boundary

Required semantic discovery was attempted with `jg-openai`; this sandbox blocks
its loopback socket with `PermissionError`, so the audit used direct source reads.
The local Git fetch also failed DNS; the parent verified the base against GitHub.

Changed-file ESLint and `git diff --check` pass. Direct execution of the adapter
file passes 9/9 and setup passes 5/5; docs passes its three offline cases, skips
incremental sync and fails only its local listener with `listen EPERM`. The
sandbox's `node --test` invocation reports file-level failures rather than usable
expanded-case counts. These are environment limits, not a passing full-suite
claim. Parent execution outside that restriction measured the expanded counts
above and passed full ESLint. After the deterministic clock rewrite, direct
execution of `sdk-processflow-actions.test.js` passes all 86 cases (0.392s); an
explicit no-DELETE assertion was then added alongside the single-POST check.
Final combined validation passed all 1,611 cases apart from the two unchanged
integration skips (1,609 passed, zero failures). This area's per-file runner
counts were 321 cases: 320 passed and one skipped. Full-tree ESLint and diff
checks passed. The earlier standalone full run also passed: 1,631 passed,
two skipped, zero failures. See the combined table in `TEST_AUDIT.md`.

## Remaining-suite test audit (issue #365)

### Snapshot and scope

Base: `73fb7962be0ded60d9e234720538bc5e0d12260f` (main, version 4.3.13).
The tracked suite contains **153 `test/**/*.test.js` files**. The earlier 116-file
figure came from an older local checkout and is not the scope of this review.
This review owns **105 files**, disjoint from the 31-file CLI/SDK review and
17-file safety/authentication review. The complete owned manifest is below.

All 105 files received a source screening of test declarations, assertion types,
fixtures and setup, including generated cases, live-test gates, source-text
checks and apparent overlap. Candidate removals and the inspection rewrite
received detailed body/source review. The remaining files received varying depth
of review; this is a redundancy and assertion-quality audit, not a claim that
every assertion or production branch was independently proven correct. Static
call-site counts are 981 before and 971 after (regex count of `it(`/`test(` call
sites, excluding `.test(` methods); these are **not executed-case counts**.

### Changes and surviving coverage

- Remove standalone export/existence checks from App, ATF, approvals, CMDB,
  domains, groups/groupmembers/grouproles, records, scopes and tickets.
  The neighboring tests instantiate the same class/factory and exercise its
  observable command surface or handler behavior. Removing these 11 generated
  cases does not remove a supported command scenario.
- Remove the records test that constructed and read back a local
  `URLSearchParams` without calling production code. Keep actual records
  handlers, real transport/resolution tests, query injection rejection and
  relationship rendering coverage.
- Remove `auth status should not throw`, which ended in `assert.ok(true)`.
  Keep JSON diagnostics, identity routing, read-only probes, redaction,
  credential-source classification and no-profile scenarios in the same file.
- Replace four helper/export-only inspection assertions with five behavioral
  cases: direct sys_id without a lookup; bounded number lookup; missing record;
  injection rejection before reads; and assembled audit history/business rules
  with graceful absence of Flow Designer. Strengthen the retained empty-output
  formatter case to check explicit absence messages and the selected identity.

The changes remove 13 redundant executed cases and add a net one case through
inspection's five-to-six rewrite: **net reduction 12 cases**. This is based on
specific surviving contracts, not a reduction target. Test-file count stays 153.
Owned test lines change from **17,145 to 17,096** (49 fewer lines).

### Retained areas and boundaries

Keep distinct flow creation, checkout, lease release, publish, activation,
readback, trigger and execution scenarios. Similar looking assertions exercise
different state transitions or provider responses. Keep MID installation and
lifecycle cases separated by OS, controller, ownership, uncertain outcomes and
credential redaction; mocked platform variants are not host-platform proof.
Keep record metadata, ACL gaps, bounded fanout, related counts and actual HTTP
fixtures: empty, unavailable and denied results have different user meanings.
Keep Basic/OAuth/browser authentication methods, concurrent recovery, selected
identity and negative confirmation paths separate. Keep docs snapshot recovery,
active-reader protection, SQLite persistence, downloaded artifact integrity,
release-channel policy and local resource cleanup scenarios.

The two source-text assertions in `esc-cancellation.test.js` remain deliberately:
one enforces the centralized prompt import boundary and one checks the visible
Escape guidance. Keyboard-level cancellation tests in that file provide the
behavioral proof; the source checks are not a substitute for them. Converting
the picker guidance check to terminal output would require a dedicated fixture,
so this pass does not delete it merely because it reads source.

The opt-in `integration.test.js` and other live gates remain unchanged and were
not run against an instance. Its update case has a weak `assert.ok(true)` after
an awaited update; the adjacent readback checks existence rather than field
values. A disposable fixture already exists, so these are candidates for a
separate live-test improvement and validation. This offline audit does not prove
live persistence. No live records were created, updated or deleted by this audit.

A source-review follow-up is `records/inspect.js`'s use of display-first
`getStringField` for a resolved `sys_id`. Its normal lookup requests plain values;
a synthetic response containing different `value` and `display_value` selects
the display value. This pass verifies the normal Table API response and records
the edge case rather than changing production semantics under test cleanup.

### Validation

Before edits, an isolated unmodified full-suite run completed with integration
tests disabled, daily checks disabled, and unique XDG config/cache directories:
**1,638 cases, 1,636 passed, 0 failed, 2 skipped; 244 suites; 154,685.64112 ms**.
The run used the suite script's private mutation-history data directory.
The two skipped cases are live integration suite gates, not 34 individually run
integration cases. Earlier failing counts from a different checkout/environment
are superseded by this clean baseline.

The local sandbox cannot bind loopback sockets. `jg-openai` failed at its local
adapter socket, so discovery continued by direct reads. An attempted sandbox
full run was interrupted after socket-dependent failures and is not used as a
case baseline. Parent runs with working local sockets supply full-suite evidence.
The changed 11 files passed the local Node runner (11 file-level results); a
direct `node test/inspect.test.js` run passed all six inspection cases. File-level
results are not presented as the number of individual cases.

Parent full-tree ESLint passed. The standalone post-change full suite passed:
1,626 cases, 1,624 passed, two skipped, zero failures (114.1 seconds).
After consolidating all three audits, the full suite passed 1,609 cases with two
skipped and zero failures (1,611 total). Per-file reporting measured this area's
1,051 cases: 1,050 passed, one skipped. The 1,063-case original partition follows
from those registrations plus the verified net reduction of 12, and reconciles
with the clean whole-suite baseline. See `TEST_AUDIT.md` for all areas.

The PR's Windows matrix subsequently exposed an existing portability error in
the packaged-skill lifecycle fixture: Node's `--import` was passed an absolute
drive path rather than a file URL. The fixture now uses `pathToFileURL`, keeping
the offline preload and lifecycle assertions intact. This adds no test case or
production change; its focused tests and lint pass, with Windows verification
provided by the PR matrix.

### Owned file manifest

`Retain` means no justified removal or rewrite was established in this pass; it
does not mean complete coverage or independent validation of every branch.

| Test file | Before lines | After lines | Decision |
| --- | ---: | ---: | --- |
| `test/actions.test.js` | 296 | 296 | Retain |
| `test/aggregate.test.js` | 79 | 79 | Retain |
| `test/app-context.test.js` | 66 | 60 | Remove redundant assertion case(s) |
| `test/approvals.test.js` | 235 | 230 | Remove redundant assertion case(s) |
| `test/atf.test.js` | 336 | 331 | Remove redundant assertion case(s) |
| `test/attachments.test.js` | 104 | 104 | Retain |
| `test/auth-direct-command.test.js` | 153 | 153 | Retain |
| `test/auth-escape.test.js` | 62 | 62 | Retain |
| `test/auth-login-options.test.js` | 105 | 105 | Retain |
| `test/auth-login.test.js` | 293 | 293 | Retain |
| `test/auth-logout.test.js` | 70 | 70 | Retain |
| `test/auth-output.test.js` | 122 | 122 | Retain |
| `test/auth-profile.test.js` | 337 | 337 | Retain |
| `test/auth-recovery.test.js` | 454 | 454 | Retain |
| `test/auth-root-help.test.js` | 37 | 37 | Retain |
| `test/auth-status-view.test.js` | 93 | 93 | Retain |
| `test/auth-status.test.js` | 1009 | 987 | Remove redundant assertion case(s) |
| `test/auth-workflow-e2e.test.js` | 125 | 125 | Retain |
| `test/browser-auth.test.js` | 167 | 167 | Retain |
| `test/browser-launch.test.js` | 185 | 185 | Retain |
| `test/catalog.test.js` | 319 | 319 | Retain |
| `test/cmdb-list.test.js` | 63 | 58 | Remove redundant assertion case(s) |
| `test/cmdb-relationships.test.js` | 204 | 204 | Retain |
| `test/cmdb-show.test.js` | 118 | 118 | Retain |
| `test/codesearch.test.js` | 94 | 94 | Retain |
| `test/community.test.js` | 130 | 130 | Retain |
| `test/config.test.js` | 205 | 205 | Retain |
| `test/context-selection.test.js` | 122 | 122 | Retain |
| `test/customizations-command.test.js` | 112 | 112 | Retain |
| `test/customizations-report.test.js` | 58 | 58 | Retain |
| `test/customizations.test.js` | 482 | 482 | Retain |
| `test/decision-table-crud.test.js` | 220 | 220 | Retain |
| `test/decision-table-inspection.test.js` | 600 | 600 | Retain |
| `test/docs-db.test.js` | 123 | 123 | Retain |
| `test/docs-hrr.test.js` | 25 | 25 | Retain |
| `test/docs-install-choice.test.js` | 60 | 60 | Retain |
| `test/docs-search.test.js` | 64 | 64 | Retain |
| `test/docs-snapshot-recovery.test.js` | 152 | 152 | Retain |
| `test/docs-snapshot.test.js` | 75 | 75 | Retain |
| `test/domains.test.js` | 60 | 55 | Remove redundant assertion case(s) |
| `test/errors.test.js` | 146 | 146 | Retain |
| `test/esc-cancellation.test.js` | 98 | 98 | Retain |
| `test/essential-records.test.js` | 96 | 96 | Retain |
| `test/eval-modes.test.js` | 106 | 106 | Retain |
| `test/eval.test.js` | 101 | 101 | Retain |
| `test/features.test.js` | 163 | 163 | Retain |
| `test/field-pairs.test.js` | 208 | 208 | Retain |
| `test/field-troubleshooting.test.js` | 49 | 49 | Retain |
| `test/flow-create.test.js` | 681 | 681 | Retain |
| `test/flow-designer-interactive.test.js` | 394 | 394 | Retain |
| `test/flow-designer-pty.test.js` | 131 | 131 | Retain |
| `test/flow-publish.test.js` | 358 | 358 | Retain |
| `test/flow-published-edit.test.js` | 367 | 367 | Retain |
| `test/flow-real-action-inputs.test.js` | 106 | 106 | Retain |
| `test/flow-safe-edit.test.js` | 66 | 66 | Retain |
| `test/flow-test.test.js` | 134 | 134 | Retain |
| `test/flow-triggers.test.js` | 227 | 227 | Retain |
| `test/frontmatter.test.js` | 111 | 111 | Retain |
| `test/groups.test.js` | 51 | 48 | Remove redundant assertion case(s) |
| `test/guard-errors.test.js` | 120 | 120 | Retain |
| `test/impact-analysis.test.js` | 31 | 31 | Retain |
| `test/inspect.test.js` | 34 | 65 | Rewrite inspection behavior |
| `test/integration.test.js` | 379 | 379 | Retain |
| `test/logs-snippets.test.js` | 79 | 79 | Retain |
| `test/mid-direct-progress.test.js` | 156 | 156 | Retain |
| `test/mid-direct-wizard.test.js` | 65 | 65 | Retain |
| `test/midserver-diagnostics.test.js` | 90 | 90 | Retain |
| `test/midserver-direct.test.js` | 171 | 171 | Retain |
| `test/midserver-install.test.js` | 106 | 106 | Retain |
| `test/midserver-linux-remote.test.js` | 162 | 162 | Retain |
| `test/midserver-remote-recipe.test.js` | 37 | 37 | Retain |
| `test/midserver-remote.test.js` | 199 | 199 | Retain |
| `test/midserver-windows-remote.test.js` | 223 | 223 | Retain |
| `test/midservers.test.js` | 134 | 134 | Retain |
| `test/mutation-context.test.js` | 81 | 81 | Retain |
| `test/mutation-history.test.js` | 170 | 170 | Retain |
| `test/npm-deprecation.test.js` | 120 | 120 | Retain |
| `test/perf.test.js` | 177 | 177 | Retain |
| `test/performance.test.js` | 98 | 98 | Retain |
| `test/platform.test.js` | 135 | 135 | Retain |
| `test/prompts.test.js` | 38 | 38 | Retain |
| `test/raw-rest.test.js` | 31 | 31 | Retain |
| `test/record-metadata.test.js` | 233 | 233 | Retain |
| `test/record-profiles.test.js` | 69 | 69 | Retain |
| `test/records-engine.test.js` | 182 | 182 | Retain |
| `test/records-performance.test.js` | 20 | 20 | Retain |
| `test/records.test.js` | 186 | 165 | Remove redundant assertion case(s) |
| `test/related-lists-http.test.js` | 57 | 57 | Retain |
| `test/related-lists.test.js` | 168 | 168 | Retain |
| `test/resolve-record.test.js` | 193 | 193 | Retain |
| `test/resource-cleanup.test.js` | 44 | 44 | Retain |
| `test/scopes.test.js` | 176 | 171 | Remove redundant assertion case(s) |
| `test/session.test.js` | 224 | 224 | Retain |
| `test/skill.test.js` | 230 | 230 | Retain |
| `test/skipped-update-provider.test.js` | 32 | 32 | Retain |
| `test/skipped-updates.test.js` | 171 | 171 | Retain |
| `test/smoke.test.js` | 17 | 17 | Retain |
| `test/specialized-related.test.js` | 87 | 87 | Retain |
| `test/tickets.test.js` | 38 | 35 | Remove redundant assertion case(s) |
| `test/transactions.test.js` | 122 | 122 | Retain |
| `test/update-set-import.test.js` | 124 | 124 | Retain |
| `test/updatesets-create-scope.test.js` | 95 | 95 | Retain |
| `test/usability-safety-count-failure.test.js` | 117 | 117 | Retain |
| `test/usability-safety-prompt-gating.test.js` | 368 | 368 | Retain |
| `test/users.test.js` | 149 | 149 | Retain |

## Mutation testing

From the repository root, install with `npm --prefix cli ci`, then run
`npm --prefix cli run test:mutation`. Paths below are relative to `cli/`.
Use the current Node.js LTS release for development tools as well as the CLI. Dependency engine requirements still apply.

The default mutates only `src/mutations.js`, the classifier used by the read-only-profile guard. It runs these existing offline tests with Node's test runner:

- `test/mutations.test.js`
- `test/usability-safety-group-mutations.test.js`

The second file also exercises the real CLI with disposable configuration and fake instance addresses. The command does not select live integration tests. No ServiceNow credentials are needed.

Stryker uses its built-in command runner. Each mutant reruns the selected tests, including CLI subprocesses. Coverage analysis is off because this runner cannot provide per-test coverage. Keep the selection small instead of running the full suite for every mutant.

Open `reports/mutation/mutation.html` to inspect changed expressions and survivors. Machine-readable results are in `reports/mutation/mutation.json`. Generated reports and sandbox files are ignored by Git. Reports stay local; no dashboard upload is configured.

This is opt-in, not a CI gate. The break threshold is zero until there is an agreed baseline. Review survivors for meaningful missing behavior before adding tests; equivalent mutations and initialization overwritten before use can survive without exposing a defect. Timeouts count as detected mutations in Stryker's score, so report killed, timed-out, and surviving counts separately.

To expand scope, pair one additional source module with its relevant offline tests in `stryker.config.json` and measure runtime. Overriding only `--mutate` does not expand the selected tests and can give misleading results.

## Live acceptance CI and public results

### Local one-command run

```sh
./.github/scripts/test-instance.sh --profile vendor-1
./.github/scripts/test-instance.sh --profile vendor-1 --dry-run
./.github/scripts/test-instance.sh --profile vendor-1 --version 5.5.5 --dry-run
```

The executable wrapper works from any working directory when invoked by its
path. Default behavior is **full READWRITE + publish**, using a private ephemeral
profile with `read_only: false` and an exact target. Existing profiles are never
modified. This deliberately maps local `full` to the immutable producer's older
`pdi` mode; it does not imply that a vendor target is a disposable instance.
`--dry-run` skips **publication only**: the same provider writes still execute.
Use `--readonly` explicitly for the 71-scenario GET-only subset. Use `--plan` to
export all 92 immutable scenarios, command paths, prerequisites, mutation tables
and blocked surfaces without provider calls. Full selection is not a claim of
complete product coverage; blocked prerequisites and inventory gaps remain visible.
Failed or blocked checks retain the runner's nonzero exit status. For bounded
failure isolation, invoke the Node runner directly with an exact scenario ID:

```sh
node .github/scripts/run-acceptance.mjs --profile YOUR_PROFILE --target vendor1 \
  --version 5.5.5 --mode full --scenario workflows.flow-lifecycle
```

This selects only that scenario and its transitive dependencies (including
`workflows.context`), not the full catalog. It performs real reviewed provider
writes and does not publish unless `--publish` is explicit. Unknown IDs or missing
dependencies fail closed. Private Flow diagnostics distinguish CLI failure from
assertion failure and retain only closed reason codes and response shape; an
unclassified CLI failure is an evidence gap, not proof of a provider limitation.

Omitting
`--version` tests the current checkout; exact npm versions verify registry integrity
and candidate identity separately from the pinned producer provenance.

```sh
./.github/scripts/test-instance.sh --profile vendor-1 --plan
./.github/scripts/test-instance.sh --profile vendor-1 --readonly --dry-run
```

Full mode creates uniquely named run-owned inactive resource fixtures, a dedicated
capture set and an inspected Log-only property-triggered flow. Update/delete,
publish/unlock and flow test commands require acknowledged current-run IDs; flow
tests also require a current-run property. No existing business record is updated.
The original effective application/update-set is snapshotted and independently
read back after restoration. Unresolved writes prevent unsafe follow-up dispatch.
Native update-set import/commit (global-setting/history effects) and catalog order
(no reviewed provider fulfillment recipe) remain explicitly blocked, not passed.
Auth and interactive scenarios retain upstream prerequisite checks; no Basic,
TOTP, domain, catalog recipe or external session evidence is invented.

`cleanup-receipt.json` is private (0600), contains only target label, run ownership,
table/type/owned IDs and created/deleted/retained counts, plus restoration status.
Supported exact-ID cleanup is attempted in finally, including failed scenarios.
Capture history and unsupported flow graphs are deliberately retained; no force
schema deletion or guessed graph cascade is attempted. Their retention is not a
reason to suppress all other writes. Public reports never contain these IDs,
provider URLs, credentials or usernames. `local-summary.json` distinguishes full
selection, applicability, blocked prerequisites and static inventory gaps.

Node loads `${HERMES_HOME:-$HOME/.hermes}/.env` if present; use `--env-file FILE`
to override it. This file is parsed as dotenv, never executed as shell code.
Existing environment variables take precedence. Publication requires
`JSN_ACCEPTANCE_INGEST_URL` and `JSN_ACCEPTANCE_INGEST_TOKEN`, checked before
provider calls. The ingest deployment must support this PR's schema version 2.

`--profile` first selects an exact local JSN profile. Logical target labels can
instead map to local profiles through private dotenv settings:

```dotenv
JSN_TEST_PROFILE_VENDOR_1=your_local_profile_name
JSN_TEST_PROFILE_VENDOR_2=your_other_local_profile_name
```

These are profile names, not URLs or credentials. There is no GitHub lookup or
hardcoded personal mapping. An absent profile prints available safe profile names
and the required alias key. Summaries default to unique directories under
`$HOME/private-acceptance/`; no output directory is created in the repository.
The lower-level Node runner below remains available for explicit output or saved
result publication.

### Execution and target selection

Trusted main pushes and published releases independently attempt **both vendor-1
and vendor-2**, in separate bounded jobs. Neither waits for nor cancels its peer.
Manual dispatch defaults to `both`, with `pdi`, `vendor-1`, or `vendor-2` available
as explicit single-target choices. PDI is never automatic. The retired repository
variable `JSN_ACCEPTANCE_TARGET` is ignored. The release workflow dispatches the
exact release tag because events created with `GITHUB_TOKEN` do not start other
workflows. Release dispatch is best effort, not a release gate.

Ordinary PR CI receives no instance or publication secrets. Selection verifies
that the exact candidate SHA is an ancestor of the trusted default branch before
secret-bearing jobs. Manual feature refs are refused. Candidate checkouts disable
persisted Git credentials. Dependencies install without lifecycle scripts or caches
before credential injection. No target host or credentials appear in artifacts.

GitHub-only orchestration is owned by `.github/scripts/acceptance/`:
`config.mjs` selects targets, `ci.mjs` seeds the isolated producer and publishes,
`execute.mjs` observes execution, and `publish.mjs` validates delivery.
`.github/scripts/oauth-environment.mjs` is shared with the GitHub verification
wrapper, `.github/scripts/verify-instance.mjs`. These are not CLI product code
and are outside the published npm package. Generic local verification remains
`cli/scripts/verify-jsn.mjs`.

`.github/scripts/acceptance/prepare.mjs` stages the existing producer at immutable commit
`65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba`, without replacing candidate CLI source.
Generated runner resources deliberately retain the producer's original
`cli/scripts/acceptance/{bindings,run,session-adapter,support}.mjs` and
`cli/test/acceptance/` paths so its relative imports remain byte-for-byte intact.
They are temporary, untracked harness resources, not installed product code;
the npm package allowlist excludes scripts and tests. No tracked helper is copied
back into `cli/` as a compatibility shim.
Existing producer files cause refusal rather than silent replacement. Readonly
runs select every declared readonly scenario across read-only, read-only-catalog,
resources, workflows and auth. This is an explicit subset, not full-product
acceptance. The CLI's independent `read_only` profile and original producer guards
remain active. This tests a checkout, not an npm tarball. Provenance preserves
candidate SHA, dirty flag, package/Node versions and entrypoint SHA-256.

### Configuration

Use the existing environments. Configure both vendors independently:

| Scope | Kind | Name | Value |
| --- | --- | --- | --- |
| Each selected environment | Variable | `JSN_INSTANCE_URL` | HTTPS origin without path, query, credentials or port |
| Each selected environment | Variable | `JSN_VERIFY_ENABLED` | `true` after authorization review |
| Each selected environment | Secret | `JSN_OAUTH_REFRESH_TOKEN` | Refresh token from the authorized JSN OAuth public-client login |
| Each selected environment | Variable | `JSN_OAUTH_CLIENT_ID` | Optional override matching the login client; omit to use JSN source default |
| Each selected environment | Secret | `JSN_OAUTH_TOKEN` | Legacy access-token fallback, used only when refresh token is absent |
| Repository | Variable | `JSN_ACCEPTANCE_INGEST_URL` | HTTPS ingest URL ending `/api/acceptance/runs` |
| Repository | Secret | `JSN_ACCEPTANCE_INGEST_TOKEN` | Matching server `ACCEPTANCE_INGEST_TOKEN`, at least 32 characters |

Do not shadow repository publication settings in instance environments. No profile
JSON secret is required. The adapter seeds only non-secret isolated profile
configuration (an `auth_method: oauth` config file with the exact instance origin
and read-only flag) in a private ephemeral home. The refreshed access token is
held in process environment/memory and is never written to a credential file; the
pinned producer strips credential environment variables from CLI children and
refuses a fixture-supplied token, so the adapter adds the refreshed token back
only to coordinator launches bound to that seeded profile and target. Children
receive an allowlisted environment without GitHub, ingest, proxy or Node-injection
credentials, and no plaintext credential storage is enabled. Private files are
deleted on exit and never uploaded. Access-token-only configuration has no renewal
metadata. Auth rejection does not establish that a token expired.

Both verification and acceptance refresh before their real checks in the same
process. The exact validated HTTPS instance origin receives one bounded (15s)
form POST to `/oauth_token.do`: `grant_type=refresh_token`, `client_id`, and
`refresh_token`. Redirects are rejected. The client ID comes from
`JSN_OAUTH_CLIENT_ID` (mapped to `SERVICENOW_OAUTH_CLIENT_ID`) or the authoritative
`getOAuthClientID()` source default. Current JSN uses a public PKCE client: no
client secret or PKCE verifier is required for refresh. Match any override to the
client that issued the refresh token; do not invent a confidential-client secret.
Configured refresh failure fails closed with no stale-token retry. An absent
refresh token permits legacy access-token use, which must still pass the real
authenticated check. Closed output identifies `refreshed` versus
`legacy_access_token`; raw provider responses and credentials are never logged.

Refresh responses stay in memory; no refresh credential is written to files,
artifacts, step/job outputs or GitHub settings. Acceptance keeps no access-token
profile file for the pinned producer: the refreshed access token reaches the
producer as environment only, and the adapter bridge forwards it to coordinator
CLI children for the seeded profile/target. If the provider returns a different
refresh token, a fixed warning reports that the replacement is **not persisted**.
The current run uses the new access token, but
operators must securely replace the environment refresh secret for the next run.
No settings-write PAT is needed or requested. Provider rotation behavior has not
been live-verified; refresh-token expiration/revocation and local profile refresh
can also invalidate the static GitHub secret. This is automatic access-token
refresh, not a promise of indefinitely unattended renewal. The OAuth POST is an
authentication operation, not a ServiceNow business-record write; readonly and
mutation-approval boundaries are unchanged.

Manual `mode=pdi` requires single target `pdi`, default-branch dispatch,
`disposable_approved=true`, and an existing environment with required reviewers.
Environment review must approve the job; protection is rechecked through GitHub's
API immediately before execution. The adapter independently enforces approval and
verified reviewers. Reviewers must confirm the target is disposable. Full PDI runs
retain cleanup and unresolved-write guards. No automatic lane enables writes.

### Delivery is separate from test outcome

The final **Acceptance delivery gate, not scenario pass gate** runs with `always()`
and explicitly examines every target's outputs, not unreliable matrix outputs.
It succeeds if at least one target delivers genuine execution and verified public
results. A peer that is unavailable, unconfigured or fails publication does not
invalidate a delivered run. If no target delivers, the gate fails. Target jobs are
allowed to fail so a failed peer cannot override that final delivery decision.

A qualifying run requires at least **one distinct scenario with status `passed`,
`failed`, or `failed-timeout` and authenticated provider-operation evidence from
inside that scenario**. `execute.mjs` observes the pinned scenarios without
changing their results. A successful selected-profile `ctx.read`, or successful
provider-backed CLI JSON command, records private run-key/scenario evidence. Local
version/discovery-help/history, help, auth-status, blocked/excluded/not-run scenarios,
runner initialization, failed authentication, and setup/preflight alone cannot
qualify. Evidence is matched against the actual projection's run key and result
IDs. A failing assertion after an authenticated provider operation counts even
when zero scenarios pass. This intentionally conservative threshold does not count
an auth-only failure as execution. A partial run qualifies with honest missing
counts if it satisfies that threshold and publishes successfully.

The original producer's scenario statuses, `complete`, counts and `missingCount`
are preserved exactly. Nonzero suite exit is recorded as the **suite verdict**,
not reused as the delivery exit code. Target job summaries show authenticated
executed count, suite exit, scenario counts, completeness, missing count,
publication status and exact public run key. Public `/results/:run_key` pages
retain actual test verdicts. A green delivery gate does **not** mean passing tests.

### Publication and exact readback

After a failed or interrupted suite, saved valid evidence is still published.
Missing, empty, dirty, wrong-revision or invalid closed projections are refused,
never synthesized. Only validated schema-v1 public fields are uploaded, not
private receipts, raw errors, hosts, users, record data or credentials.

POST uses bounded timeouts, no redirects, and up to three identical-body retries
for transport/5xx errors. Accepted/duplicate responses must echo the exact run key.
A credential-free GET of that run's public results page must match its stored
canonical payload digest, run key, SHA and version. The page exposes its existing
server canonical digest, covering the full accepted projection rather than only
provenance. The updated site renderer must be deployed before live delivery can
pass this stronger readback. A stale renderer fails closed.

Each producer context generates a random UUID run key, independent of target,
commit or anonymized profile. Artifacts include the closed target label in their
name. The aggregate gate rejects duplicate run keys across targets. No hostname
is needed to distinguish the jobs or their public links. Re-running creates a new
run; retries of a publication retain the original key.

### Verification

```sh
npm --prefix cli ci
npm run test:workflows
node --test cli/test/workflow-contracts.test.js
npm test
npm run lint
node .github/scripts/check-docs.mjs origin/main
```

GitHub tooling tests live in `.github/tests/`, outside the CLI product suite.
`npm run test:workflows` runs them once using Node’s built-in test runner and
the installed `cli/` dependencies for real CLI integration. The CI GitHub tooling
job uses full history for the immutable producer and is enforced by the existing
Tests gate. The existing conservative selector covers non-prose `.github/`
changes; docs-only checks remain dependency-free. PR492’s isolated seeded-parent
authentication success/rejection/recovery regression is included here, with only
its observer import relocated; PR492 should not be merged separately.

Offline tests exercise the actual pinned producer against loopback, deliberate
assertion failures and restored success, the environment-only OAuth handoff (no
credential file, stale-token rejection, fixture isolation), independent readonly
refusal, honest failed/partial publication, exact readback, and delivery gates.
No mock output is uploaded or described as live acceptance. Historical producer
integration explicitly skips in shallow clones without the pin; local full-history
verification must run it. Ruby-available tests compare the Rails canonical digest.
Live runs and publication remain explicit post-merge operator verification.

## Setup / explicit-command parity

Tracking #323 / #328. Setup's help and noninteractive error now derive their
action list from the same menu choices the human sees. Setup still dispatches
to the existing auth operations; no second login/configuration implementation
was added.

| Wizard action | Explicit command | Verification |
| --- | --- | --- |
| Add a connection | `auth login <instance> --name <name>` with method options | Existing Basic/OAuth CLI workflow and guided/direct shared-operation tests; new captured-session file/stdin workflow. |
| Sign in again | `auth login --profile <name>` with method options | Existing profile settings are retained; the new file-input test reconnects after logout. |
| Check connections | `auth status --details --json` or `--local` | Existing auth workflow tests and new captured-session status check. |
| Choose default | `auth switch <name>` or new login's `--make-default` | Existing multi-profile CLI test, plus explicit browser-profile default selection. |
| Change settings | `auth modify --profile <name>` with flags | Existing settings/guided parity tests; new test toggles read-only, delete confirmations and result counts. Negative flags are documented. |
| Sign out | `auth logout --profile <name> --force` after approval | Existing logout approval tests; new lifecycle test proves unapproved logout fails and approved logout retains the profile. |
| Remove connection | `auth remove <name>` | Existing dispatch test and new real CLI test remove the temporary profile/credentials. |

Browser-session login and refresh now accept `--headers-file <path>` or `-` for
stdin. This fills the missing noninteractive input path without secrets in argv
or a paste prompt contaminating JSON. It reuses `loginWithGck` and the existing
verification/persistence. Invalid/empty files and conflicting selectors fail
without network or configuration changes. Basic uses environment credentials;
OAuth already supports `--print-url --wait-file <code-file>` for file-based code
input. Explicit `--browser` still requires a human to finish browser sign-in.

`test/setup-parity.test.js` uses a local HTTP fixture and isolated file credential
store; no live instance or real credentials are used. It checks every menu action
has a help/error mapping, JSON remains parseable, secrets stay out of output,
settings survive renewal, and failures leave configuration unchanged. Existing
wizard, Escape, profile, OAuth, Basic and shared-operation tests remain in scope.

## Command audience verification — issue 356

Executed 2026-10-29 with this checkout's `node bin/jsn.js` (4.3.13).

### Live PDI boundary

Immediately preceding doctor: profile `pdi`, OAuth/keyring,
`authenticated=true`, `verified=true`, current-user probe succeeded, exit 0.
Read-only SDK current-user and `sys_user_has_role` reads then produced:

```json
{
  "timestamp": "2026-10-29T06:43:26.992Z",
  "admin": {
    "verified": true,
    "audience": "admin"
  },
  "nonadmin": {
    "current_user_error": "auth_error",
    "current_user_status": 401,
    "audience": "basic",
    "role_check": "unavailable"
  }
}
```

The admin result is live proof of role detection. The disposable MID-only
account could not use the current-user endpoint (401), so this run does **not**
claim a successful non-admin login. Its unavailable role check correctly chose
the compact fallback. No profile, credential, default connection or instance
record was changed by these checks. Disposable account cleanup belongs to the
MID workflow that created it.

### CLI presentation proof (isolated local profile fixture)

These commands used a temporary profile with a verified `basic` audience, with
no credentials and no instance requests. They prove presentation and explicit
command availability separately from the live role query above.

```text
$ node bin/jsn.js --json
{"exit":0,"count":19,"names":["setup","auth","incidents","changes","requests","tasks","groups","groupmembers","grouproles","users","records","tickets","approvals","history","skill","docs","version","discover","completion"]}
$ node bin/jsn.js --all-commands --json
{"exit":0,"count":81,"names":["setup","auth","updatesets","scopes","domains","incidents","changes","requests","tasks","catalogitems","flows","actions","scriptactions","scheduledjobs","asyncrules","triggers","rules","decisiontables","assignments","scrapi","email","restmessage","soapmessages","acls","b4rules","roles","privileges","aliases","groups","groupmembers","grouproles","users","forms","lists","clientscripts","uipolicies","uiactions","views","catalogscripts","cataloguipolicies","uipages","uimacros","listcontrols","sppages","spwidgets","uxscripts","uxlists","uxapplicability","appmenu","appmodules","tables","columns","relationships","includes","import","logs","properties","cmdb","records","attachments","transactions","platform","snippets","tickets","codesearch","atf","approvals","skipped-updates","perf","history","customizations","midservers","diff","graphql","eval","rest","skill","docs","version","discover","completion"]}
$ node bin/jsn.js discover eval --json
{"exit":0,"count":0,"names":[]}
$ node bin/jsn.js discover eval --all-commands --json
{"exit":0,"count":1,"names":["eval"]}
$ node bin/jsn.js eval --help
exit=0; Usage: jsn eval |  | Execute background scripts on the instance

```

Automated regression checks also cover selected profiles, grouped root help,
`help`, root JSON, `discover`, shell completion, admin/legacy/unknown identities,
account mismatch, role-table denial, login persistence, and setup/auth recovery
parity. The profile origin is part of the cached audience identity.

The verify skill's local docs-search drive returned three JSON results and
human-readable output; cleanup retained sanitized evidence. Lint and the full
unit suite are recorded in the pull request.

## Command discovery and picker parity

Tracking: #320 / #328. The skill integration is a separate change.

### Discovery contract

`jsn discover [query]` matches words against live registered names, aliases,
descriptions, child action descriptions, and optional command-owned metadata.
`--table` selects an exact configured table. An unknown/custom table returns an
explicit pointer to `jsn records list --help`; it does not imply the table is
unsupported. Discovery runs without an instance or authentication.

The shared developer and ticket factories publish their actual table/default
column configuration. Show extensions are marked only where a factory has an
`onShow` hook; the marker does not promise relationships in JSON. Other commands
remain discoverable by their registrations and action descriptions. For example,
`jsn discover "attachments catalog variables"` finds the enriched requests show
handler, and `jsn requests show --help` describes its attachments and variables.

Names, descriptions, aliases and exact help paths come from the same live tree
that dispatches commands. A new registration appears automatically; replacement
registrations update the description/actions without a separate discovery map.
This is text matching, not a semantic search model.

Root help and `discover --help` give runnable examples for cross-table task
searches, custom tables, configured specialized views and raw endpoints. Generic
records is a supported choice; discovery adds no warning to records or REST
operations. Existing eval safety and REST read-only guards remain unchanged.

### Picker audit

The old skill claim that **all list commands** use the same picker was false.
The replacement root help describes shared controls and explicitly scopes them
to commands that offer a picker. This is suitable for removing duplicated
mechanics without pretending every command has identical eligibility.

Source audit (`src/commands/`, `src/helpers.js`, `src/paginated-search.js`):

| Surface | Eligibility / search behavior |
| --- | --- |
| Shared developer factory | Interactive auto output, no explicit query; searches `name`. |
| Shared ticket factory | Interactive auto output, no query and offset zero; searches `number`. |
| `records list` | Shared picker unless `--sys-id`; searches `sys_id`, including with a base query. |
| Users / groups / logs | Shared picker; search fields are `user_name`, `name`, `message` respectively. |
| Flows / catalog items / scopes / update sets / domains / forms / decision tables | Shared picker; search field `name`; each handler supplies its base query and columns. |
| CMDB list | Shared picker with no explicit query and offset zero; searches `name`. |
| ATF test/suite lists | Shared picker; searches `name`; explicit suite filtering can use a direct list path. |
| Approvals list / skipped-updates | Shared picker; search fields `sys_id` / `target_name`; approval filters and skip-review options remain command-specific. |
| Lists | Table picker (`name`) then list picker (`view`), rather than a uniform table list. |
| MID / scope / update-set selection | Some action paths use the shared picker for selection rather than a list result. |
| Perf / customization saved runs | Local saved-run selectors use paginated search in selected action paths; their `list` output is not a server-side LIKE picker. |
| Other list actions | No guarantee of a picker; examples include record attachments and registry-derived parent action lists. |

The shared picker uses ten visible choices, arrow navigation, type-to-search,
Enter selection and Esc cancellation. Scrolling fetches more unfiltered records;
server-side search is bounded by the configured limit and does not promise
unlimited search pagination. Shared `interactiveList` skips explicit formats and
noninteractive execution. Some callers handle cancellation differently; this
change documents controls rather than changing that behavior.

### Skill integration now permitted

- Replace Discovery / Interactive Picker sections with a concise pointer to
  `jsn --help` / `jsn discover --help`; output-mode mechanics also live in help.
- Remove the rigid Command Hierarchy and Key Commands catalog. Keep the separate
  eval approval/no-protection-bypass safeguard.
- Remove Table/raw REST examples: existing command help carries these examples
  (`test/records-rest-help.test.js`).

`test/command-discovery.test.js` proves registry addition/replacement, enriched
action matching, exact table filter, custom-table fallback, JSON extraction,
human output and root help. Existing completion/help/output-contract tests
cover compatibility. This audit does not close the other #328 dependencies.

### #320 acceptance follow-up

The bundled skill from #348 now delegates command choice to installed help,
without preferring specialized commands over generic records or REST. Its only
command preference is ordinary commands over approved eval.

Profile-backed discovery now reads reference-output/list-projection preferences
and essential relationship names/tables from the same validated profile that
builds the handler. For example, `jsn discover --table sys_ui_policy` explains
that show includes policy actions and gives the `--no-essential` opt-out. There
is no separately maintained discovery table. Regression coverage changes a
profile's relationship/output configuration and verifies discovery updates,
including removal of the former relationship; the actual CLI JSON and human
outputs and the skill's command-choice boundary are also checked.

Development lifecycle guidance is present in the bundled skill: scope/set,
work, instance verification, offer ATFs/scans, then human-confirmed completion
with notes. Incoming import/preview/error resolution/commit/verify is also
present. Main does not yet implement the incoming XML lifecycle as a dedicated
command; that separate implementation is not a discovery acceptance gap and
must not be inferred from registry search results. Existing update-set help
covers capture creation/selection/completion, while ATF help covers listing,
running and results rather than a dedicated test-authoring command.

Validation: 26 discovery/profile/completion/records-REST help tests, full lint,
and the local verification doctor/drive/cleanup passed. The local docs drive
returned three JSON and human-readable search matches. No PDI request or auth
mutation was made. #320 is ready to close after this follow-up is integrated;
incoming lifecycle implementation remains separate work.

## Customization evidence: skill-to-CLI parity

Tracking #326 / #328. The skill retains capability discovery, a capture/review
example, and the agent decision to verify evidence before proposing changes.
The detailed interpretation lives in `src/customization-guidance.js`, shared
by command help and derived report views.

| Former skill rule | CLI home / proof |
| --- | --- |
| Bounded GET-only table reads; OAuth refresh and session bootstrap are possible | Root/capture help and JSON `interpretation.capture`; the CLI integration test permits only table GETs plus authentication POSTs. Saved operations work after the fixture server closes. |
| Declare customer scopes; non-global scope does not prove ownership | Help and `interpretation.evidence.ownership`; existing provider/classification tests and per-artifact triage distinguish declaration from verification. |
| Upgrade skips are historical, not a verified current deviation | Help, text, JSON `interpretation.evidence.upgrade_skips`, HTML interpretation and triage. |
| Raw 4/104 and reviewed_reverted exclusion | Existing provider-fixture tests cover raw values, display labels and reverted rows; help and JSON name the rules explicitly. |
| file_name resolves by sys_update_name in chunks | Existing direct-lookup tests cover artifacts beyond the broad sample; help and JSON `interpretation.evidence.resolution` explain the join. |
| Unresolved names, failed chunks, unknown scope names | Coverage in JSON and default/expanded text; HTML coverage renders unmatched names/counts and failed chunks. Existing ACL/lookup tests now verify the text views too. |
| Broad metadata read is a sample, not an inventory | Shared interpretation and capture coverage. A new regression proves reverted-history lookups can also contribute unclassified artifacts outside the sample; customer/unclassified categories are not complete inventories. |
| ACLs, pagination, unmatched evidence, empty findings | Coverage retains source status/count/reason and limitations; interpretation explicitly says no findings is not proof of no customizations, including an empty capture. |
| Comparisons use metadata/evidence, not source payloads | Comparison help, JSON `interpretation.comparison`, human output and existing field comparison tests. |
| Removed means not observed, not deleted | Existing `availability` fields and comparison tests; common interpretation repeats the limitation in each review surface. |
| Reversion impact/dependencies unknown; no automatic reversion | Shared limitations/next steps, per-artifact triage and `automated_remediation: false`; short agent safeguard remains in the skill. |

### Compatibility and validation

`interpretation` is an additive derived output field on capture/show/compare/html
results and HTML's embedded view. Stored capture schema, IDs, evidence, existing
JSON fields and triage remain intact. Older captures acquire current guidance
when viewed; no migration or rewrite of stored reports is required. Tests prove
viewing and comparing a capture does not mutate its saved data.

Run the customization unit/provider/HTML/CLI tests, full suite, lint and the local
docs fixture. The CLI test checks help offline, JSON interpretation equality
across surfaces, HTML's embedded view, coverage visibility and `--get` behavior.
All capture traffic is against a local fixture server, never a live instance.

## ServiceNow skill / CLI parity

Parent #328. The final skill keeps agent decisions and ServiceNow development
workflow. Operational mechanics belong to the matching packaged CLI. The implementation dependencies are now on main; the skill delegates
operational mechanics to their installed help and runtime safeguards.

| Skill material | Final decision | CLI home and validation |
| --- | --- | --- |
| Discovery and picker mechanics | Replace with installed-help pointer | #335 registry discovery and accurate help; real PDI help-guided read plus offline JSON/text/extraction proof on that PR. |
| Output modes | Remove duplication | `--json` for parsing, text for people; envelope/extraction tests. |
| Full sys_id blanket | Remove duplication; rely on resolver | #338 bounded exact/human/prefix/suffix resolution and ambiguity errors, integrated through #344. Exact-head PDI lookup/zero-match proof; fixture mutation ambiguity safety. |
| Mandatory auth preflight | Remove | #329/#332 request-driven recovery; real PDI 401 → 200 with one replay, explicitly distinguishing in-memory credential recovery from browser renewal; direct CLI read without a status preflight. |
| Blanket never-logout rule | Remove | #330 informed logout confirmation; real PDI noninteractive refusal retained credentials and profile; destructive clear path remains fixture-tested. |
| Target connection | Keep explicit | Verify intended instance and pin `--profile`; selected-profile live checks and scoped credential tests. |
| Eval safety | Keep explicit | Purpose-built/records preference; explain need and obtain approval; discourage bypassing ServiceNow protections. |
| Mutation confirmation | Keep authorization boundaries only | #336 ordinary create/update behavior and Global + Default approval; delete preference remains separate. Live disposable preference CRUD/history proof and high-risk-context fixture tests. |
| Hierarchy and command catalog | Remove duplication | #335 discovery derives from actual registration; #340 compact declarative registry reaches main through #344. |
| Customization implementation rules | Remove duplication; CLI supplies evidence and coverage | #331 interpretation/coverage/triage in CLI output; bounded live PDI capture and offline review proof. Findings do not imply reversion approval. |
| Update-set completion mechanics | Keep human workflow only | Choose/create scope and set, do the work, verify on the instance, offer ATFs and instance scans, then ask about further additions. Complete with notes after the human confirms the set is finished. Selection/reset mechanics stay in CLI help. |
| Incoming update sets | Keep full promotion workflow | Import XML, preview, resolve errors with the human where needed, commit after a clear preview, and verify outcomes. #351 currently implements retrieval; preview/error-resolution/commit support remains follow-up work. |
| Table/REST examples and read-only policy | Remove duplication; CLI enforces policy | Command help tested in #330; raw REST remains blocked on read-only profiles even for GET. |
| Docs tutorial | Remove duplication; root help discovers docs | #346 implements #324 source choice, verified snapshots, offline local use and recovery. Production migration remains an explicit separate deployment gate. |
| Field troubleshooting | Remove duplication; use audited CLI guidance | Separate audit found and corrected before-query constraints, override-table guidance and ACL coverage in #347. No universal priority order; do not bypass protections. PDI schema/read evidence is recorded on that PR. |
| Raw config/credential paths | Remove | #333 scriptable setup/auth help and secure input; live PDI setup/status and offline file/stdin tests. |

### Distribution

`skill install`, `skill show` and `skill check` use the skill bundled with the
installed CLI. Existing integration tests prove offline installation, byte/version
equality, freshness checking and replacement of an outdated installed copy.
`skill fetch` prints the packaged text offline. Checks report each managed copy
and the first differing line, even if its version is unchanged. Reinstall replaces
all recorded copies. Older CLI versions that fetch mutable main require upgrading.

### Integration status

#344, #346, #347 and the #318 specialized related-list integration are on main.
The skill now keeps only the entry point and agent judgment that help/runtime
cannot supply: target intent, eval/destructive/context authorization, development
capture, instance verification, an offer of ATFs/instance scans, and human-confirmed completion.
It adds no reference catalog to replace the removed CLI duplication.

External docs service deployment remains a separate operational task; this skill
does not claim that deployment is complete. Live PDI evidence lives on the original
feature PRs. Distribution checks must pass before merging the final skill.
