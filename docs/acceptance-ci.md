# Live acceptance CI and public results

## What runs

`acceptance.yml` is a separate, observational workflow for trusted main pushes,
published releases and manual dispatch. It never runs with PR or fork secrets.
The production release workflow explicitly dispatches it at the exact release
tag because events created with `GITHUB_TOKEN` do not start other workflows.
Release dispatch is best effort and is not a new release gate. Publication and
suite errors remain failures in the acceptance workflow itself.

The genuine producer already exists on the acceptance feature branch, not main.
`prepare.mjs` fetches immutable commit
`65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba` from the canonical GitHub repository
and stages only its acceptance scripts, scenarios and coverage inventory into
the ephemeral candidate checkout. It does not replace CLI source, package files
or the entrypoint. This avoids merging the unrelated feature branch or checking
out a moving runner branch with secrets. The pin is the schema-compatible
producer before `local.output-contract` was added without a matching public
scenario allowlist entry. Tests compare every pinned scenario against the current
site allowlist; this integration does not remove a scenario from that producer
to manufacture a publishable result. Existing producer paths cause refusal
so future adoption of the runner requires explicit reconciliation.

The staged producer imports the candidate CLI source and executes its actual
`cli/bin/jsn.js`. Its existing provenance records checkout SHA, package version,
Node version, tracked-tree dirty flag and SHA-256 of that entrypoint. The digest
is an entrypoint digest, not a hash of the entire package. CI logs additionally
identify the immutable producer SHA. Publication refuses a dirty tree or source
SHA different from the event's exact checkout. This is checkout acceptance, not
a claim that the corresponding npm tarball was tested.

Automatic execution selects **every scenario declared readonly by that producer**
as an explicit subset. The existing readonly command and transport guards remain
active, and the dedicated profile must also set `read_only: true`. Normal local
auth/session refresh may write ephemeral local credentials. No instance-record
mutations are authorized in this lane. The public page shows `explicit subset`,
not `full-product run`. PDI workflows, mutations, interactive coverage, Basic and
cookie actor matrices and commands added since the pinned inventory are not
established by this readonly run. The pinned capability ledger is not a current
complete CLI inventory. A future producer update needs separate review.

Manual `mode=pdi` is accepted only from main and requires
`disposable_approved=true` plus an `acceptance-pdi` environment with required
reviewers. The configuration job verifies reviewer protection through GitHub's
API and fails closed if it cannot verify it. Reviewers must independently verify
the exact target is disposable. A profile name or checkbox does not establish
that. This lane runs the existing full producer catalog with `--allow-writes`,
including its cleanup and unresolved-write guards. It does not invent actor
credentials, fixture recipes or missing capabilities. Missing prerequisites,
coverage gaps and cleanup failures remain nonpassing. No PDI run was performed
while implementing this integration.

## Activation, without changing release requirements

At implementation time, repository secret names returned only `NPM_TOKEN`.
Existing `DEV` and `prod` environments returned no secret or variable names and
no protection rules. There is no configured acceptance environment or authorized
CI profile/ingest credential to prove live execution. No secrets, environments,
production configuration or instance records were changed for this PR.

An authorized operator can activate the readonly lane through the existing
approved secret/configuration tooling. Create a dedicated `acceptance-readonly`
environment restricted to main and intended release tags. Configure:

| Kind | Name | Meaning |
| --- | --- | --- |
| Variable | `JSN_ACCEPTANCE_ENABLED` | `true` after target and authorization review |
| Variable | `JSN_ACCEPTANCE_INGEST_URL` | Full HTTPS ingest URL, including `/api/acceptance/runs` |
| Secret | `JSN_ACCEPTANCE_INGEST_TOKEN` | Existing server `ACCEPTANCE_INGEST_TOKEN`, at least 32 characters |
| Secret | `JSN_ACCEPTANCE_PROFILE_JSON` | One dedicated test profile and its existing JSN credential object |

The profile bundle is JSON with exactly `expectedHost`, `profile`, and
`credentials`. `expectedHost` is the approved HTTPS origin. `profile` is the
existing JSN profile object with matching `instance_url`, `username`,
`auth_method` as appropriate, and `read_only: true`. `credentials` is the existing
JSN credential-store object for that identity, including its `auth_method` and
required credential/refresh fields. Do not paste credentials in chat or PRs.
The adapter writes one `acceptance-ci` profile and the correctly keyed credential
file under a private ephemeral XDG home, then removes it. It does not scrape a
personal keyring or choose a personal/production profile automatically.

For approved mutations, configure a separate `acceptance-pdi` environment with
required reviewers, branch restriction to main, independently verified disposable
target, and separate credentials. Use the same four setting names there. Any
extra auth actor or catalog recipe options in the producer are not automatically
configured by this adapter; their absence must remain blocked/not-run.

When configuration is missing, the readiness job emits `NOT CONFIGURED`, and the
actual acceptance job is **skipped**, not a green acceptance check. No synthetic
public run is created. Do not add this observational workflow as a required
release or merge check without an explicit gating/outage policy. After activation,
run the readonly workflow on main, confirm its exact source revision and scope,
and inspect the exact `/results/:run_key` page before marking this PR ready.
Live proof and a public run on this integration remain pending.

## Publication and failure semantics

The runner saves partial evidence after scenarios and during its cleanup path.
The adapter attempts upload even when the suite returns nonzero or throws after
saving results. It preserves the suite's nonzero exit, and an upload or readback
failure also makes the workflow nonpassing. Exit 2 means partial/incomplete,
not a passing acceptance check. A refused preflight or empty run is not replaced
with fabricated scenarios. Forced runner termination, infrastructure failure or
a job timeout can prevent upload; do not infer a run happened from an absent row.

The publisher reuses the existing closed schema-v1 validator, tightened to require
the candidate site's scenario allowlist. Only the validated public projection is
eligible for artifact upload. Private reports, logs, profile/host/record data,
script bodies and credentials are never uploaded. No arbitrary summary fields
or renderer/schema changes are introduced.

HTTP upload uses a runtime URL, no credential-bearing URL/query/fragment, HTTPS
outside loopback tests, no redirects, and a bounded request timeout. Transport
errors and 5xx responses retry at most three times using identical serialized
bytes and the exact producer run key. Re-running a suite is a new run; retrying
publication of its saved projection is not. 401/422/409 and other rejections are
visible and are not treated as acceptance. Server 201 accepted or 200 duplicate
must echo the exact run key. Then a credential-free GET of that run's public URL
must render the expected full source SHA and CLI version. This verifies page
availability/provenance, not every persisted field. The server's authenticated
closed projection and canonical digest remain authoritative for stored content.

## Offline verification

From the repository root:

```sh
npm --prefix cli ci
(cd cli && node --test test/acceptance-ci.test.js test/workflow-contracts.test.js)
npm test
npm run lint
```

Tests use real loopback HTTP for authentication, response loss after persistence,
exact-body duplicate retry, changed-payload conflict, rejection, redirect refusal,
readback, and upload after a failed suite. They inject a deliberate failing
scenario into the **existing producer's** `executeScenarios`, then restore it to
passing. These are offline integration tests, never live acceptance or public
results. The historical-producer test runs when that immutable Git object is
available, otherwise explicitly skips in shallow CI clones without a network
fetch. A Ruby-available test also parses the payload with the actual site-owned
`AcceptanceProjection`; the normal Docker website job still owns full Rails
auth/ingestion tests. Workflow guards reject unsafe trigger and gating regressions.
