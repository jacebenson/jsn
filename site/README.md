# JSN documentation website and API

The site is a public documentation service and JSN feature/video library.
Visitors search and read without downloading an index or creating an account.
The SQLite documentation index stays on the server. Website accounts are only
for publishing administration and are separate from ServiceNow/CLI credentials.

## Local development

From the repository root, build the static JSN setup/reference pages once:

```sh
npm ci
npm --prefix docs ci
node scripts/build-docs-site.mjs
cd site
bin/bundle install
bin/rails db:prepare
bin/dev
```

Open http://localhost:3000/documentation. `bin/dev` runs the web server and a
separate daily sync worker. The first sync clones the public
`https://github.com/ServiceNow/ServiceNowDocs.git` repository's `australia` branch
and builds its FTS5 index. Search reports that preparation is in progress until
that initial build is published. Existing indexes remain searchable during later
builds. There is no account requirement for the public API or documentation.

Use `bin/bundle` to bypass the host's unconfigured Bundler shim. Node (see the
root package's engine floor), Git, Ruby 3.4, and the existing npm/gem dependencies
are required. No queue service or additional package dependencies were added.

## Sync and recovery

```sh
bin/rails docs:sync  # explicit sync; uses an OS lock to prevent overlapping runs
bin/docs-worker     # standalone scheduler if web and sync run separately
```

The worker checks after startup and at most once per 24 hours after success.
Failures retry after one hour. It runs only while this process/container runs;
this is not a machine-wide cron installation. `bin/serve` supervises web and
worker processes and forwards shutdown signals. `DOCS_SYNC_DISABLED=1 bin/dev`
runs only the web server. Sync output goes to process logs; a sanitized summary
is exposed at `/api/docs/status` and on the admin page. Detailed failures remain
in `storage/docs/status.json` and the worker logs.

The service owns `storage/docs/source`; never point it at a developer's checkout.
It fetches the upstream branch, then reuses `src/commands/docs/ingest.js` and
`refresh.js`. First build omits semantic embeddings; searches use FTS5.
Subsequent revisions incrementally apply additions, edits and deletions to a
SQLite backup of the published index. Unchanged Git revisions skip rebuilding.
The staged database must be nonempty, have zero ingestion errors, and pass SQLite
and FTS integrity checks before an atomic rename publishes it. An interrupted or
failed build leaves the last good index in place. The next run retries safely.

Configuration:

- `DOCS_STORAGE_DIR`: persistent docs storage (default `site/storage/docs`).
- `DOCS_SOURCE_URL`: public source clone URL (default ServiceNowDocs above).
- `DOCS_SOURCE_BRANCH`: release branch (default `australia`).
- `NODE_BIN`: optional Node executable for the Rails sync task.

The metadata database in `storage/development.sqlite3` (or production equivalent)
contains accounts and video links, not the documentation corpus. Back up both
storage areas. A clone plus published and staging indexes needs more disk space
than just one database.

## Public REST API

```text
GET /api/docs/search?q=GlideRecord&limit=20&offset=0
GET /api/docs/search?q=GlideRecord&bundle=api
GET /api/docs/document?path=some/path.md
GET /api/docs/123?revision=<revision-from-search>
GET /api/docs/status
```

Search returns `query`, `revision`, `total`, `count`, `limit`, `offset` and
`results` (ID, path, title, bundle, type, release, snippet). Read returns
`revision` and `document` including the Markdown `body`. Search text is plain
words, not executable FTS syntax; words are combined with AND. Queries are capped
at 200 characters/20 terms, pages at 50 results, offsets at 10000. Unknown docs
return 404, invalid search inputs 400, unavailable indexes 503, and a mismatched
revision on read 409. Paths are stable references; numeric IDs are scoped to an
index revision. Send the search revision when following an ID.

API responses may be cached for one minute. API traffic is limited to 120
requests per minute per client IP in process memory; browser search has its own
same-sized limit. Limits reset on restart and are per process. Configure a
reverse-proxy limit for a shared production-wide policy. No authentication token
is needed. The CLI uses these endpoints through `jsn docs search`, `show`, and `status`.
Use `JSN_DOCS_URL=http://localhost:3000` to test the local site. The production
default is `https://jsn.jace.pro`, which requires deploying this service.

