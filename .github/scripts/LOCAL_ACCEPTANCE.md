# Local acceptance (full existing readonly suite)

From the repository root, with current Node LTS, npm and Git installed:

```sh
npm --prefix cli ci --ignore-scripts
# Required once if this is a shallow clone lacking the reviewed producer:
git fetch --no-tags origin 65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba
node --env-file=/home/jace/.hermes/.env .github/scripts/run-acceptance.mjs --version 5.5.5 --profile vendor --target vendor1
# Omit --version to test this checkout instead.
```

By default each run gets a timestamp/UUID directory under `$HOME/private-acceptance`.
Optional `--output DIRECTORY` must name a new directory outside the repository;
an existing directory produces an actionable error rather than overwriting reports. Target is a generic label, not a URL or
profile name. Profiles alone supply provider authentication: no GitHub access or
duplicated environment credentials are needed. OAuth and Basic profiles are
supported; browser-cookie profiles currently refuse. Alternatively omit
`--profile` and supply the existing `SERVICENOW_INSTANCE_URL` and
`SERVICENOW_OAUTH_TOKEN` (or `SN_USERNAME`/`SN_PASSWORD`) conventions securely in
your local environment. OAuth refresh uses the existing environment helper in
memory, without persisting rotated credentials. An ephemeral, readonly profile
is used for every candidate subprocess. User profiles/keyrings are not changed.

An explicit published version must be exact, never `latest` or a range. The
registry SHA-512 integrity, registry gitHead, installed package identity and actual
`version --json` result are checked. No fallback candidate is installed. The
runner uses its own Node executable, not a global `jsn`. This verifies 5.5.5 on
the executing Node runtime; it does not establish historical Node support.
Published package install scripts are disabled. Native optional features needing
install scripts are outside this slice.

All applicable readonly scenarios from the immutable `read-only`,
`read-only-catalog`, `resources`, `workflows`, and `auth` modules are selected
through the existing producer selection helper: currently **71 scenarios**, with
no hand-maintained subset. The producer's `createContext` guards,
`executeScenarios` dependency/status/cleanup handling, and before/after performance
hooks execute unchanged. Scenarios unsupported by an older candidate fail or block
honestly; they are never silently dropped. Progress shows scenario IDs, counts,
status and duration without provider diagnostics.

The source guard still validates the harness executable. A separate explicit
process adapter routes only that canonical executable to the integrity-verified
candidate. Independent reads use the trusted harness SDK. The staged harness
package's expected version is set to the verified candidate version; no pinned
producer bytes or SDK source bytes are patched.

This is the **full existing readonly scenario catalog**, not full-product or
mutation acceptance. Mutation-only scenario IDs are reported as out of mode.
`--mode full`/`pdi` refuse clearly: the existing PDI workflows can retain update
sets/flows and no proven disposable-table safety configuration has been agreed.
No write authorization is inferred from running the readonly suite.

Exit 0 means every selected scenario passed, not complete product coverage.
Exit 1 means refusal, failed scenarios or failed publication; exit 2 means
blocked/excluded/not-run selected scenarios. Static inventory requirements and
option-assertion gaps are computed by the immutable `coverageDetails` mechanism;
they are **not additional executed tests**. `summary.complete` stays false when
these obligations remain even if all 71 scenarios pass. Local reports retain the
actual selected IDs, catalog/mode counts, gaps, and separately labeled static
obligation counts.

Only allowlisted summaries are retained (directory 0700, files 0600). Raw CLI
stdout/stderr, URLs, usernames, profile data, credentials and source errors are
not retained. Run-owned temporary install/config/harness paths are deleted in
`finally`. `public-summary.json` is the closed website projection;
`local-summary.json` includes separate harness/artifact identity, actual duration
and output-byte measurements, and unavailable token counts. Build metadata is a
bounded `sys_properties` read: recognized build-name/build-tag values retain their
source property names. Version/patch/hotfix remain explicitly unknown rather
than being guessed from a tag. Unknown build strings are discarded. This probe
has fixture coverage only, not live platform verification.

## Publish explicitly

Securely configure `JSN_ACCEPTANCE_INGEST_URL` (the website
`/api/acceptance/runs` route) and `JSN_ACCEPTANCE_INGEST_TOKEN` locally. Never paste
the token into chat or command arguments. These variables are needed only for
publication, not execution. No GitHub secret retrieval is attempted.

```sh
# Run and publish; append --publish to the run command above.
node .github/scripts/run-acceptance.mjs --version 5.5.5 --profile NAME --target vendor-1 --output "$HOME/private-acceptance/run-2" --publish
# Publish an already saved projection, without rerunning provider operations:
node .github/scripts/run-acceptance.mjs --publish --result "$HOME/private-acceptance/run-1/public-summary.json"
```

Publication preserves failures and partial coverage. It requires exact run-key
and canonical-payload-digest GET readback after POST. An older deployed website
without schema 2 support or readback markers will fail closed; local reports stay
useful. Schema 1 remains supported. Schema 2 adds closed artifact/harness identity
fields and optional closed release metadata. Run `bin/rails db:migrate` in the site before deployment: the local_metadata column retains this sanitized metadata (the original payload is not stored).
Nothing here merges, deploys, publishes automatically or performs provider writes.

Reproduce the real npm-package loopback fixture (no credentials):

```sh
node --test .github/tests/local-acceptance.test.js
npm run test:workflows
```

This fixture downloads and actually executes npm 5.5.5 plus the checkout, selects
and records all 71 immutable readonly scenarios, and checks
GET-only provider calls, rejection/privacy, and mocked website POST/digest
readback. The deliberately partial HTTP provider fixture proves critical metadata
checks pass and other unsupported fixture surfaces fail/block; it does not claim
71 passing provider scenarios. It is not evidence of a live ServiceNow or production-site run.
