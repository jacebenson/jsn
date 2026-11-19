# Subscription schedule source data (not yet served)

These curated files are canonical. `cli/src/schedules/` contains generated offline snapshots, not another authored catalog. Run `node cli/scripts/sync-subscription-catalog.js`; an offline test enforces byte equality. No Rails route serves this directory today.

## Proposed version 1 delivery contract — Rails specialist handoff

Inspected `site/config/routes.rb`, `SnapshotsController`, and site README. Existing `/docs-index/manifest.json` and immutable `/docs-index/artifacts/:filename` deliver verified SQLite documentation snapshots; `/api/docs/*` searches documentation, not licensing records. Do not put schedule JSON in that SQLite artifact or claim these APIs already serve schedules.

Smallest analogous extension: specialist-owned **proposed**, not available, `/subscription-schedules/v1/manifest.json` with `{schema_version:1, revision:<content digest>, catalog_url:<immutable artifact URL>, sha256:<artifact bytes>, published_at:<ISO timestamp>}` and `/subscription-schedules/v1/artifacts/<sha256>.json` with `{schema_version:1, revision, schedules:[...]}`. Reuse immutable-public-cache/atomic-promotion and safe file handling patterns, not the docs-specific filename regex or release semantics. Add public product/version browsing linked to source PDFs. Confirm canonical hostname: user specified jsn.js.pro, repository README currently names jsn.jace.pro. No remote availability was verified.

Consumer behavior: explicit refresh only; verify HTTPS origin, version, size cap, digest, unique IDs and required provenance before atomic cache replacement. Keep last-good validated snapshot on errors; report its revision/retrieval time and stale state, never silently select latest historical terms. Offline reads must never refresh or need auth. This slice implements bundled offline consumption only, not HTTP refresh or a persistent mutable cache. No endpoint URL is configured until specialist implementation and readback verification.

Record fields: stable `id`, `product`, source `title`, `source_url`, discovery `index_url`, effective-date wording/provenance (null if not normalized), retrieval timestamp/method/status, normalization status, explicit `skus` (empty means unverified), applicability, meter and source sections when normalized, exceptions and unknowns. Pending records are inventory, not meter definitions. Document may cover several products/versions; partial records must identify omitted sections. Dates do not prove incorporated terms.

## Current coverage and rights boundary

27 of the 28 unique public PDF documents now have substantive JSN-authored representations of all extracted sections; the remaining USEM document is fully read/re-written but **partial** because its own ratio table and definitions conflict. No documents remain pending or retrieval-blocked. Inventory contains 31 records (30 normalized, 1 partial): the historical July 2020 overview is split into ITOM, SAM, HAM and TNPM with deterministic suffix IDs. With the preserved April 2026 ITOM estimator record there are **32 records referring to 28 documents**, not 32 sources. Original source bytes were not downloaded, so hashes remain null. Private extracted text is evidence, not PDF bytes. No redistribution permission established: preserve source links; specialist must establish rights before hosting original PDFs. Do not synthesize PDF assets or claim text extraction hashes are PDF hashes.

Archive failed browser with ERR_HTTP2_PROTOCOL_ERROR and text extraction; the index's generic Subscription Unit Overview nevertheless yielded historical July 23, 2020 terms. Historical coverage is not exhaustive. HRSD has no PDF link on this index. Public Australia types-subscription-v2 documentation defines an Unrestricted User as an active sys_user with nonempty User ID, irrespective of roles, but does not establish HRSD SKU applicability. No HRSD meter mapping or estimator is asserted. Resolve contract/product meter and eligible organizational population before implementing, never substitute role counts.

## Normalized representation and inspection

`title` retains the observed public index anchor. `source_document_title` identifies the document; `provenance` binds source URL, title, date/version and named sections. Each JSN-authored `definitions` entry carries source sections. `scope`, `entitlements`, `exceptions`, `unknowns` and `section_coverage` preserve applicability and uncertainties. `normalized` means the extracted sections were read and rewritten, **not** that the vendor validated the rewrite, the contract applies, or usage was measured. `measurement: unimplemented` remains on every inventory record.

Meter shapes deliberately differ:
- `resources_per_su` means divide eligible resource quantity by that number; no rounding/deduplication policy inferred.
- Explicit `subscription_units` and `resource_quantity` retain literal SU:resource orientation for EAM and OTAM, including their unusual 25:1 and 4:1 rows. Never silently invert them to resemble other products.
- `rules` preserve usage events, credit/Assist amounts, windows, peaks, batches and conditions. Otto has 285 skill rows, including conditional Search and Voice workflow references, not a single flat per-call charge. Its original private extract was truncated; the preserved full 24-page extraction was read and rates reconciled in order before normalization.
- `unit: null` explicitly means the document grants/classifies entitlements rather than defining a numeric consumption meter (Foundation, Custom Table Guide and fee-only Overage). Pricing is omitted; consult source for fees.
- USEM uses `status: ambiguous_source` and `source_rows`, not calculable ratios: left quantities conflict with repeated right-side `(1:1)` labels; prose/table image and application classes differ, FaaS lists Cloud Directory, and AI Asset prose lacks a matching table. These are precise unresolved source conflicts, not guessed corrections.

Null effective dates are retained when the source only has a version date or SKU-introduction wording; `source_version` preserves that wording. Integration Hub has no extracted effective-date label. Explicit package codes are source-backed; shared legacy codes can appear in multiple named package rows, so a code is not a uniquely inferred commercial mapping.

Offline examples from repository root:

```sh
node cli/bin/jsn.js subscriptions schedules --id servicenow-otto-overview --styled
node cli/bin/jsn.js subscriptions schedules --id custom-table-guide --json
node cli/bin/jsn.js subscriptions schedules --id snc-addendum-integrationhub --get 'data.schedules[0].packages'
node cli/bin/jsn.js subscriptions schedules --id servicenow-subscription-unit-overview-sam --styled
node cli/bin/jsn.js subscriptions schedules --id unified-security-exposure-management-servicenow-subscription-unit-overview --get 'data.schedules[0].unknowns'
```

`--id` human output expands every field, definition, rule and source section; JSON/get retain the structured object. Unfiltered listings remain compact. These reads require no instance and never refresh HTTP.

Next specialist must validate delivery schema, add request tests, immutable artifacts and public browse pages, permission-reviewed source assets, promotion integrity and CLI HTTP/cache acceptance. No controllers, models, migrations, deployments or publishing changed here.
