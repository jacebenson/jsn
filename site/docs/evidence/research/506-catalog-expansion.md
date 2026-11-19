# Bounded catalog expansion checkpoint

Base: `8206df521c0746edebe36d4f2ebf94fafbbe3d9d`; canonical main `6e09dda`.
Sole writer, task worktree only. Original untracked research is preserved.

Acceptance: publicly sourced local schedule catalog, exact ID and product/SKU selection, explicit applicability, independent HRSD unavailable result unless a defensible eligible-population source is established. Preserve existing ITOM ratios and all incomplete-coverage protections. No invented historical terms, SKU mappings, role-based HRSD counts, prices, writes or publication.

Read AGENTS, existing implementation and both evidence records before research. Historical source retrieval is bounded; inaccessible sources will be reported rather than synthesized. Verification and final receipts follow below.

## Delivered bounded batch and scope changes

User expanded scope to every linked PDF and then site ownership. Inventory reconciled programmatically: 28 unique legal PDF links from the anonymous supplements index DOM, excluding unrelated footer business-continuity PDF; all 28 successfully extracted with one bounded call per URL, five concurrent. Navigation later failed even for the index; initial captured links were used, not guessed URLs. Archive browser and extraction failed; no archive completeness claim. A linked generic overview independently yielded July 23, 2020 ITOM terms. Original untracked research remains untouched.

Canonical records: `site/config/subscription-schedules/public-inventory.json` and `itom-2026-04-09.json`. Package snapshots mirror them byte-for-byte via `cli/scripts/sync-subscription-catalog.js`, with equality test. Public inventory has exact observed anchor titles and source URLs, PDF-extracted effective-date wording or explicit null, timestamp/method/status, SKU and applicability unknowns. A Control Tower index/PDF date disagreement is explicitly preserved. Private text extractions are `/home/jace/.hermes/cache/scratch/506-public-*.txt` (28 files); these are not raw PDFs. No binary hash, redistribution right or hosted PDF is asserted.

Normalization: API complete for its small two-section meter (managed API CI, 1 resource/SU); Integration Hub/WDF partial (transaction definition, current explicit SKU codes, exceptions; legacy packaging pending); historical overview partial (ITOM sections 1.1–1.3 only: server 1, PaaS 3, container 3, unresolved object 1 resources/SU). 25 inventory documents still pending substantive normalization. Existing April 2026 ITOM remains normalized. Thus 29 catalog records reference 28 unique documents: existing ITOM plus its inventory entry are deliberately separate, not two sources. This is meaningful first batch, **not completion of each-PDF rewrite**. Exact pending entries are queryable by normalization_status in inventory.

HRSD remains an explicit gap, not a fabricated catalog definition: no HRSD PDF on index. Independently retrieved primary public `https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-administration/types-subscription-v2.md` (frontmatter updated 2026-09-10) defines Unrestricted User as active sys_user with nonempty User ID regardless of roles. It does not establish HRSD SKU applicability. Do not use sys_user role counts or claim PDI HRSD eligibility. No new live probes needed/performed; existing ITOM live coverage is inherited evidence, not reverified here.

CLI: `subscriptions schedules --product <exact product> --sku <exact code> --id <exact ID>` filters local data only; JSON/get and styled output work. Exact historical selection never runs the modern adapter. Known catalog products reject estimate as measurement_unavailable, unknown products remain unsupported_product. No default switch to historical terms; existing provisional 2026 disclaimer retained. Current ITOM counts/overlap/ratios/literal typo/partial coverage/total null untouched.

## Rails specialist boundary

Read site README, routes and SnapshotsController. Existing `/docs-index/manifest.json` and immutable artifacts deliver SQLite docs, not licensing. `site/config/subscription-schedules/README.md` defines proposed versioned JSON delivery and validation/offline-cache behavior, source-PDF rights gate, endpoint paths explicitly **not implemented**, and hostname discrepancy (requested jsn.js.pro vs repository jsn.jace.pro). No Rails controllers/models/migrations/runtime changed, no endpoint configured, no HTTP/cache refresh implemented, no publication. Specialist handoff must implement and verify those separately.

## Final execution receipts

All checks from candidate `cli/`, finite timeouts, no integration-test opt-in:

- `node scripts/sync-subscription-catalog.js`: exit 0.
- `timeout 90 node --test test/subscriptions.test.js test/subscription-catalog.test.js`: exit 0; 29 tests pass, zero fail/skip. Final repeat after adding actual CLI refusal assertions also passed (same 29 tests).
- `timeout 120 npm run lint`: exit 0.
- `timeout 180 npm test`: exit 0; 2517 tests, 2514 pass, 3 skip, zero fail. Final repeat after actual CLI refusal assertions also passed with these counts.
- `git diff --check`: exit 0.
- Actual `node cli/bin/jsn.js subscriptions schedules --product API --get 'data.schedules[0].meter'`: exit 0; independently returned API 1 resource/SU definition.
- Actual `subscriptions estimate API --json`: exit 1 with actionable known-product/unimplemented message before instance access. Existing AppError rendering emits plain error text here despite --json; no new successful JSON-report claim for refusals.

Logs `/home/jace/.hermes/cache/scratch/506-catalog-{focused,lint,full}.log`. New tests verify canonical/snapshot identity, exact historical ratios and no adapter substitution, inventory provenance/status/schema essentials, unique-source count, known vs unknown products, and actual CLI product/SKU/ID human/JSON/get reads with unusable proxy settings. No endpoint refresh exists: local reads perform no network transport.

Remaining: 25 substantive rewrites, omitted sections in two partial records, exhaustive archive discovery, HRSD applicability and population, source PDF hosting rights/bytes, Rails delivery + CLI refresh cache, observed 90-day consumption and purchased rights. Holly owns independent exact revision review/reproduction. No push/PR/merge/deploy or overall completion claim.

