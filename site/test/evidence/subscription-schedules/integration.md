# Private local integration candidate — issue 506

This extends integrated baseline `c65c122` in the sole-writer worktree `/home/jace/workspace/holly/scratch/jsn-506`. Early implementation checkpoint: `aa2f2c7`. No catalog source rewrites, source PDF downloads/hosting, dependency changes, push, PR, deployment or publication. Existing untracked original research is preserved.

## Implemented contract

- `jsn subscriptions refresh --manifest-url <URL>` is the only network refresh path. It requires no instance/provider/auth and uses the standard output envelope.
- Selection precedence: flag, `JSN_SCHEDULES_MANIFEST_URL`, global `docs.schedule_manifest_url`, then `/subscription-schedules/v1/manifest.json` on explicitly configured existing `JSN_DOCS_URL` or global `docs.url`. No new default deployment hostname.
- HTTPS required, except explicitly selected loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`). Artifact origin must exactly match manifest origin; credentials, fragments, redirects and non-HTTP(S) URLs rejected. No ambient auth headers/cookies are attached.
- Manifest cap 16 KiB; artifact cap 4 MiB including streamed bodies; serialized cache cap 8 MiB; each GET timeout 10 seconds. Strict v1 envelope/manifest, exact bytes/SHA256/revision, unique safe IDs, source provenance and rendering-critical record types are checked. Unknown additive fields survive. JSON nesting capped at 32; invalid UTF-8/BOM is rejected before replacement.
- Cache at `$XDG_CACHE_HOME/servicenow/subscription-schedules-v1.json` (normal home cache fallback). Same-directory random exclusive temporary file, restrictive mode, then atomic rename. Errors before replacement leave last-good bytes intact. Offline reads revalidate cache hash/schema and fall back to bundled records if corrupt.
- Offline JSON/get and human output carry cache/bundle provenance, revision and retrieval time where available, stale flag (24-hour age threshold), and explicit notice that no network freshness check occurred. One inspection uses one validated snapshot for records, coverage and provenance.
- The April 2026 ITOM estimator always loads the bundled adapter record. A cache ID collision cannot change its ratios. Generic normalized schedules remain inspection-only; no new product estimator is inferred.
- Rails detail now includes scope, entitlements, packages, capability lists, section coverage and provenance through the existing escaped recursive renderer, alongside definitions, meters/rules, ratios, exceptions and unknowns. Legacy ITOM hash definitions remain readable in CLI detail.

## Actual local receipts

Private raw evidence: `.task-evidence/` under this worktree (ignored, not public site material).

- Final CLI refresh against real Rails 8.1.4/Puma with Ruby **3.4.10** at `http://127.0.0.1:3507`: exit **0**, `live-refresh.json`. Rails DB `.task-evidence/preview.sqlite3`, separate docs storage `.task-evidence/preview-docs`, sync disabled. Task-local locked gems reused from `/home/jace/workspace/holly/scratch/jsn-506-site/.task-evidence/bundle`.
- Served catalog: **32 records / 28 distinct PDF URLs**, **220375 artifact bytes**, revision `a5f95d9b9669df9504535530972ad403b991babee0b85978fb631ad732f67bc7`, artifact SHA256 `de248b700ef20b3ed78528eaa6fce6eb9c7882fac94e69fb57acc57b7fafad6d`.
- Stopped the Rails server, then real CLI Otto JSON and human inspection both exited **0** from validated cache, preserving all **285 skill rules**. Refresh against the stopped server exited **1**; `sha256sum -c .task-evidence/cache-before.sha256` returned **OK** afterward. `offline-inspect.json`, `offline-inspect.txt`, `offline-refresh.txt`.
- Real Chromium via task-local Playwright core at **1440x1000** and **390x844**: typed Otto search, selected product, submitted filter, followed complex detail, verified HTTPS original source link, meter/definitions and package content, one historical ITOM version result and explicit empty result. Zero page JS errors, no document horizontal overflow, visible source action. `browser-receipts.json`, `desktop/mobile-{filtered,complex,skills,packages}.png`, `desktop/mobile-complex-dom.txt`. Mobile complex/skills/packages and desktop packages screenshots visually inspected; readable wrapping, no horizontal clipping/overlap observed. Long source-backed detail intentionally scrolls vertically. Original PDF destination was not fetched or permission-reviewed.

## Tests and exits

All final Node commands ran from `cli/` (or root npm forwarding), not a mistaken root-relative direct test invocation.

