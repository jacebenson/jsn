# ITOM population comparison candidate for #506

Base `6e09dda5f2b244ecc1f90c848d7fa2cbbe86a1ec`, branch `explore/506-subscription-evidence`. The earlier `506-subscription-evidence.md` research artifact is preserved unchanged and untracked. This report describes a working bounded calculator slice, not completed licensing or entitlement verification.

## Candidate commands

Run from this worktree, not the installed `jsn` binary:

```sh
node cli/bin/jsn.js subscriptions schedules --styled
node cli/bin/jsn.js subscriptions schedules --get 'data.schedules[0].categories'
node cli/bin/jsn.js subscriptions estimate ITOM --profile pdi --schedule itom-2026-04-09 --assume-eligible --styled
node cli/bin/jsn.js subscriptions estimate ITOM --profile pdi --schedule itom-2026-04-09 --assume-eligible --json
node cli/bin/jsn.js subscriptions estimate ITOM --profile pdi --schedule itom-2026-04-09 --assume-eligible --get 'data.categories[4].illustrative_units'
```

Without `--assume-eligible`, populations are reported but units are withheld. Without `--schedule`, the report discloses a provisional April 9, 2026 schedule assumption. Explicit selection does not prove contractual applicability. HRSD, arbitrary SKU names and unknown schedule IDs refuse with guidance rather than inventing rules.

## Implementation and provenance

- Registered `subscriptions schedules` and `subscriptions estimate <product>` through the actual CLI adapter, capability registry, normal profile/session resolution and output envelope. Local schedule inspection needs no instance. Human, JSON and `--get` views share report values.
- Bundled source-backed schedule `cli/src/schedules/itom-2026-04-09.json` retains URL, applicability, retrieval timestamp/version, resource-definition paraphrases, exact class tokens, all eleven published resources-per-SU ratios, unsupported rules and uncertainty. The public PDF was independently retrieved through `web_extract`. Direct Python binary download returned HTTP 403, so no binary checksum is claimed. No PDF is redistributed.
- Source: https://www.servicenow.com/content/dam/servicenow-assets/public/en-us/doc-type/legal/it-operations-management-itom-servicenow-subscription-unit-overview.pdf
- Effective wording is **for SKUs introduced on April 9, 2026**, not every ITOM subscription. Ratios are server 1, PaaS 3, container 10, image 3, end-user device 4, FaaS 20, GPU 1, API 1, AI agent 3, service instance 1, unresolved object 4 resources/SU.
- Inspected CLI registration, output formatting, capabilities, SDK aggregation and metadata helpers before implementation. Existing `aggregateCount` converts absent/malformed statistics into zero, so this slice uses strict SDK Stats GET envelopes instead. Existing `aggregate` normalizes response shapes but does not establish completeness.
- Each invocation reads at most 20,000 table definitions in ordered offset windows of at most 1,000 rows, bounded additionally to 200 pages, and compares retrieval size with strict provider counts before and after. Short pages do not prove exhaustion. Full metadata includes scoped descendants, not only names starting with `cmdb_ci`. Metadata stays in memory; no raw records, customer identifiers or hostnames are saved.
- Verifies the class discriminator dictionary entry and inherited class ancestry. Each exact concrete class is assigned once. Other resource types exclude end-user computing devices; cross-category ambiguity withholds affected populations. Missing ancestry is skipped and disclosed. Missing/forbidden/malformed counts are null, not zero.
- Current provider-visible populations are counted with one scalar Stats count per mapped category, with no grouped-page truncation. A metadata-count mismatch still permits explicitly partial known-class populations, never a complete mapping or authoritative total. ACL-hidden data and concurrent changes remain unknown.
- Instance data requests use SDK `readOnly: true` and GET. Normal authentication bootstrap/refresh is preserved. No eval, record mutation, entitlement reads, usage-history reads or customer-data exports were performed.

## Verification

Commands were individually bounded. No live integration-test opt-in was used.

| Check | Result |
| --- | --- |
| Initial test-first schedule test | Exit 1 before implementation, missing feature module |
| `npm --prefix cli ci --ignore-scripts` | Exit 0, locked dependencies installed, no dependency changes |
| Focused SDK/command tests before final additions | Exit 0, 13 subscription tests |
| Focused subscriptions + capabilities after real CLI output test | Exit 0, 23 tests at that checkpoint |
| First full `npm test` | Exit 1, only exact capability skip-set expectation needed the newly declared `subscriptions` entry; not a baseline failure |
| Final full `npm test` | Exit 0, 2,504 tests, 2,501 pass, 3 opt-in skips, 0 failures, about 73 seconds |
| Final `npm run lint` | Exit 0 |
| `git diff --check` | Exit 0 |
| Candidate PDI JSON, `--get`, styled acceptance | Each exit 0; same end-user-device illustrative value, 203.75 |

