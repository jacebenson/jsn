# Live acceptance CI and public results

## Local one-command run

```sh
./.github/scripts/test-instance.sh --profile vendor-1
./.github/scripts/test-instance.sh --profile vendor-1 --dry-run
./.github/scripts/test-instance.sh --profile vendor-1 --version 5.5.5 --dry-run
```

The executable wrapper works from any working directory when invoked by its
path. Default behavior is **full READWRITE + publish**, using a private ephemeral
profile with `read_only: false` and an exact target. Existing profiles are never
modified. This deliberately maps local `full` to the immutable producer's older
`pdi` mode; it does not imply that a vendor target is a disposable instance.
`--dry-run` skips **publication only**: the same provider writes still execute.
Use `--readonly` explicitly for the 71-scenario GET-only subset. Use `--plan` to
export all 92 immutable scenarios, command paths, prerequisites, mutation tables
and blocked surfaces without provider calls. Full selection is not a claim of
complete product coverage; blocked prerequisites and inventory gaps remain visible.
Failed or blocked checks retain the runner's nonzero exit status. Omitting
`--version` tests the current checkout; exact npm versions verify registry integrity
and candidate identity separately from the pinned producer provenance.

```sh
./.github/scripts/test-instance.sh --profile vendor-1 --plan
./.github/scripts/test-instance.sh --profile vendor-1 --readonly --dry-run
```

Full mode creates uniquely named run-owned inactive resource fixtures, a dedicated
capture set and an inspected Log-only property-triggered flow. Update/delete,
publish/unlock and flow test commands require acknowledged current-run IDs; flow
tests also require a current-run property. No existing business record is updated.
The original effective application/update-set is snapshotted and independently
read back after restoration. Unresolved writes prevent unsafe follow-up dispatch.
Native update-set import/commit (global-setting/history effects) and catalog order
(no reviewed provider fulfillment recipe) remain explicitly blocked, not passed.
Auth and interactive scenarios retain upstream prerequisite checks; no Basic,
TOTP, domain, catalog recipe or external session evidence is invented.

`cleanup-receipt.json` is private (0600), contains only target label, run ownership,
table/type/owned IDs and created/deleted/retained counts, plus restoration status.
Supported exact-ID cleanup is attempted in finally, including failed scenarios.
Capture history and unsupported flow graphs are deliberately retained; no force
schema deletion or guessed graph cascade is attempted. Their retention is not a
reason to suppress all other writes. Public reports never contain these IDs,
provider URLs, credentials or usernames. `local-summary.json` distinguishes full
selection, applicability, blocked prerequisites and static inventory gaps.

Node loads `${HERMES_HOME:-$HOME/.hermes}/.env` if present; use `--env-file FILE`
to override it. This file is parsed as dotenv, never executed as shell code.
Existing environment variables take precedence. Publication requires
`JSN_ACCEPTANCE_INGEST_URL` and `JSN_ACCEPTANCE_INGEST_TOKEN`, checked before
provider calls. The ingest deployment must support this PR's schema version 2.

`--profile` first selects an exact local JSN profile. Logical target labels can
instead map to local profiles through private dotenv settings:

```dotenv
JSN_TEST_PROFILE_VENDOR_1=your_local_profile_name
JSN_TEST_PROFILE_VENDOR_2=your_other_local_profile_name
```

These are profile names, not URLs or credentials. There is no GitHub lookup or
hardcoded personal mapping. An absent profile prints available safe profile names
and the required alias key. Summaries default to unique directories under
`$HOME/private-acceptance/`; no output directory is created in the repository.
The lower-level Node runner below remains available for explicit output or saved
result publication.

## Execution and target selection

Trusted main pushes and published releases independently attempt **both vendor-1
and vendor-2**, in separate bounded jobs. Neither waits for nor cancels its peer.
Manual dispatch defaults to `both`, with `pdi`, `vendor-1`, or `vendor-2` available
as explicit single-target choices. PDI is never automatic. The retired repository
variable `JSN_ACCEPTANCE_TARGET` is ignored. The release workflow dispatches the
exact release tag because events created with `GITHUB_TOKEN` do not start other
workflows. Release dispatch is best effort, not a release gate.

Ordinary PR CI receives no instance or publication secrets. Selection verifies
that the exact candidate SHA is an ancestor of the trusted default branch before
secret-bearing jobs. Manual feature refs are refused. Candidate checkouts disable
persisted Git credentials. Dependencies install without lifecycle scripts or caches
before credential injection. No target host or credentials appear in artifacts.

