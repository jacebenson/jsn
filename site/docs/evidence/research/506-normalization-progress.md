# Each-document normalization checkpoint

Sole writer at base 4a10b28bb7c83f16cd9714186225f74258f515dd. Existing inventory: 28 unique public PDF links, 29 records including separately normalized ITOM. All 28 private extraction paths survive; source bytes and redistribution permissions remain unverified. Work proceeds from those private extracts in persisted batches; no published route, HTTP refresh, deployment, or source asset hosting is in scope. Short/empty extracts will be identified explicitly, not treated as complete documents. Original untracked research and ITOM estimator remain untouched.

## Result

All 28 existing PDF sources were read from preserved private extracts. Otto's first extract contained a truncation footer; followed it to `/home/jace/.hermes/cache/web/www.servicenow.com-34841d2d89.md` and read the missing pages before rewriting. No new network retrieval or archive expansion was needed. Medium batches persisted canonical data after each group.

Reconciled counts are in [the per-document manifest](506-normalization-manifest.json): 28 unique documents, 27 normalized and 1 partial due to source conflicts; 0 pending and 0 retrieval-blocked. There are 31 inventory records, 30 normalized and 1 partial. The retained independent ITOM estimator record brings the catalog to 32 records, 31 normalized and 1 partial. Three new deterministic historical IDs split SAM, HAM and TNPM from the existing July 2020 ITOM ID without changing its legacy meter resources.

Substantive representations include resource eligibility/classes, literal SU ratios, credit/Assist events, batching and periods, peak-based Factory capacity, Foundation included applications, Custom Table exemptions/limits/assignments/grandfathering, all 22 Integration Hub/Automation Engine/WDF package rows and their capability lists, and shared-environment ACV-based storage entitlements. ACV thresholds describe storage eligibility, not subscription prices. The fee-only Overage document is explicitly classified without a numeric usage meter; pricing is intentionally omitted.

Otto has 285 skill rules. Compared all 284 numeric/conditional rates with the full extraction in source order, excluding five wrapped description numbers. The remaining Voice agents row keeps its workflow-tier reference and under-30-second exception. Automated token audit found every table/class identifier in rewritten definitions in its own source extract after removing whitespace only; no class spelling repairs were applied.

USEM remains partial: varying left resource quantities conflict with repeated right `(1:1)` labels; prose and tables disagree on image/application classes; FaaS lists Cloud Directory; AI Asset prose has no matching resource table. All its sections are read and represented. No authoritative conversion is selected. EAM and OTAM unusual numerator ratios remain literal and flagged, not inverted. No purchased quantities, HRSD meter mappings, measured usage or source redistribution rights are claimed.

## CLI and review boundary

`subscriptions schedules --id <id>` now prints readable complete definitions, usage rules, entitlement limits and section provenance, not a JSON dump or one-line meter. JSON and `--get` retain structured data. All 31 inventory IDs were exercised through actual offline human inspection with unusable proxy settings; every definition appeared. Receipts are `/home/jace/.hermes/cache/scratch/506-inspect-all.json`, with Otto and Custom Table human samples alongside it.

Canonical files remain in `site/config/subscription-schedules`; the existing sync script regenerates CLI bytes. The original 28 IDs and source URL set remain unchanged; 3 historical section IDs are additions. Original API meter is unchanged. No diff touches the ITOM estimator, its dated source snapshot or `subscriptions.test.js`. Existing catalog tests retain their assertions; only inventory and pending counts changed to reflect the delivered data. Five new tests cover varied definitions, conflicts, literal orientation, multi-product selection and human/structured inspection.

Self-review against AGENTS and the scoped task found no runtime-network, instance, dependency, Rails runtime, or publishing changes. No independent reviewer was run here; Holly must sample the exact committed artifacts against source before accepting them. Green tests do not validate commercial interpretation. Public Rails delivery and CLI HTTP refresh/cache remain unimplemented.

## Execution receipts

- New human-output regression first failed on the old JSON-dump renderer, while the four data tests passed. After the formatter change, focused suite: 34 tests passed, zero failures/skips.
- `timeout 180 npm test`: exit 0, 2522 tests, 2519 pass, 3 skip, zero failures.
- `timeout 120 npm run lint`: exit 0.
- `node cli/scripts/sync-subscription-catalog.js`: exit 0; snapshot equality test passed.
- `git diff --check`: exit 0.
- Actual CLI `--get` reads returned the Starter V4 package with 300 MB/day, USEM `ambiguous_source`, and historical SAM's Now Buying Program-only applicability.

Logs: `/home/jace/.hermes/cache/scratch/506-normalization-{red,focused,full,lint}.log`. All commands used finite timeouts without integration-test opt-in. Final focused/full/lint verification repeated after metadata/manifest edits and passed with the same counts. An extra direct `node --test cli/test/...` probe from repository root failed because the catalog subprocess harness resolves `bin/jsn.js` relative to package cwd; reran the documented focused command from `cli/` and root `npm test`, both green. Probe log: `/home/jace/.hermes/cache/scratch/506-normalization-root-probe.log`. No tests were weakened for that wrong-cwd invocation. No push, PR, deployment or external publication is authorized or performed.