| Gate | Actual result | Receipt |
|---|---|---|
| Focused subscription + HTTP fixture subprocess tests | 35 passed, 0 failed/skipped; exit 0 | `focused.log` |
| Full Node suite | 2523 tests: 2520 pass, 3 skipped, 0 fail; exit 0 | `node-full.log` |
| CLI ESLint | exit 0 | `lint.log` |
| Integrated Rails requests | 8 tests, 118 assertions, no failures/errors/skips; exit 0 | `rails-focused.log` |
| Full Rails suite | 103 tests, 2231 assertions, no failures/errors/skips; exit 0 | `rails-full.log` |
| Site Node tests | 17 pass, no failures/skips; exit 0 | `site-node.log` |
| Task-local RuboCop Lint/Syntax on service/controller/request test | 3 files, no offenses; exit 0 | `ruby-lint.log` |
| Site asset preparation | exit 0 | `assets.log` |

HTTP fixture uses the actual CLI subprocess and local HTTP server, covering success, configured origin/global manifest, hash/schema/record-shape/duplicate/source/unsafe-URL/revision/declared-size/stream-size/UTF8/BOM rejection, offline inspection, stale state, corrupt-cache fallback, stopped-network failure, byte-identical last-good retention, human/JSON/get parity, no HTTP calls during inspection, and estimator isolation from a colliding cached ID. Rails requests visit every integrated record and explicitly check complex skills/scope, packages/entitlements and Custom Table definitions. Existing ITOM fractional/permission/completeness tests remain green.

Initial probe failures were local execution mistakes (direct tests in the wrong cwd, Bundler path, unprepared test DB, missing GEM_HOME for task-local RuboCop), then corrected. A transient focused failure exposed a real cached April record without `skus`; filter now safely treats absent codes as unverified/empty. Final gates above are the corrected results, not earlier partial runs. No hosted CI, container build or external-provider run is claimed.

Tested source map `.task-evidence/source-hashes.json` SHA256: `428e07dcaf336468a5e5cac469762dcebe7de440591627c7c96699b93315a6f5` (implementation/tests/catalog/README, excluding this report). No implementation edits followed those final gates.

## Reproduce

From the exact worktree root:

```sh
npm test
npm run lint
npm run docs
cd site
export PATH=/home/jace/.local/share/mise/installs/ruby/3.4.10/bin:$PATH
export BUNDLE_PATH=/home/jace/workspace/holly/scratch/jsn-506-site/.task-evidence/bundle
export DATABASE_URL=sqlite3:/home/jace/workspace/holly/scratch/jsn-506/.task-evidence/test.sqlite3
export DOCS_STORAGE_DIR=/home/jace/workspace/holly/scratch/jsn-506/.task-evidence/docs
export DOCS_SYNC_DISABLED=1
sh bin/test
# Separate local preview, with its own DB/storage; do not start the sync worker:
RAILS_ENV=development DATABASE_URL=sqlite3:/home/jace/workspace/holly/scratch/jsn-506/.task-evidence/preview.sqlite3 DOCS_STORAGE_DIR=/home/jace/workspace/holly/scratch/jsn-506/.task-evidence/preview-docs bundle exec rails server -b 0.0.0.0 -p 3507 -P /home/jace/workspace/holly/scratch/jsn-506/.task-evidence/server.pid
```

Another shell, from root:

```sh
XDG_CACHE_HOME="$PWD/.task-evidence/cache" node cli/bin/jsn.js subscriptions refresh --manifest-url http://127.0.0.1:3507/subscription-schedules/v1/manifest.json --json
# Stop Rails, then this remains offline:
XDG_CACHE_HOME="$PWD/.task-evidence/cache" node cli/bin/jsn.js subscriptions schedules --id servicenow-otto-overview --styled
# Isolated fixture acceptance:
(cd cli && node --test test/schedule-cache.test.js test/subscription*.test.js)
```

## Remaining review/publication boundaries

Operator must review the **exact final commit** and independently source-sample rewritten records before calling the overall research/catalog goal complete. USEM remains source-conflicted/partial, original binary hashes remain null, archive coverage is not exhaustive, and product/contract applicability is not established. Current-only artifact retention is deliberate; historical digests return 404 after catalog changes, while clients retain their last-good cache. A SHA256 verifies transport integrity, not vendor approval or a signed publisher identity. Production TLS/proxy origin configuration, canonical hostname, hosted CI/container proof, publication approval and any future PDF rights remain outside this candidate. Preview server is stopped.