GitHub-only orchestration is owned by `.github/scripts/acceptance/`:
`config.mjs` selects targets, `ci.mjs` seeds the isolated producer and publishes,
`execute.mjs` observes execution, and `publish.mjs` validates delivery.
`.github/scripts/oauth-environment.mjs` is shared with the GitHub verification
wrapper, `.github/scripts/verify-instance.mjs`. These are not CLI product code
and are outside the published npm package. Generic local verification remains
`cli/scripts/verify-jsn.mjs`.

`.github/scripts/acceptance/prepare.mjs` stages the existing producer at immutable commit
`65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba`, without replacing candidate CLI source.
Generated runner resources deliberately retain the producer's original
`cli/scripts/acceptance/{bindings,run,session-adapter,support}.mjs` and
`cli/test/acceptance/` paths so its relative imports remain byte-for-byte intact.
They are temporary, untracked harness resources, not installed product code;
the npm package allowlist excludes scripts and tests. No tracked helper is copied
back into `cli/` as a compatibility shim.
Existing producer files cause refusal rather than silent replacement. Readonly
runs select every declared readonly scenario across read-only, read-only-catalog,
resources, workflows and auth. This is an explicit subset, not full-product
acceptance. The CLI's independent `read_only` profile and original producer guards
remain active. This tests a checkout, not an npm tarball. Provenance preserves
candidate SHA, dirty flag, package/Node versions and entrypoint SHA-256.

## Configuration

Use the existing environments. Configure both vendors independently:

| Scope | Kind | Name | Value |
| --- | --- | --- | --- |
| Each selected environment | Variable | `JSN_INSTANCE_URL` | HTTPS origin without path, query, credentials or port |
| Each selected environment | Variable | `JSN_VERIFY_ENABLED` | `true` after authorization review |
| Each selected environment | Secret | `JSN_OAUTH_REFRESH_TOKEN` | Refresh token from the authorized JSN OAuth public-client login |
| Each selected environment | Variable | `JSN_OAUTH_CLIENT_ID` | Optional override matching the login client; omit to use JSN source default |
| Each selected environment | Secret | `JSN_OAUTH_TOKEN` | Legacy access-token fallback, used only when refresh token is absent |
| Repository | Variable | `JSN_ACCEPTANCE_INGEST_URL` | HTTPS ingest URL ending `/api/acceptance/runs` |
| Repository | Secret | `JSN_ACCEPTANCE_INGEST_TOKEN` | Matching server `ACCEPTANCE_INGEST_TOKEN`, at least 32 characters |

Do not shadow repository publication settings in instance environments. No profile
JSON secret is required. The producer strips credential environment variables from
CLI children, so the adapter seeds one OAuth file-store profile in a private
 ephemeral home with keyring access disabled. Children receive an allowlisted
environment without GitHub, ingest, proxy or Node-injection credentials. Private
files are deleted on exit and never uploaded. Access-token-only configuration has
no renewal metadata. Auth rejection does not establish that a token expired.

Both verification and acceptance refresh before their real checks in the same
process. The exact validated HTTPS instance origin receives one bounded (15s)
form POST to `/oauth_token.do`: `grant_type=refresh_token`, `client_id`, and
`refresh_token`. Redirects are rejected. The client ID comes from
`JSN_OAUTH_CLIENT_ID` (mapped to `SERVICENOW_OAUTH_CLIENT_ID`) or the authoritative
`getOAuthClientID()` source default. Current JSN uses a public PKCE client: no
client secret or PKCE verifier is required for refresh. Match any override to the
client that issued the refresh token; do not invent a confidential-client secret.
Configured refresh failure fails closed with no stale-token retry. An absent
refresh token permits legacy access-token use, which must still pass the real
authenticated check. Closed output identifies `refreshed` versus
`legacy_access_token`; raw provider responses and credentials are never logged.

Refresh responses stay in memory; no refresh credential is written to files,
artifacts, step/job outputs or GitHub settings. Acceptance retains its existing
private ephemeral access-token profile solely for the pinned producer. If the
provider returns a different refresh token, a fixed warning reports that the
replacement is **not persisted**. The current run uses the new access token, but
operators must securely replace the environment refresh secret for the next run.
No settings-write PAT is needed or requested. Provider rotation behavior has not
been live-verified; refresh-token expiration/revocation and local profile refresh
can also invalidate the static GitHub secret. This is automatic access-token
refresh, not a promise of indefinitely unattended renewal. The OAuth POST is an
authentication operation, not a ServiceNow business-record write; readonly and
mutation-approval boundaries are unchanged.

