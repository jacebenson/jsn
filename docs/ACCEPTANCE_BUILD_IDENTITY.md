# Acceptance build identity

The automatic Live acceptance results workflow tests the immutable source checkout selected by `github.sha`. It installs that checkout's CLI dependencies, stages the pinned scenario producer, and executes `cli/bin/jsn.js`. It does not install the npm dev channel.

The producer now reads `version --json` from the executable under test before running scenarios. Its complete version string is retained in the existing public `provenance.version` field. The source commit remains independent in `provenance.sourceSHA`. Workflow summaries explicitly identify the checkout, source commit and pinned harness commit. A checkout of package version `5.5.5` must not be relabeled `5.5.5-dev.197.1`.

## Historical evidence

Read-only inspection of `/results/acceptance_78864ca54ba948288754dc942da922ec`, Actions run `43798098142` and its sanitized public artifacts established:

- The matching public artifact has version `5.5.5` and source `084364837b6c7da724d5e40deb5e7f0635c0a9c7`.
- The workflow checked out that commit and ran `npm --prefix cli ci --ignore-scripts`, not an npm installation of JSN.
- The pinned producer commit is `65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba`, separate from the tested CLI commit.
- Running `node cli/bin/jsn.js version --json` on that exact checkout returned `{"ok":true,"data":{"version":"5.5.5"}}`.
- The historical artifact did not retain a separate raw version-command receipt. Its source and execution path support the checkout identity, not a published prerelease identity.

No historical record was changed. No npm package-to-commit mapping is inferred.

## Published package testing

For a separately approved published-package run, the existing local acceptance wrapper supports `--version EXACT` and verifies registry metadata, integrity and the executable's reported version. This is not the automatic CI lane. Do not substitute `@dev` or `latest`, since either can advance between selection and execution. Wiring automatic CI to publication needs an explicit immutable published-version handoff and a publication dependency. This patch intentionally does not redesign that orchestration.

The site index and detail views already consume the same public version field, but main's server validator currently rejects dotted prereleases such as `5.5.5-dev.197.1`. PR #499 owns site projection/presentation work and must coordinate the matching validator change and index/detail regression coverage. This producer-only patch does not claim end-to-end prerelease ingestion works before that dependency lands. No schema or database changes are required for the version string. Keep artifact kind and harness revision distinct from the tested version and source revision.
