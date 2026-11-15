# Documentation sources

`docs/` is Markdown and contributor evidence, not a separate website project.

## Public JSN guides

`site/config/guides.json` is the explicit publication allowlist. Its values point
to the single maintained Markdown source here; Rails renders them at `/docs/<key>/`.
The five getting-started sources are `docs-install.md`, `docs-setup.md`,
`docs-safety.md`, `docs-output.md`, and `docs-agents.md`. Other allowlisted sources
cover CLI workflows. Existing filenames remain stable for repository links and
parallel documentation work; adding a file here does **not** publish it.

## Contributor material (not published as HTML)

Architecture/decision records (`DECISIONS.md`, `docs-distribution-architecture.md`),
state, parity reports, test audits, `evidence/`, `verification/`, and source-backed
`research/` notes (see [research/README.md](research/README.md)) remain source
records for contributors. They are not copied into the public document root.
The old generator accidentally published these. Their old URLs deliberately
redirect to the corresponding canonical GitHub source, never to a generic guide.
`site/config/legacy-guide-urls.json` records every redirect; the original 54-URL
HTML inventory is retained in `site/config/preserved-urls.json` and exercised by
the Rails suite. Workflow guides formerly at root paths redirect to `/docs/.../`.

## Website ownership and checks

`site/data/` owns original showcases, SEO data and demos; `site/static/` owns
public CSS, media and the unchanged versioned WebMCP bundle. Asset preparation
(`npm run docs`) derives `site/config/features.json`, public assets, sitemap,
robots and llms text without npm dependencies or generated Markdown HTML.
Run these npm commands from the repository root, not `cli/`. The published CLI
package has no website build or preview scripts. `npm run docs:serve` launches
the isolated Rails preview; `npm run docs:serve -- --test` runs its Rails tests.
Runtime Markdown uses
the existing vendored Marked parser; Rails sanitizes its output and restricts
source lookup and local links. `/documentation` and `/api/docs/*` remain the
separate ServiceNow corpus reader/search service, unchanged by this migration.

Run `site/bin/preview --test`, `node --test site/test/*.test.mjs`, `npm test`, and
`npm run lint`. Container CI retains `tmp/preserved-urls.json` as its URL artifact.
