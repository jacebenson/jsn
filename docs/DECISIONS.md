# JSN decisions

## The capability registry is authoritative

Command safety capabilities live in `src/capabilities.js`. Middleware derives mutation and daily-check behavior from that registry. New commands must declare their capabilities instead of adding names to separate lists.

## Output goes through one controller

Command data goes through `app.output` so JSON, Markdown, CSV, styled output, and `--get` remain consistent. Handlers must not print data directly with `console.log`.

## Mutations stay guarded

Mutation commands require the instance, respect read-only profile boundaries, and follow the confirmation path in `src/mutations.js`. Verification recipes use read-only commands unless a disposable mutation lane is explicitly established.

## Verification is project-owned

The pstack-shaped launch, drive, proof, evidence, and cleanup instructions live in `.agents/skills/verify/`. General product knowledge lives in `docs/`, so verification procedures and product description do not drift into one document.

## Skipped batches require preview-bound consent

Skipped-update processing is declared as a mutation through the capability registry.
The shared middleware blocks read-only profiles without requesting confirmation.
The domain module previews the exact selected batch before its single confirmation;
automation confirms a snapshot-bound token from a separate read-only preview.
`--force` and profile confirmation opt-outs do not waive this consent. Impact analysis
is pure and reusable, while revert calls the inspected provider lifecycle and verifies
log and artifact readback. Unknown deeper effects remain explicit rather than being
inferred from a field comparison.

## New flows get their trigger from the same GraphQL patch as their actions

`POST /api/now/processflow/flow` returns a flow whose `triggerInstances` is
empty — there is no default trigger to patch — so `jsn flows create` inserts the
trigger through the `snFlowDesigner` `flowPatch` alongside the actions, then
verifies it by reading the flow back. Creation is therefore two-stage: a failure
after the parent POST names the orphan draft's sys_id in the error, because flow
deletion is not implemented and the operator has to remove it in Flow Designer.

## Trigger inputs come from the instance, not a hand-written table

`sys_hub_trigger_input` is the source of truth for what each trigger definition
declares. Its owning definition is carried by the `name` column
(`var__m_sys_hub_trigger_input_<definitionId>`); the `model` reference is empty
on the verified instance and a `trigger_definition=` query is ignored, so the
name suffix is the only reliable relation. `internal_type` holds the GraphQL type
as its raw value. The documented record-trigger table descriptor route
(`/api/now/processflow/trigger/record/table`) does not exist (HTTP 400), so the
table label comes from `sys_db_object` and the display column from the nearest
`sys_dictionary` `display=true` element walking up `super_class`.

## The instance derives trigger predicate metadata

The `snFlowDesigner` patch parses the `condition` trigger input into
`metadata.query_parse.predicates` itself, producing the same `field_label`,
`operator_label` and `field_type` Flow Designer shows. This CLI sends `{}` and
verifies the derived predicate by read-back instead of rebuilding the predicate
tree locally, which removes the dead descriptor route from the condition path.

## GraphQL input objects are narrower than the read model

The `snFlowDesigner` input types accept strict key sets that GraphQL
introspection (disabled on the verified instance) cannot reveal. Notably
`global_snFlowDesigner_ActionInstanceValue` takes only
`id/name/children/displayField/scriptActive/parameter/value/displayValue`, with
the provider's UI schema carried inside `parameter`
(`global_snFlowDesigner_FlowDesignParameter`), and `attributes` is a String on
input even though the read path renders an object. Payload builders narrow the
provider's schema to those sets; the accepted keys are recorded in
`src/flow-triggers.js`.

## Revert readback verifies base content, not the previewed version sys_id

`RevertUpdateVersionAjax.revertToBaseSystem` reverts the artifact to the previewed
base version and leaves a new `sys_update_version` record whose payload copies
that baseline. The previewed version `sys_id` is therefore expected to change, so
comparing it after the write reports a real revert as a failure. Revert readback
compares the SHA-256 digest of the base payload captured during review plus the
artifact's meaningful base fields. A fake provider that returns the same version
record after the write cannot expose this, so the regression test simulates the
provider's new record.

## Local Rails feature library and accounts

The Rails site owns the homepage and feature pages, with the existing Eleventy
content builder retaining documentation URLs. Feature data is exported from the
existing catalog during the site build. Each feature can have a SQLite-backed
recording URL managed by the site administrator. Unrecorded features still offer
examples rather than presenting a nonfunctional player.

Adapt Joomdeck's email/password, browser-session, and first-user-admin behavior
without its Devise/bcrypt dependencies: use Rails forms and middleware, Ruby
OpenSSL password derivation, and revocable SQLite session records. Website login
is independent from CLI and publisher authentication. No mail or external session
service is introduced.

## Public documentation service with daily GitHub ingestion

Serve server-side SQLite FTS5 search and Markdown reads publicly through Rails;
visitors do not need a local database or an account. Reuse the existing Node
GitHub documentation ingester rather than implementing a second parser in Ruby.
A separate worker fetches the ServiceNowDocs Australia branch daily, incrementally
updates a staged SQLite backup, checks integrity, and atomically publishes it.
Failures retain the last good index, and unchanged revisions skip indexing.

Administration is terminal-provisioned; public signup is removed. Existing
admin login protects feature video publishing. Web and API readers share one
read-only documentation index, separate from the account/video database. Paths
are stable document references; ID reads can require a matching source revision.
The CLI's migration to these endpoints is separate from implementing this service.

## JSN docs commands consume the hosted REST API

Replace CLI-local docs indexing and serving with `docs search`, `docs show`, and
remote `docs status`. These commands use the public service without instance
credentials, login, local index initialization, or dataset downloads. Preserve
JSON envelopes, full Markdown bodies, `--get`, styled previews and pagination.
Use `JSN_DOCS_URL` for a local or alternate deployment. The default production
host still requires deployment of the Rails service before those APIs work.

Retire the local sync/serve/embed/refresh/community command surface; retain Node
indexing helpers for the site worker. No new runtime dependencies are introduced.
Exact document paths are stable; optional `--revision` protects numeric ID reads
against index changes. Connectivity failures are explicit rather than silently
falling back to a stale local database.

## Separate application roots

The published npm package (including tests, examples and bundled skills) lives in
`cli/`; Rails stays in `site/`, and Eleventy reference sources stay in `docs/`.
The repository-root npm package is private and only forwards developer commands.
The website uses the documentation engine shipped by the CLI, avoiding a second
package/release stream. CI selects application checks from changed paths; shared
docs engine or dependency changes check both applications. Dev npm publication
is limited to CLI and release-workflow changes. Production releases remain explicit.

## One documentation engine for hosted and local use

The npm package owns a Node/SQLite query engine and HTTP service. Rails delegates
queries through a bounded JSON-lines child process, retaining one database handle
for a request so revision checks and ID lookup use the same published snapshot.
This adds process startup overhead but avoids a second search implementation or
an additional deployment service. Both server modes use the same mirror/sync code,
with exclusive publication, staged validation and atomic index replacement.

Setup offers hosted documentation with a default-yes question. Declining offers
a managed local service, also default-yes; only declining both asks for a base URL.
The managed service listens on loopback, starts on demand and refreshes daily;
self-hosting uses `jsn docs --serve`. No separate package, Docker or LLM setup is required.
Global connection preferences apply to future connections, never retroactively.
