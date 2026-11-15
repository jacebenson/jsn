# Local acceptance (readonly first slice)

From the repository root, with current Node LTS, npm and Git installed:

```sh
npm --prefix cli ci --ignore-scripts
# Required once if this is a shallow clone lacking the reviewed producer:
git fetch --no-tags origin 65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba
node .github/scripts/run-acceptance.mjs --version 5.5.5 --profile NAME --target vendor-1 --output "$HOME/private-acceptance/run-1"
# Omit --version to test this checkout instead.
```

The output directory must not exist. Target is a generic label, not a URL or
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

Four immutable producer scenarios run: completion, isolated empty history,
parser rejection, and bounded metadata list/get with independent readback and
human output. The artifact version check replaces the pinned producer's
checkout-equality version assumption; no producer bytes or same-source artifact
guard are modified. This is **partial readonly coverage**, never the full
acceptance suite or a release gate. Unsupported old command surfaces fail
honestly. Exit 0 means the selected checks passed, not complete product coverage.
Exit 1 means refusal, failed selected checks or failed publication.

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
fields; no database migration is needed because the original JSON is retained.
Nothing here merges, deploys, publishes automatically or performs provider writes.

Reproduce the real npm-package loopback fixture (no credentials):

```sh
node --test .github/tests/local-acceptance.test.js
npm run test:workflows
```

This fixture downloads and actually executes npm 5.5.5 plus the checkout, checks
GET-only provider calls, rejection/privacy, and mocked website POST/digest
readback. It is not evidence of a live ServiceNow or production-site run.