Final full-suite log is local scratch `/home/jace/.hermes/cache/scratch/jsn-506-full-suite.log`. Tests exercise the SDK fetch transport, registered command handlers, actual root CLI discovery, spawned candidate binary for schedules, and real buildCLI/output for estimate with offline synthetic transport. Contracts cover source provenance/ratios, scoped hierarchy overlap, cross-category ambiguity, missing ancestry/classes, provider-count mismatch, malformed/forbidden/missing sources, unsupported product/schedule, explicit assumptions, no data writes, fractional math and human/JSON/`--get` parity.

## Sanitized live acceptance

Candidate `cli/bin/jsn.js`, profile `pdi`, explicit dated schedule, declared hypothetical eligibility. JSON, extraction and styled output were independently run. The candidate is not installed.

- Metadata returned 6,635 definitions; provider count was 6,672. The discrepancy's cause is unverified, and output labels all mapped category coverage partial.
- Visible mapped servers: 40, illustrative 40 SU.
- Visible end-user devices after excluding other mapped resource types: 815, illustrative 203.75 SU. This does not establish installed components or ITOM management.
- Visible mapped PaaS/container/image/service-instance populations returned measured zero for their exact known-class queries. Those zeros do not establish complete category absence.
- FaaS/GPU/API/AI-agent class definitions were missing or hidden. Populations and units remain null.
- Unresolved monitored-object source counting is unsupported and remains null.
- PaaS preserves literal `cmdb_ci_could_database` and leaves its source mapping unresolved. Other missing PaaS/image roots remain listed. No corrected database mapping is queried.
- `total_units` is null, status incomplete. No authoritative total, upper bound or compliance conclusion is given.

## Remaining limits and review handoff

Component requirements, product scope, actual ITOM-managed eligibility, container/image relationship exclusions, rounding and contractual SKU applicability are unverified. Purchased rights, observed 90-day consumption and HRSD are outside this slice. Schedule storage is bundled and versioned with source, not an automatic fetch/update service. There is no persistent instance-population cache.

Implementation self-review checked AGENTS output/capability/read-only requirements and the narrowed task contract. Independent exact-diff review and reproduction remain Holly's delivery gate. No push, PR, merge, release, installed-CLI change or website deployment occurred.

## Bounded pagination correction after `8e4beb2`

The prior acceptance is superseded for metadata pagination. Replaced the single 20,000-row request with provider-count-driven `ORDERBYsys_id` offset windows (1,000/window, 20,000 rows maximum, 200-page ceiling). Offsets advance by requested window size, not visible row count: a short visibility-filtered window must not cause overlapping reads. Empty pages stop with incomplete coverage. Duplicate, absent, blank or non-string metadata IDs reject as malformed; out-of-order rows or changed before/after provider counts cannot establish complete mappings. Existing source/mapping/eligibility protections remain.

An initial trial advancing offsets by received rows passed offline checks but live returned malformed metadata (overlapping identities). It was rejected, not accepted. The final requested-window implementation was rerun through every check below. Pagination does **not** resolve the live discrepancy, and no complete metadata proof is claimed.

Exact final check receipts (all from candidate worktree; timeouts bound each command):

| Command (cwd `cli/`) | Exit / result |
| --- | --- |
| `timeout 90 node --test test/subscriptions.test.js` | 0; 25 tests, 25 pass, 0 fail, 0 skip; 962.365636 ms |
| `timeout 120 npm run lint` | 0 |
| `timeout 180 npm test` | 0; 2,513 tests, 2,510 pass, 3 skip, 0 fail; 72,192.164044 ms |
| `JSN_NO_VERSION_CHECK=1 JSN_NO_SKILL_CHECK=1 JSN_NO_HEADER=1 JSN_NO_PROMPTS=1 timeout 120 node bin/jsn.js subscriptions estimate ITOM --profile pdi --schedule itom-2026-04-09 --assume-eligible --json` | 0; read-only live result below |
| `git diff --check` (worktree root) | 0 |

Logs: `/home/jace/.hermes/cache/scratch/jsn-506-pagination-{focused,lint,full}.log`; live JSON `/home/jace/.hermes/cache/scratch/jsn-506-pagination-pdi.json`. Added regressions reproduce a short page followed by additional rows, empty and duplicate pages, unstable provider counts, unordered metadata, and missing/blank/non-string/duplicate IDs; none falsely completes. Existing tests retain successful stable-count mapping and transport GET-only assertions.

Final live receipt: seven ordered windows, 6,635 unique visible definitions against provider count 6,672 both before and after, zero unresolved ancestries, metadata `partial`. Server 40 / illustrative 40 SU; end-user-device 815 / illustrative 203.75 SU; PaaS/container/image/service-instance measured known-class populations zero; FaaS/GPU/API/AI-agent unavailable; unresolved-object unsupported. Every mapping remains incomplete. Report status `incomplete`, `total_units: null`, `authoritative: false`. These remain hypothetical scenario units, not observed consumption, entitlement, billable usage, or contractual authority. Stable counts do not establish snapshot isolation or visibility of the missing definitions.

Only implementation, its tests and this internal evidence were changed. Earlier research remains untouched. No new dependencies or external publication/write actions.
