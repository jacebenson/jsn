# Remaining-suite test audit (issue #365)

## Snapshot and scope

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

## Changes and surviving coverage

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

## Retained areas and boundaries

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
an awaited update; improving it needs a safe live fixture with readback, rather
than claiming the offline audit verified live persistence. No live records were
created, updated or deleted by this audit.

A source-review follow-up is `records/inspect.js`'s use of display-first
`getStringField` for a resolved `sys_id`. Its normal lookup requests plain values;
a synthetic response containing different `value` and `display_value` selects
the display value. This pass verifies the normal Table API response and records
the edge case rather than changing production semantics under test cleanup.

## Validation

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

Parent full-tree ESLint passed. Full post-change suite: pending parent validation; update before merge.

## Owned file manifest

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
