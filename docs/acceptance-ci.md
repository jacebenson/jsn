# Live acceptance CI and public results

## What runs

`acceptance.yml` runs observational live acceptance on trusted main pushes,
published releases and manual dispatch. Ordinary PR CI never receives instance
or publication secrets. The release workflow also dispatches the exact release
tag because events created with `GITHUB_TOKEN` do not start other workflows.
Release dispatch remains best effort, not a release gate.

`prepare.mjs` stages the real existing acceptance producer from immutable commit
`65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba`. It does not replace candidate CLI
source, package files or entrypoint. Existing producer paths cause refusal, so
future adoption requires explicit reconciliation. All five scenario categories
are preserved: read-only, read-only-catalog, resources, workflows and auth.
Tests check every pinned scenario against the Rails scenario allowlist.

Readonly execution explicitly selects every scenario declared readonly by that
producer. This is an explicit subset, not full-product acceptance. The original
command and transport guards remain active, and the CLI profile independently
sets `read_only: true`. No instance-record mutations are authorized. PDI writes,
interactive scenarios, Basic/cookie actor matrices, commands newer than the pin,
and a complete current CLI inventory are not established by this readonly run.
The pin predates `local.output-contract`, which has no matching public allowlist
entry. Updating the producer requires separate review.

The producer executes the candidate `cli/bin/jsn.js` and imports candidate source.
Provenance contains the exact checkout SHA, package version, Node version,
tracked-tree dirty flag and entrypoint SHA-256. The digest is not a whole-package
hash. Publication refuses dirty source or a source SHA different from the event.
This tests a checkout, not the released npm tarball.

## Target selection and setup

Automatic pushes and releases use repository variable `JSN_ACCEPTANCE_TARGET`,
fallback `vendor-1`. Allowed targets are `pdi`, `vendor-1`, `vendor-2`. Invalid
values fail selection. Manual dispatch offers those same choices and defaults
to `vendor-1`. One run uses only one environment. An unavailable PDI does not
block a vendor run.

Reuse the existing instance environments, not separate acceptance environments.
Configure only the selected target and repository publication settings:

| Scope | Kind | Name | Value |
| --- | --- | --- | --- |
| Selected environment | Variable | `JSN_INSTANCE_URL` | HTTPS instance origin without path, query, credentials or port |
| Selected environment | Variable | `JSN_VERIFY_ENABLED` | `true` after authorization review |
| Selected environment | Secret | `JSN_OAUTH_TOKEN` | Valid OAuth access token with readonly suite permissions |
| Repository | Variable | `JSN_ACCEPTANCE_TARGET` | Optional automatic target, default `vendor-1` |
| Repository | Variable | `JSN_ACCEPTANCE_INGEST_URL` | Full HTTPS ingest URL ending `/api/acceptance/runs` |
| Repository | Secret | `JSN_ACCEPTANCE_INGEST_TOKEN` | Matching server `ACCEPTANCE_INGEST_TOKEN`, at least 32 characters |

Do not shadow repository publication settings in instance environments. No
profile JSON secret is required. No existing environments, secrets or settings
are changed by this code. Never put credentials in chat, source or workflow inputs.

The pinned producer strips credential environment variables from CLI children.
The adapter therefore seeds the selected token into the existing file credential
store under a private ephemeral home. Its minimal config sets root
`auth_method: oauth`, one `acceptance-ci` profile, the exact target and
`read_only: true` by default. The real producer/CLI reads this profile. Personal
keyrings are disabled. Private files are removed on exit and never uploaded.
The producer receives an allowlisted environment without GitHub, publication,
proxy or Node-injection credentials. Only the publisher receives the ingest token.

This access-token-only setup has no refresh token or expiry metadata.
`cli/src/auth.js` renews stored credentials only when expiry metadata requires
renewal and a refresh token exists. It cannot refresh this GitHub access token.
Authentication rejection does not prove expiry rather than an incorrect token
or target. Check the mapping before replacing credentials through approved tools.
A passing one-record smoke test does not prove full readonly ACL coverage or
long-suite token validity.

