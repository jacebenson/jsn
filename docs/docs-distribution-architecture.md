# Documentation service and snapshot architecture

Decision for #324, recorded before moving the serving layer.

## Current ownership and deployment

The CLI and its public documentation live in this repository. `docs/` is a
separate Eleventy npm project; its configuration explicitly records deployment
through Coolify/Nixpacks. The npm split prevents the website build from installing
native CLI dependencies. There is no website deployment workflow or infrastructure
configuration in this checkout, so host secrets, service settings and DNS remain
external deployment configuration. The README also links the older GitHub Pages
address. Both URL forms need preservation when switching the serving process.

ServiceNow reference content comes from the `australia` branch of
`ServiceNow/ServiceNowDocs`, cloned by `src/commands/docs/sync.js`. Ingestion,
FTS5 schema, semantic embeddings and local search live in
`src/commands/docs/`. Indexes are local SQLite files under `~/.jsn/docs`, not
website assets. npm installation currently does not download this corpus.

## Decision

Keep the Rails service in `site/` in this repository. A second repository would
separate schema changes from the CLI installer that must read them and duplicate
URL migration work. Keep the CLI in Node; reuse its existing ingestion and search
schema for the central builder. Keep `docs/` as the documentation content/build
source initially: Rails replaces the serving process, while generated HTML and
assets preserve all existing public paths, metadata, canonical links, robots and
sitemap output. This avoids rewriting editorial templates during infrastructure
migration. A later template migration can be independent.

Rails owns a small application database for source revisions, build jobs and
published artifact manifests. It does not serve the downloadable index from its
application database. The builder creates an isolated SQLite index, validates
FTS5/schema/integrity, checkpoints it, compresses it and publishes immutable,
revision-addressed artifacts to GitHub Releases (or compatible object storage).
A stable manifest contains artifact URL, source revision, schema compatibility,
compressed/uncompressed sizes and SHA-256. Artifact bytes go directly from storage
to the CLI. Promotion of the stable manifest is the final publication step;
failed builds leave the previous artifact and manifest untouched.

## Pipelines and migration

Website CI builds the existing docs content, tests preserved paths and Rails
routes, then produces a separately deployable container from `site/`. Deploys
follow changes to the site/docs paths, independently of npm publish/release tags.
The central index workflow runs on a schedule, manual dispatch or source-change
notification, checks the current upstream revision and skips unchanged content.
It reuses ingestion in an isolated directory. Publication requires the validated
artifact and does not modify an installed user's index.

Switch the existing Coolify service build context to the new container only after
its URL checks pass. Keep the existing domain; preserve GitHub Pages redirects or
its existing published pages during transition. Actual host configuration and
DNS cannot be established from repository contents and require deployment access.
Do not claim the production migration complete merely because a container builds.
Rollback the serving container independently of CLI releases; keep immutable
snapshots and the previous stable manifest for rollback.

## CLI installation and compatibility

Documentation remains optional. `docs install --source github` explicitly builds
raw source locally (approximately 51,000 files; 5–25 minutes is a labeled estimate based on prior runs and the measured full
semantic build, not a promise). `--source snapshot` downloads a prebuilt searchable database, shows
manifest bytes and a labeled transfer estimate, verifies checksum/schema/integrity
and atomically replaces only the docs index. `--source skip` is explicit. Setup
offers the same choices; noninteractive invocations select a source explicitly.
First search with no index requests approval or gives an actionable command when
prompts are unavailable. Existing indexes search immediately offline; freshness
checks are bounded to once per day and must not delay or invalidate local search.
Manual `docs sync` remains available. Interrupted or incompatible installs retain
the existing database. Mutation history has a separate database and lifecycle.
