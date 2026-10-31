# JSN decisions

## Runtime auth recovery reacts to rejection, not session age

Issue #311 adds an App-owned recovery provider to the SDK. Only a real command's
HTTP 401 permits one refresh/reauthentication and one retry. Bootstrap requests,
403, network errors, aborts, timeouts and 5xx never invoke recovery. Replaying a
mutation is allowed only after that definitive 401 rejection; an uncertain
outcome is never replayed. The SDK imports no app/config policy.

OAuth retains the existing identity-scoped token refresh and the declared-expiry
refresh in `AuthManager.getCredentialsFor`. The latter uses `expires_at` and is
intentionally unchanged. There is no new preflight or fixed session-age rule.
Basic never renews. Browser renewal uses the existing bounded GCK login flow,
with profile `reauth` defaulting to `confirm`; `auto` and `never` are explicit
settings through `auth modify`. Noninteractive and machine-output invocations
never prompt or launch a browser. Setup does not duplicate this setting.

401 and 403 errors omit provider bodies, which may contain credentials. 401
errors carry profile-specific recovery guidance; 403 reports an ACL/role problem.
Other statuses keep their existing API error behavior. Diagnostics remain
read-only and offline commands do not acquire credentials.

## Setup collects answers for the canonical auth operations

Setup remains the human front door, with add/reconnect/status/default/settings/
sign-out/remove actions. It invokes the same exported operations as `auth`;
the wizard has no separate credential or profile persistence. Login collects
new-profile preferences and a default choice before authentication, then saves
through one path. Bots provide explicit values or receive structured missing-
input errors, and never launch browsers implicitly. Preference flags are
idempotent assignments. New usernames cannot inherit the old default's pending
credential slot. Remote browser-extension capture is a separate follow-up
tracked in issue #302.

## Auth output separates profile settings, credentials, and live verification

Auth status uses a compact table for method, saved credential state, live
connection result, and profile options. Users and instance URLs require
`--details` in both human and machine output; identity JSON paths require that
flag as well. The identity column is labeled User. Credential
availability alone does not imply successful live verification. `--local`
skips instance requests. Auth/setup suppress the unrelated current-instance
header through a declared capability. New-profile login and setup share the
same option prompts; noninteractive login uses structured breadcrumbs for
setting hints. Existing-profile reauthentication preserves its settings.

## Browser login launches an isolated browser and manages its connection

Browser-session login launches a detected Chrome/Chromium-family browser with a
fresh temporary user directory and an OS-assigned loopback debugging port.
Setup asks only for the browser choice; JSN waits for login and then closes its
own browser and removes the directory. Browser selection supports installed
Chromium, Chrome, and Edge, with Chromium the first implemented/tested adapter.
`--browser-url` retains explicit advanced connection support.
Windows discovery uses Windows path separators, semicolon-delimited PATH,
case-insensitive environment names, and both per-user and system installations.
Browsers launch as executables with separate arguments and no shell, allowing
spaces without shell quoting. Cleanup asks the owned browser to close through
DevTools before falling back to termination, and retries profile removal for
file locks. This avoids treating Windows termination as graceful POSIX SIGTERM.
It reads one exact-origin tab and API-scoped cookies, then verifies the current
user before saving via AuthManager. It rejects ambiguous tabs and account
mismatches. No browser databases, decryption helpers, dependencies, automatic
browser restarts, or background session renewal are introduced. Imported
credentials remain `gck`, so transport and storage use the existing auth path.
Firefox needs a separate adapter; macOS, Windows, Chrome, and Edge still need
live validation of platform browser discovery and launch.

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
## Escape cancels any interactive prompt

`src/prompts.js` is the only module that imports `@inquirer/prompts`. Every
prompt a command shows comes from there through `cancellablePrompt`, which
listens for Escape, aborts with `PromptCancelled`, and removes its keypress
listener in a `finally`. Escape therefore backs out of selection, search,
confirmation, text entry and multi-select prompts alike, leaving no partial
answer behind.

A cancelled prompt throws, and the shared renderer turns `PromptCancelled` into
`Cancelled.` on stderr with exit status 0, so backing out is not a failure.
Guided flow and action editing catches it the same way it catches Ctrl+C and
returns without dispatching a mutation. Record pickers resolve `undefined`
instead, because every picker caller treats that as "leave this screen", and
the picker help line names Escape so the hint matches the wizard prompts.

The editor prompt is the exception: its keyboard belongs to `$EDITOR` while the
editor is open, so cancelling still uses Inquirer's Ctrl+C abort.

## Agent skill installation stays paired with the CLI

`jsn skill install` copies the packaged ServiceNow skill rather than downloading
mutable `main`. Skill guidance may omit safeguards only after the matching CLI
implements them, so a newer skill cannot safely be installed by an older CLI.
Installation, `skill show`, and `skill check` use the same bundled source and
version. Upgrade JSN and reinstall the skill to update both together.
`skill fetch` prints the packaged text offline. Checks compare complete contents,
including edits with unchanged versions. A plain reinstall replaces all recorded
installation files; explicit targets select a new set of managed copies.

## 2026-10-28: Declarative record command profiles

The migrated simple-table and ticket factories consume validated keyed JavaScript definitions
for aliases, table, default columns, identifier field, reference/list output and
relationship policy. Executable hooks remain JavaScript. The same definition is
attached to the implemented command as metadata, avoiding a second help-only map.
Bundled wrappers retain their public exports and specialized hooks; additional
profiles can use the same factory without a subprocess or a CRUD implementation.
## Capture-context approval is separate from delete confirmation