## Trusted execution and explicit mutations

Before any secret-bearing job, selection checks that the exact event SHA is an
ancestor of the trusted default branch. Manual feature-branch dispatches are
refused. Release-tag dispatches must pass the same ancestry check. The candidate
checkout uses that immutable SHA with persisted Git credentials disabled.
Dependencies install before credential injection, without lifecycle scripts or
caches. No untrusted PR source executes with credentials.

Manual `mode=pdi` requires target `pdi`, default-branch dispatch,
`disposable_approved=true`, and required reviewers on the existing `pdi`
environment. Environment review must approve the job. Immediately before
execution, the workflow rechecks required reviewers through GitHub's API.
Removed protection, an API denial, missing reviewers, missing approval or a vendor
target fails closed. The adapter independently requires verified protection and
approval before creating a writable profile. No automatic run enables writes.
Do not remove protection to make this lane run.

Reviewers must independently confirm the exact PDI is disposable. The original
full catalog runs with `--allow-writes`, cleanup and unresolved-write guards.
Missing actor credentials, catalog recipes, capabilities and cleanup remain
nonpassing. Offline tests never perform live mutations.

## Running and interpreting results

After merge, open **Actions → Live acceptance results → Run workflow**, choose
the default branch and one target, and leave `mode=readonly` and approval false.
Confirm the exact source SHA, executed scenario set and public
`/results/:run_key` page. This genuine suite is broader than the separate
one-record **Verify selected instance** smoke test. Live token validity and
readonly ACL/capability coverage remain unknown until the suite runs.

Missing configuration emits `NOT CONFIGURED`, skips genuine execution and
creates no public run. Readiness is not passing acceptance. This observational
workflow is not a required merge/release gate.

## Publication and failure semantics

The existing producer saves partial evidence after scenarios and during cleanup.
The adapter attempts publication after a nonzero suite exit or a thrown suite
with saved evidence. Nonzero suite exits remain nonzero. Upload/readback failure
also fails the workflow. Exit 2 means incomplete, not pass. Preflight refusal or
missing evidence is not replaced with fabricated results. Forced termination,
timeouts and infrastructure failure can prevent upload.

Only the validated closed schema-v1 public projection is eligible for upload.
Private reports, logs, hosts, users, record data, script bodies and credentials
are never uploaded. Statuses, counts, cleanliness and source SHA remain truthful.
Rails owns the scenario allowlist, ingest validation and persisted canonical digest.

Upload uses the runtime HTTPS URL, no credential-bearing URL, query or fragment,
no redirects and bounded timeouts. Loopback HTTP is allowed only in offline tests.
Transport errors and 5xx responses retry at most three times with identical bytes
and the same run key. Re-running a suite creates a new run. 401/422/409 and other
rejections are not acceptance success. Server 201 accepted or 200 duplicate must
echo the exact run key. A credential-free GET of its public page must then render
the expected full SHA and version. That readback proves page/provenance availability,
not equality of every stored field. Publication and Rails ingest/readback behavior
are unchanged by target configuration.

## Offline verification

From the repository root:

```sh
npm --prefix cli ci
node --test cli/test/acceptance-ci.test.js cli/test/workflow-contracts.test.js
npm test
npm run lint
node .github/scripts/check-docs.mjs origin/main
```

Tests cover selection/defaults, independent missing targets, approval/reviewer
refusals and restored success, the real pinned adapter's loopback OAuth file
configuration, CLI and producer readonly refusal with zero writes, all readonly
catalog categories, closed schema, upload auth, duplicate retry after lost
response, conflicts, rejection, redirect refusal, public readback and publication
after a failed suite. Injected failing scenarios are restored to pass in the real
producer. These mocks are never live acceptance or public results.

The historical integration test runs when the pinned Git object exists. It
explicitly skips in shallow PR clones rather than fetching over the network.
Ruby-available tests parse the payload through the Rails-owned projection. Website
CI owns the full Rails ingest/auth tests. Workflow guards reject deliberate
unsafe trigger/gating regressions and pass after restoration.
