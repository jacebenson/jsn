# Records migration regression and performance audit (#321)

Audited main `6b0a679` on 2026-10-29 against #321 and its parent #312.
Issue #321 has no additional comments or acceptance additions. The compatibility
contract was established before implementation in `docs/records-engine-contract.md`.
This follow-up changes tests and verification tooling, not runtime behavior.

Validation of this checkout: full suite **1,551 passed, 2 skipped, 0 failed**
(1,553 total); affected engine/performance tests **9 passed**; full lint and lint
of the benchmark script passed. The local docs drive returned three JSON results
and human output, and cleanup retained evidence. The separate bounded PDI check
below ran afterward on the exact runtime/test checkout.

## Acceptance evidence

| Requirement | Executable regression evidence |
| --- | --- |
| Shared CRUD, custom tables, exact/legacy/partial identifiers, zero/ambiguous errors | `test/records-engine.test.js` drives the real CLI and loopback Table API; `test/records.test.js` and `test/mutation-history.test.js` cover create/writeback and mutation events |
| Profiles, aliases, defaults and extensibility | `test/record-profiles.test.js` checks the actual keyed registry and factories; `test/command-discovery.test.js` checks generated discovery |
| Read-only, confirmation and capture safeguards | `test/records-engine.test.js` proves blocked writes and zero requests for read-only mutations; `test/mutation-context.test.js` and `test/mutation-history.test.js` cover capture approval/history |
| JSON, extraction, human views and reference representations | `test/records-engine.test.js`, `test/essential-records.test.js`, `test/specialized-related.test.js` and `test/forms-metadata-cli.test.js` |
| SDK batch validation, correlation, partial errors and safe fallback | `test/sdk-batch.test.js`, `test/related-lists-http.test.js` and `test/auth-recovery.test.js` |
| Metadata bulk reads/cache/bounds and coverage | `test/record-metadata.test.js`: inherited/custom layouts, concurrent cache reuse, 105 sections in two bulk element reads, no scripts, malformed/ACL/truncation gaps |
| Pagination and optional-count HTTP budgets | Extended `test/records-engine.test.js`: real generic and ticket CLI page offset/limit/data/envelope, one Table API page read with no count; explicit generic count adds exactly one Stats API call |
| Fanout, cache and cross-record isolation under real HTTP | New `test/records-performance.test.js`: all three transport modes, 60 unique descriptors, cap 50, 10 unavailable, zero cached requests, fresh counts for a new parent, no child row fetches |

The CLI request budget counts `/api/now/` requests, excluding the basic-auth
session warmup endpoints. The loopback performance fixture uses a supplied GCK
fixture token, with no session warmup or credential renewal. An empty PATH in the
CLI fixture prevents subprocess dispatch to another jsn executable.

## Reproducible loopback measurement

Run `node scripts/benchmark-records.mjs`. The checked-in raw result is
[321-records-fixture-benchmark.json](321-records-fixture-benchmark.json).
Three samples per mode use the real SDK and related-count reader against a local
HTTP server, 60 unique supplied metadata descriptors and the default cap of 50.
Each outer HTTP response has an artificial 5 ms delay. A batch response contains
all its subrequest results; that delay does **not** model per-item server work.
Metadata discovery, CLI startup and real authentication are outside this timing.

| Transport mode | Cold HTTP requests / aggregate operations | Cached requests | New-parent requests | Median cold / cached / new-parent ms |
| --- | --- | --- | --- | --- |
| Native batch fixture | 1 / 50 | 0 | 1 | 28.021 / 1.694 / 21.143 |
| Individual reader (SDK batch method absent) | 50 / 50 | 0 | 50 | 150.860 / 0.839 / 144.354 |
| Unsupported batch endpoint (404) | 51 / 50 | 0 | 50 | 405.130 / 0.741 / 389.674 |

Observed maximum HTTP concurrency was 1 / 4 / 1 respectively. The unsupported
endpoint is attempted once per SDK; subsequent parent reads reuse that capability
result. Its SDK fallback is sequential, so it is slower than the reader's bounded
individual lane in this fixture. This is a measured tradeoff, not a claim that
batching always improves latency. No historical implementation baseline or live
ServiceNow timing comparison was measured. CI asserts exact request/operation
budgets and bounds, never unstable wall-clock thresholds.

## Actual instance evidence and limits

A fresh read-only PDI check ran on source `5da45b6` after a successful doctor
(authenticated/verified true) at 2026-10-29 05:41 UTC. The actual command was:

```sh
JSN_NO_VERSION_CHECK=1 JSN_NO_SKILL_CHECK=1 node bin/jsn.js --profile pdi records list --table sys_db_object --query name=incident --columns name,label --limit 1 --offset 0 --no-count --json --get data.pagination
```

It exited 0 and returned exactly `{"limit":1,"offset":0}`, without a total field.
Cleanup completed. [Sanitized terminal evidence](321-records-pdi.json) records
the source, command, doctor projection and result. This verifies live output
behavior, not a live HTTP-request budget or timing result. No writes or credential
renewal occurred during this proof. Subsequent commits only record evidence.

Existing component runs, rather than this fixture benchmark, establish further actual
read-only PDI behavior: [records engine and compact profiles](records-engine.md),
[batch](sdk-batch-live-check.md), [metadata](317-metadata.md) and
[specialized related counts](318-specialized-live.json). These records retain
the tested source revisions, doctor results, commands and sanitized outcomes.
Those earlier component runs are not newly repeated live tests or live timing
measurements for this PR.
No PDI access, refresh, login, instance write or private data collection occurs
in the new test/benchmark commands. Live mutation behavior, effective ACL access,
large live forms and live unsupported-batch fallback are not claimed; their
regression coverage uses explicit fixtures.