Manual `mode=pdi` requires single target `pdi`, default-branch dispatch,
`disposable_approved=true`, and an existing environment with required reviewers.
Environment review must approve the job; protection is rechecked through GitHub's
API immediately before execution. The adapter independently enforces approval and
verified reviewers. Reviewers must confirm the target is disposable. Full PDI runs
retain cleanup and unresolved-write guards. No automatic lane enables writes.

## Delivery is separate from test outcome

The final **Acceptance delivery gate, not scenario pass gate** runs with `always()`
and explicitly examines every target's outputs, not unreliable matrix outputs.
It succeeds if at least one target delivers genuine execution and verified public
results. A peer that is unavailable, unconfigured or fails publication does not
invalidate a delivered run. If no target delivers, the gate fails. Target jobs are
allowed to fail so a failed peer cannot override that final delivery decision.

A qualifying run requires at least **one distinct scenario with status `passed`,
`failed`, or `failed-timeout` and authenticated provider-operation evidence from
inside that scenario**. `execute.mjs` observes the pinned scenarios without
changing their results. A successful selected-profile `ctx.read`, or successful
provider-backed CLI JSON command, records private run-key/scenario evidence. Local
version/completion/history, help, auth-status, blocked/excluded/not-run scenarios,
runner initialization, failed authentication, and setup/preflight alone cannot
qualify. Evidence is matched against the actual projection's run key and result
IDs. A failing assertion after an authenticated provider operation counts even
when zero scenarios pass. This intentionally conservative threshold does not count
an auth-only failure as execution. A partial run qualifies with honest missing
counts if it satisfies that threshold and publishes successfully.

The original producer's scenario statuses, `complete`, counts and `missingCount`
are preserved exactly. Nonzero suite exit is recorded as the **suite verdict**,
not reused as the delivery exit code. Target job summaries show authenticated
executed count, suite exit, scenario counts, completeness, missing count,
publication status and exact public run key. Public `/results/:run_key` pages
retain actual test verdicts. A green delivery gate does **not** mean passing tests.

## Publication and exact readback

After a failed or interrupted suite, saved valid evidence is still published.
Missing, empty, dirty, wrong-revision or invalid closed projections are refused,
never synthesized. Only validated schema-v1 public fields are uploaded, not
private receipts, raw errors, hosts, users, record data or credentials.

POST uses bounded timeouts, no redirects, and up to three identical-body retries
for transport/5xx errors. Accepted/duplicate responses must echo the exact run key.
A credential-free GET of that run's public results page must match its stored
canonical payload digest, run key, SHA and version. The page exposes its existing
server canonical digest, covering the full accepted projection rather than only
provenance. The updated site renderer must be deployed before live delivery can
pass this stronger readback. A stale renderer fails closed.

Each producer context generates a random UUID run key, independent of target,
commit or anonymized profile. Artifacts include the closed target label in their
name. The aggregate gate rejects duplicate run keys across targets. No hostname
is needed to distinguish the jobs or their public links. Re-running creates a new
run; retries of a publication retain the original key.

## Verification

```sh
npm --prefix cli ci
npm run test:workflows
node --test cli/test/workflow-contracts.test.js
npm test
npm run lint
node .github/scripts/check-docs.mjs origin/main
```

GitHub tooling tests live in `.github/tests/`, outside the CLI product suite.
`npm run test:workflows` runs them once using Node’s built-in test runner and
the installed `cli/` dependencies for real CLI integration. The CI GitHub tooling
job uses full history for the immutable producer and is enforced by the existing
Tests gate. The existing conservative selector covers non-prose `.github/`
changes; docs-only checks remain dependency-free. PR492’s isolated seeded-parent
authentication success/rejection/recovery regression is included here, with only
its observer import relocated; PR492 should not be merged separately.

Offline tests exercise the actual pinned producer against loopback, deliberate
assertion failures and restored success, file-store OAuth, independent readonly
refusal, honest failed/partial publication, exact readback, and delivery gates.
No mock output is uploaded or described as live acceptance. Historical producer
integration explicitly skips in shallow clones without the pin; local full-history
verification must run it. Ruby-available tests compare the Rails canonical digest.
Live runs and publication remain explicit post-merge operator verification.
