# JSN documentation service

See `docs/docs-distribution-architecture.md` for the repository/deployment decision.
This Rails app serves the existing generated URL tree and a small snapshot registry.
The Node CLI and its release process remain separate. No Redis, asset framework,
mail service or Rails-managed downloadable index database is required.

From the repository root:

```sh
npm --prefix docs ci
node scripts/build-docs-site.mjs
cd site
bundle install
bin/rails db:prepare
bin/rails server
```

Tests: build the docs first, then run `RAILS_ENV=test bin/rails db:prepare` and
`bundle exec ruby test/site_test.rb`. Site CI performs both steps. Generated HTML
is not checked into Git. The existing Eleventy project remains the content builder;
Rails replaces the production serving process.

Deploy the repository-root Dockerfile `site/Dockerfile`. Persist `/app/site/storage`
and set `SECRET_KEY_BASE`, `DOCS_PUBLISH_TOKEN`, `SITE_DATABASE_PATH` if overriding
storage, and optionally `DOCS_ARTIFACT_HOSTS` (comma-separated; default github.com).
The reverse proxy terminates TLS; production Rails assumes HTTPS. Configure the
existing Coolify service to build this Dockerfile and retain `jsn.jace.pro`; the
repository cannot change host configuration or legacy GitHub Pages settings.

`GET /docs-index/manifest.json` returns the last successfully published manifest;
503 means no artifact has been published. `/docs-index/download` redirects to
artifact storage. `POST /internal/docs-builds` requires a bearer publisher token
and records `building`, `failed` or `published`. Only validated publication changes
the active revision; failed builds never replace it. Snapshot bytes stay on GitHub
Releases/object storage. The index workflow requires the repository secret
`DOCS_PUBLISH_TOKEN` and optional variable `DOCS_SITE_URL` (default jsn.jace.pro).
Use different credentials for this publisher and GitHub's scoped workflow token.

Rollback the serving container independently from npm. To roll back the active
artifact, repost a previously published, compatible manifest through the same
protected endpoint; immutable releases remain available. Local CLI users can use
`jsn docs rollback` to restore their prior installed index.
