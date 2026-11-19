# Subscription schedule website / v1 delivery contract

Local implementation candidate on `feat/506-schedule-site`, pinned catalog baseline `4a10b28bb7c83f16cd9714186225f74258f515dd`. No source catalog or CLI edits. No deployment, push, PR, external publication, fleet/profile change, source PDF hosting, or licensing-estimator claim.

## Public routes

- `GET /subscription-schedules`: anonymous HTML search, exact product filter and exact version/effective-wording filter (`q`, `product`, `version`). A reset and explicit empty state are available.
- `GET /subscription-schedules/:id`: stable allowlisted record lookup, rewritten definitions, meter/ratios, exceptions, limitations, SKU uncertainty and source provenance. Unknown IDs return 404. Shared site layout and navigation.
- `GET /subscription-schedules/v1/manifest.json`: JSON object `{schema_version:1,revision,sha256,bytes,published_at,catalog_url}`. Public, revalidate on each use.
- `GET /subscription-schedules/v1/artifacts/<sha256>.json`: exact UTF-8 JSON bytes, trailing newline. Object `{schema_version:1,revision,schedules:[...]}`. `application/json`, quoted SHA-256 ETag, nosniff, public max-age 31536000 immutable, matching conditional requests return 304.

`revision` is SHA-256 of Ruby JSON serialization of the ID-sorted records, with all additive source fields retained. `sha256` is separately SHA-256 of the **exact artifact bytes**, avoiding a self-referential digest. `bytes` is that artifact's byte size. `published_at` is the latest source retrieval timestamp (a reproducible catalog watermark, **not** server boot/deployment time). `catalog_url` uses the request's origin; no production hostname is assumed. Production must provide its normal trusted TLS proxy/origin configuration. Local development uses HTTP intentionally.

Smallest-safe variation from the proposed README: artifacts are deterministic read-only projections of the current checked-in catalog, not a writable publication registry. Only the current known digest is served; older/unknown digests return 404 after a catalog change. No path or filename supplied by a visitor is opened. A digest URL never returns different content. There is no historical artifact retention SLA or mutable latest alias. Consumers must verify size/schema/digest and retain their last-good snapshot on 404/503. A future retention requirement needs a separately reviewed persistent artifact publication lifecycle.

The two fixed source files are loaded and validated together; missing/malformed JSON, missing provenance/identity, duplicate IDs, unsafe source URLs and malformed rendering-critical shapes fail closed with generic 503/no-store. Unknown fields are retained in the download and do not require a schema bump. The UI renders supported normalized fields recursively as escaped text, not HTML. Data is not fetched, ingested, edited, or automatically declared applicable. All original links are HTTPS ServiceNow PDF links; original PDF bytes are not hosted.

## Local receipts

Private evidence root: `/home/jace/workspace/holly/scratch/jsn-506-site/.task-evidence/` (not committed; includes task-local gems, isolated verification copy, Chromium scripts/screenshots, test logs).

- Pinned runtime: Ruby 3.4.10, Rails 8.1.4 from lockfile. `mise exec ruby@3.4.10 -- bundle install` with `BUNDLE_PATH=$WORKTREE/.task-evidence/bundle`; no Gemfile/lockfile/global runtime changes.
- Shell/binstub nuance: use `PATH=/home/jace/.local/share/mise/installs/ruby/3.4.10/bin:$PATH`, not only `mise exec ... -- sh bin/test`, because nested shebangs otherwise select system Ruby. Actual initial failure retained in `full-suite.log` history; corrected prepared run below.
- Red: `ruby test/subscription_schedules_test.rb` before implementation: 3 runs, missing routes and catalog class (2 failures, 1 error). `red.log`.
- Focused green: 7 tests, 66 assertions, zero failures/errors/skips. `green.log`.
- Full Rails suite: `sh bin/test` against source-identical verification copy with generated public assets and sibling Node dependencies installed there: **102 runs, 2179 assertions, zero failures/errors/skips**. `full-prepared.log`.
- Existing documentation API tests pass in that full run, including revision guards, release isolation, source/path validation and immutable snapshot delivery.
- CI's site Node checks: `node --test test/sync-docs.test.mjs test/markdown.test.mjs test/webmcp.test.mjs`: **17 passed**, no skips/failures. `node-tests.log`.
- Lint: task-local RuboCop `--only Lint,Syntax --format simple` over changed Ruby application/test/routes: **4 files, no offenses**, exit 0. Repository site CI declares no Ruby style linter or RuboCop configuration; this is an additional lint gate, not an assertion that default repository-wide style cops pass. `lint.log`.
- Security: task-local Brakeman 8.1.0 full app scan: zero scanner errors, two weak pre-existing File Access warnings in `documentation_controller.rb:16` and `snapshots_controller.rb:31`, exit 3. Exact baseline archive scan has the same two warnings; no new warnings. `brakeman.log`, `brakeman-baseline.log`.
- Browser: real system Chromium via Playwright core, isolated headless contexts at 1440x1000 and 390x844. Typed search, selected ITOM, submitted form, followed 2026 detail, returned to catalog, selected July 23 2020 version, saw exactly one historical result, submitted absent term and observed empty state. Both have zero JS errors, nonzero visible source action, visible ratio table, body margin zero and document scrollWidth equal viewport width. Screenshots `desktop-detail.png`, `mobile-detail.png`, `desktop-filtered.png`, `mobile-filtered.png`; layout and HTTP receipts `browser-receipts.json`. Screenshots visually inspected, then ratio column width and contradictory fallback copy corrected and browser rerun.
- Live HTTP byte check: manifest origin `http://127.0.0.1:3506`, 34845-byte artifact, digest `817297f7fcd51a125e8c16a3a0be4b84b764228ee2b75c3624c6f60655b6ef00`; 29 records representing baseline catalog, **not** 29 independently normalized PDFs. `browser-receipts.json`.
- Preview server uses `DATABASE_URL=sqlite3:$WORKTREE/.task-evidence/preview.sqlite3`, `DOCS_STORAGE_DIR=$WORKTREE/.task-evidence/docs`, `DOCS_SYNC_DISABLED=1`; no production database, storage or credentials. Loopback port 3506. Full test copy uses its own `site/storage/test.sqlite3`.

## Reproduce HTTP download

```sh
curl -fsS http://127.0.0.1:3506/subscription-schedules
curl -fsS 'http://127.0.0.1:3506/subscription-schedules?product=ITOM&version=July%2023%2C%202020'
curl -fsS http://127.0.0.1:3506/subscription-schedules/itom-2026-04-09
curl -fsS http://127.0.0.1:3506/subscription-schedules/v1/manifest.json
curl -i http://127.0.0.1:3506/subscription-schedules/v1/artifacts/817297f7fcd51a125e8c16a3a0be4b84b764228ee2b75c3624c6f60655b6ef00.json
```

## Remaining boundaries

Coverage/normalization is independently incomplete and owned by another worker. This candidate intentionally uses only its pinned baseline source files. Re-run integration and digest tests after combining newer canonical data and CLI changes. Independent exact-revision review belongs to Holly. Local proof is not a deployed route, hosted CI/container proof, external original-PDF availability proof or permission to publish. Two existing security warnings remain as noted above. Production hostname selection remains unresolved but does not leak into these route URLs. No database migration or dependency added to the application.