The mutation wrapper checks capture context before dispatch, even with JSON, quiet
output, or disabled headers. Global + Default needs explicit approval because
customization may be captured in the wrong set, and some changes are not captured
at all. Interactive users see a default-no decision; agents receive
`confirmation_required` and an exact rerun command with `--force` after approval.
The profile's skip-delete preference cannot bypass this context decision. Scope
mismatches warn without another prompt; a selected completed capture set blocks
writes and directs the user to select an in-progress set.

Selection and creation of scopes/update sets are capability-declared remediation
exemptions. REST's read-only-profile policy is unchanged; GET is only exempt from
capture-context approval for write-enabled profiles. Missing or unreadable context
is reported as unknown, preserving commands on service accounts without falsely
classifying them as Global + Default. The guard supplements existing update-set
name disambiguation and completion checks; it does not complete sets automatically.


## 2026-10-28: Fixed filters remain invariant in constrained table views

Additional list queries cannot replace a factory's fixed `extraQuery`. These
views accept bounded literal AND filters and ordering; OR/NQ/dynamic clauses
fail before transport instead of escaping the view through encoded-query
branch semantics. Generic records continue to accept advanced encoded queries.
Field-investigation help documents schema, overrides, query rules and ACL
coverage by symptom, without claiming a universal priority or effective-access
proof from a list of ACL records.
## Rails serves existing documentation output and distributes an independent index

Keep the documentation service in `site/`, beside the Node CLI and existing
Eleventy content project. Preserve the generated public URL tree while replacing
the serving layer with Rails. Build metadata/manifests live in the service's own
database; immutable downloadable indexes live on GitHub Releases/object storage.
The central builder reuses Node ingestion and publishes the stable manifest only
after artifact verification/upload. CLI installation, website deployment and index
publication have independent pipelines. See `docs-distribution-architecture.md`
for the pre-migration audit, host configuration gate and rollback path.

## 2026-10-29: Import update sets through the native XML loader

Use the instance's authenticated `upload.do` / `sys_upload.do` flow rather than
recreating update XML rows with Table API or executing background scripts. Strict
local XML inspection uses `saxes` (a small SAX parser with no external-entity
loader), rejects DTDs and unrelated envelope tables, and reports primary and
subsidiary payload operations. Existing retrieved sets and existing member IDs
are refused before upload to avoid implicit overwrites. An uncertain upload is
reported for inspection without an automatic retry or attempted rollback.

Import stops at a loaded retrieved set. Preview/commit, local conversion, name or
state overrides, and context switching are deliberately separate from retrieval.
Export never changes state and defaults to a sanitized filename in a terminal;
pipes keep raw XML, with explicit `--stdout`, `--out`, and `--out-dir` controls.
Files are exclusively created to preserve existing exports. `reopen` is the
explicit path back to an in-progress local set, without selecting it.

## 2026-10-29: Manage remote MIDs through configured SSH aliases

Keep the controller local and reuse the user's SSH key/known-host policy. Docker
build contexts and Compose manifests stream over SSH stdin; remote volumes replace
client-side bind paths. Native Windows uses the official ZIP and service wrapper
with LocalService and the vendor filesystem allow-list. Native Linux uses the
bundled JRE and SSH-user background launcher, requiring Python 3 but no sudo.
All deployments use unique ownership markers/labels; cleanup stops on mismatches
or uncertain runtime state. Explicit trust uses MIDServerAjax's platform Validate
action, never a direct write to the validated field. Runtime availability and
instance readiness are verified separately. See mid-remote-management.md.

## 2026-10-29: Present commands for the authenticated account

Cache the account's admin role at connection authentication, scoped to the
profile's username and instance origin. Compact discovery emphasizes tickets,
generic records, people/groups and local connection tools. A failed role probe
uses the same compact presentation while recording `role_check: unavailable`.
Legacy profiles remain complete until reauthenticated. This keeps help offline
and avoids probing instance roles on every invocation.

Keep every command callable and expose `--all-commands` in global help. Command
visibility does not replace ServiceNow ACLs: non-admin users can have delegated
development access, and role snapshots may age. Generic `requests` remains RITM
management; a new catalog ordering/record-producer workflow requires separate
API and mutation design and is not invented as part of help filtering.

## 2026-10-29: Attachment transfers have a standalone command

Expose `attachments list/download/upload` at the root so transfer operations are
discoverable without knowing the record command tree. `get`/`add` remain action
aliases; remove the nested transfer subtree rather than register duplicate
implementations. Preserve optional attachment enrichment on record/request views.
Downloads identify the attachment directly and derive only a safe local basename
from remote metadata; local overwrites are explicit. Uploads retain declared
mutation guards and confirmation.

## 2026-10-30: Explicit browser-session domain commands

Preserve local domain-header configuration for existing auth methods. Add
session-current/list/set/reset for saved browser-session credentials using the
platform picker endpoints. Keep reset separate because broadening to global
changes a potentially shared browser session. Select by exact picker sys_id and
verify reset/selection with current-domain readback. Do not call touch-session:
the supplied successful diagnostic sequence did not require it. Surface probe
errors unless the platform explicitly reports an invalid domain table. The
Windows shutdown assertion remains a separate investigation.

## Current Node.js LTS support (2026-10-31)

Support and test the current Node.js LTS release on Linux and Windows. CI,
publishing workflows, and website Node stages follow the LTS alias. Documentation
directs users to Node.js LTS rather than promising a historical minimum. The CLI
does not declare its own numeric engine floor; dependency engine requirements
remain intact. Older release lines are not part of the compatibility contract.

## Seed empty documentation services from the hosted index (2026-10-31)

Download a validated, consistent SQLite snapshot only when service storage is
empty. GitHub remains authoritative for revision checks and incremental updates.
Publish snapshots from the live documentation index without re-ingesting source
files; never include the Rails accounts database. Bootstrap failure falls back
to the existing Git build and never removes a working index.
