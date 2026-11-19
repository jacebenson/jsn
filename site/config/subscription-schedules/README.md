# Subscription schedule source data (not yet served)

These curated files are canonical. `cli/src/schedules/` contains generated offline snapshots, not another authored catalog. Run `node cli/scripts/sync-subscription-catalog.js`; an offline test enforces byte equality. No Rails route serves this directory today.

## Proposed version 1 delivery contract — Rails specialist handoff

Inspected `site/config/routes.rb`, `SnapshotsController`, and site README. Existing `/docs-index/manifest.json` and immutable `/docs-index/artifacts/:filename` deliver verified SQLite documentation snapshots; `/api/docs/*` searches documentation, not licensing records. Do not put schedule JSON in that SQLite artifact or claim these APIs already serve schedules.

Smallest analogous extension: specialist-owned **proposed**, not available, `/subscription-schedules/v1/manifest.json` with `{schema_version:1, revision:<content digest>, catalog_url:<immutable artifact URL>, sha256:<artifact bytes>, published_at:<ISO timestamp>}` and `/subscription-schedules/v1/artifacts/<sha256>.json` with `{schema_version:1, revision, schedules:[...]}`. Reuse immutable-public-cache/atomic-promotion and safe file handling patterns, not the docs-specific filename regex or release semantics. Add public product/version browsing linked to source PDFs. Confirm canonical hostname: user specified jsn.js.pro, repository README currently names jsn.jace.pro. No remote availability was verified.

Consumer behavior: explicit refresh only; verify HTTPS origin, version, size cap, digest, unique IDs and required provenance before atomic cache replacement. Keep last-good validated snapshot on errors; report its revision/retrieval time and stale state, never silently select latest historical terms. Offline reads must never refresh or need auth. This slice implements bundled offline consumption only, not HTTP refresh or a persistent mutable cache. No endpoint URL is configured until specialist implementation and readback verification.

Record fields: stable `id`, `product`, source `title`, `source_url`, discovery `index_url`, effective-date wording/provenance (null if not normalized), retrieval timestamp/method/status, normalization status, explicit `skus` (empty means unverified), applicability, meter and source sections when normalized, exceptions and unknowns. Pending records are inventory, not meter definitions. Document may cover several products/versions; partial records must identify omitted sections. Dates do not prove incorporated terms.

## Current coverage and rights boundary

28 unique PDF links observed on the public entitlement supplements index; all 28 extracted once through web_extract. Inventory has one fully normalized new document (API), two partial documents (Integration Hub and historical ITOM section), 25 pending. Existing April 2026 ITOM normalized record is retained separately and shares one inventory source URL: 29 records, **28 documents**, not 29 distinct sources. Original source bytes were not downloaded, so hashes remain null. Private extracted text is evidence, not PDF bytes. No redistribution permission established: preserve source links; specialist must establish rights before hosting original PDFs. Do not synthesize PDF assets or claim text extraction hashes are PDF hashes.

Archive failed browser with ERR_HTTP2_PROTOCOL_ERROR and text extraction; the index's generic Subscription Unit Overview nevertheless yielded historical July 23, 2020 terms. Historical coverage is not exhaustive. HRSD has no PDF link on this index. Public Australia types-subscription-v2 documentation defines an Unrestricted User as an active sys_user with nonempty User ID, irrespective of roles, but does not establish HRSD SKU applicability. No HRSD meter mapping or estimator is asserted. Resolve contract/product meter and eligible organizational population before implementing, never substitute role counts.

Next specialist must validate delivery schema, add request tests, immutable artifacts and public browse pages, permission-reviewed source assets, promotion integrity and CLI HTTP/cache acceptance. No controllers, models, migrations, deployments or publishing changed here.