## Administration and recordings

Public signup is disabled. Existing administrators can log in at `/login`.
Create an administrator from a terminal with hidden password input:

```sh
bin/rails admin:create
```

Passwords require 8–128 characters, use salted PBKDF2-HMAC-SHA256 via Ruby OpenSSL,
and browser sessions are revocable SQLite records with a 30-day lifetime.
Forms use Rails CSRF protection. No email/password recovery service is configured.
Login attempts are limited in memory. Existing ordinary accounts have no admin
access and no public registration route remains.

At `/admin`, review sync status and publish an HTTPS recording URL per feature.
Direct MP4/WebM links render a native video player; hosted watch-page URLs open at
the provider. Clear a URL to remove a video. The app does not upload video files.
Feature and documentation pages remain public. The feature catalog comes from
`docs/_data/showcases.js`, exported during the site build; Rails owns `/` and
`/features`, while Eleventy builds the remaining static documentation URL tree.

## Tests

After building the static docs, from `site/`:

```sh
RAILS_ENV=test bin/rails db:prepare
bin/bundle exec ruby -Itest -e 'Dir["test/*_test.rb"].each { |f| require_relative f }'
node --test test/sync-docs.test.mjs
```

Tests cover public API/search/reads, input limits, revision mismatch, sanitized
Markdown, account/session security, video publishing, preserved static docs, and
Git fixture additions/edits/deletions, unchanged revisions, and failed publication.

## Deployment

Build from the repository root using `site/Dockerfile`. It includes the existing
Node ingester and starts `bin/serve` with the daily worker. Persist
`/app/site/storage` and set `SECRET_KEY_BASE`. The reverse proxy terminates TLS;
production Rails assumes HTTPS. Keep its public search/read endpoints available
without a proxy login wall. Hosting and proxy configuration are not changed by
this repository. The Docker image requires a separate deployment/build check.

Legacy snapshot registry routes (`/docs-index/*`, `/internal/docs-builds`) remain
for compatibility with earlier work and require a published snapshot manifest;
they are not prerequisites for the public search/read service. Snapshot
publication still uses `DOCS_PUBLISH_TOKEN`. The CLI release process remains
independent from the Rails service.

## Documentation presentation

The reader reuses the CLI's already-vendored Marked parser and DOMPurify (served
locally, without a CDN). A readable server-rendered fallback is enhanced with
GitHub-style Markdown tables, code coloring/copy controls, heading permalinks,
contents navigation, and local links between documents. `markdown.js` normalizes
known upstream HTML/Markdown block-boundary defects only for display and excludes
fenced/indented code. Stored Markdown and REST bodies remain original. Regression
fixtures use malformed source rather than editing the upstream documentation.

Run renderer compatibility tests with `node --test test/markdown.test.mjs`.

Search results prefer the upstream frontmatter `description`, cleaned of inline
Markdown and shortened at a sentence boundary when possible. Missing descriptions
fall back to the first prose paragraph, skipping headings, tables and code.
Results include `summary`, `summary_source` and `category`; original snippets and
Markdown remain available separately. Product/classification/path metadata supplies
the category rather than displaying an empty bundle/type separator.

## Staging and homepage introduction

Keep the existing Eleventy deployment at `jsn.jace.pro` until the Rails site and
recordings are ready. The Rails preview is intended for `jsn2.jace.pro` on Chonky
through Coolify. Deploy it as a separate application/branch; do not repoint or
restart the existing production app. Eleventy remains in the repository and
currently builds the JSN setup/reference pages for the preview image too.

The homepage reserves the main video area for the introductory walkthrough.
Until footage has been recorded and edited, it deliberately says “Video coming
soon.” Its ten chapter descriptions follow the install/connect/update-set/build/
test/complete story. Admins can later publish the “Homepage introduction” URL;
MP4/WebM links become a native player, while watch-page links open the recording.
