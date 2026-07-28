# jsn docs — ServiceNow Documentation Search

Merge `servicenow-docs-sqlite` into jsn as a first-class command group.

## Commands

```
jsn docs sync        — clone/prune ServiceNowDocs → ingest → embed
jsn docs status      — DB version, age, size, topic count
jsn docs search      — CLI search (FTS5 + HRR hybrid)
jsn docs serve       — node:http web UI (default http://localhost:3000)
```

### Sync

1. Shallow-clones `https://github.com/ServiceNow/ServiceNowDocs` (branch `australia`)
   into `~/.cache/servicenow-cli/docs/source/`
2. Re-ingests the markdown folder into `~/.cache/servicenow-cli/docs/docs.db`
3. Rebuilds HRR vectors for hybrid semantic search

On subsequent runs, does `git pull` inside the source folder, then incremental
refresh (content-hash diff via `refresh.js`).

**Keep source after sync.** If an ingest/embed step fails, user can rerun
against the existing clone without a fresh download. Source sticks around until
the next `jsn docs sync` replaces it.

### Status

Reads metadata from `docs.db`:

- Version (from `meta` table or package version)
- Age of the index
- Number of topics/documents
- Path to DB and source
- Last sync timestamp

### Search

```
jsn docs search "<query>" [--limit 20] [--bundle <name>] [--doc-type <type>] [--json]
```

FTS5 keyword search with optional HRR semantic boost. Results include:
- Snippet with highlighted match
- Document path and breadcrumb
- Publication/bundle name
- Score

### Serve

Built-in HTTP server using Node's `node:http` module (no Express dependency).

Endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI (static HTML + JS) |
| `GET /search?q=...&limit=&bundle=&doc_type=` | FTS5 search with snippets |
| `GET /doc/:id` | Full document by id |
| `GET /doc?path=<relative/path.md>` | Full document by path |
| `GET /bundles` | Bundle list with counts |
| `GET /stats` | Document count + metadata |
| `GET /health` | Liveness check |

## File layout inside jsn

```
src/commands/docs/
├── docs.js          # command builder (sync, status, search, serve subcommands)
├── sync.js          # git clone/pull + orchestrate ingest + embed
├── search.js        # FTS5 + HRR query CLI
├── serve.js         # node:http server
├── ingest.js        # markdown → SQLite (from servicenow-docs-sqlite)
├── embed.js         # HRR vector embedding (from servicenow-docs-sqlite)
├── hrr.js           # HRR vector math (from servicenow-docs-sqlite)
├── refresh.js       # incremental content-hash refresh (from servicenow-docs-sqlite)
├── db.js            # DB path resolution (XDG cache), schema helpers
├── public/          # static files for web UI (HTML, CSS, JS)
```

## Decisions

| Decision | Choice |
|----------|--------|
| DB location | `~/.cache/servicenow-cli/docs/docs.db` |
| Source location | `~/.cache/servicenow-cli/docs/source/` (kept after sync) |
| Sync method | Clone ServiceNowDocs + ingest from source (no pre-built download) |
| HTTP framework | `node:http` (rip out Express dependency) |
| Semantic search | Keep HRR/embed layer |
| Personal docs overlay | Cut from v1 |
| Doc rendering | Just the inline web UI served by `node:http` |
| Pre-built download | Deferred — no hosting decision yet |
| Update check | `jsn docs status` compares installed version against upstream |
| Who's it for | Both CLI (agent) and web UI (human) |

## Dependencies

- `gray-matter` (already used by the existing code)
- `node:sqlite` (built-in Node 22.5+)
- `node:http` (built-in)
- No Express, no Python, no native builds

## Open questions (deferred)

- Pre-built DB hosting (CDN? GitHub releases? Self-hosted?)
- Version negotiation between CLI and DB schema
- Personal doc overlay via skills folder
