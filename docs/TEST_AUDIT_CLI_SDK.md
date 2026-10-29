# CLI and SDK test audit — issue #365

Audited against `73fb7962be0ded60d9e234720538bc5e0d12260f` (main, package 4.3.13).
This review covers the 31 files below, including their fixture setup, assertions and
relevant production seams. The auth/safety audit owns `capabilities.test.js`,
`helpers.test.js`, `unit.test.js` and `sdk-client.test.js`; the remaining-suite
audit owns `customizations-command.test.js`. The upgrade command is absent on this base.
No live-instance tests were enabled and no production code changed.

## Measurements

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

## Implemented findings

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

## Per-file assessment

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
| `test/sdk-flows.test.js` | Keep decoding, hydration, public inspection, fallback, caching/depth and JSON-shape cases (lines 7–413). Retain the explicit narrow export-surface invariant (line 353; `GLOSSARY.md:313`): public inspection is the supported seam and internal formatting helpers should stay private. SDK and command tests catch different serialization boundaries. |
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

## Validation boundary

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
Final combined suite validation is pending in the parent audit PR and will be
reported there before publication.
