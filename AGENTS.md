# Working on jsn

These instructions are for building jsn. For using it against ServiceNow,
see `cli/README.md` or `jsn skill show`.

## Ownership and entry points

Only `.github/`, `cli/` and `site/` belong at the repository root.
Do not recreate a root `docs/` directory.

- `cli/`: published Node.js 24+ ESM package, no build step or TypeScript.
  Entry: `cli/bin/jsn.js` → `cli/src/cli.js`.
- `site/`: Rails website, Markdown in `site/docs/`, assets in `site/static/`.
  Docker builds use the repository root and `site/Dockerfile`.
- `.github/`: CI workflows and repository-only automation.

Read the owning code and package manifest before changing a feature or dependency.
Maintainer references are [architecture](site/docs/maintainers/architecture.md),
[domain contracts](site/docs/maintainers/domain-model.md), and
[testing](site/docs/maintainers/testing.md). Consult relevant sections on demand;
keep documentation consistent with verified code and tests.

## CLI rules

Paths below are relative to `cli/`.

- Register command modules in `src/cli.js`; route handlers through `wrap(handler)`.
  Reuse `_simple.js` and `_ticket.js` factories for table and ticket CRUD.
- Declare capabilities in `src/capabilities.js` through the command definition.
  Instance requirements, daily checks and mutation guards derive from that registry;
  do not maintain parallel command-name or mutation-path lists.
- Preserve strict argument validation, aliases, help and machine discovery.
- Preserve instance, read-only, confirmation and capture-context safeguards.
  Rejected operations must not write. Never weaken a guard to make tests pass.
- Emit command data through `app.output`, not `console.log`. Preserve JSON
  envelopes, `--get` extraction and existing human output formats.

## Verification

From the repository root:

```sh
npm --prefix cli ci
npm test
npm run lint
```

Run focused tests first, then the full suite and lint before pushing. Keep the
actual exit status; do not hide failures behind output-filtering pipelines.
Use `node:test` and test observable behavior at the lowest useful layer.
Inject fixture credentials/transports rather than using personal profiles or
keyrings. Test failure paths and zero writes on rejection. Structural assertions
need an explicit architectural rationale, not an incidental implementation detail.
Do not delete coverage to meet a numeric test-count or size target.

Live integration tests can create and delete instance records. They require
explicit opt-in and a suitable target; the ordinary suite needs no instance.
Set `JSN_NO_VERSION_CHECK=1` and `JSN_NO_SKILL_CHECK=1` in CLI fixtures.

Website asset preparation and preview are `npm run docs` and
`npm run docs:serve` at the root. Website changes also need the relevant site
checks documented in `site/README.md` and the maintainer testing guide.

## Delivery

Use a feature branch and a PR against `main` at `github.com/jacebenson/jsn`.
Preserve unrelated working-tree changes. Report failed, skipped and unrun checks
honestly; a local pass does not replace CI on the exact PR revision.

Production releases use GitHub Actions. Let the release workflow update the
package version and lockfile; do not bump versions per change or push release
tags manually. Merging and releases require explicit authorization.
