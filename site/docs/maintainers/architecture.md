---
title: Architecture and decisions
---

Source-only architecture, decision records, feature map, measured baselines and build identity. Not published as a site guide.

## Documentation service and snapshot architecture

Decision for #324, recorded before moving the serving layer.

Historical migration plan: the later Rails Markdown migration removes the
Eleventy project described below. Current ownership and URL compatibility are
documented in [README.md](../README.md) and `site/README.md`; this decision record
is retained as evidence, not published as a public guide.

## Current ownership and deployment

The CLI and its public documentation live in this repository. `docs/` is a
separate Eleventy npm project; its configuration explicitly records deployment
through Coolify/Nixpacks. The npm split prevents the website build from installing
native CLI dependencies. There is no website deployment workflow or infrastructure
configuration in this checkout, so host secrets, service settings and DNS remain
external deployment configuration. The README also links the older GitHub Pages
address. Both URL forms need preservation when switching the serving process.

ServiceNow reference content comes from the `australia` branch of
`ServiceNow/ServiceNowDocs`, cloned by `src/commands/docs/sync.js`. Ingestion,
FTS5 schema, semantic embeddings and local search live in
`src/commands/docs/`. Indexes are local SQLite files under `~/.jsn/docs`, not
website assets. npm installation currently does not download this corpus.

## Decision

Keep the Rails service in `site/` in this repository. A second repository would
separate schema changes from the CLI installer that must read them and duplicate
URL migration work. Keep the CLI in Node; reuse its existing ingestion and search
schema for the central builder. Keep `docs/` as the documentation content/build
source initially: Rails replaces the serving process, while generated HTML and
assets preserve all existing public paths, metadata, canonical links, robots and
sitemap output. This avoids rewriting editorial templates during infrastructure
migration. A later template migration can be independent.

Rails owns a small application database for source revisions, build jobs and
published artifact manifests. It does not serve the downloadable index from its
application database. The builder creates an isolated SQLite index, validates
FTS5/schema/integrity, checkpoints it, compresses it and publishes immutable,
revision-addressed artifacts to GitHub Releases (or compatible object storage).
A stable manifest contains artifact URL, source revision, schema compatibility,
compressed/uncompressed sizes and SHA-256. Artifact bytes go directly from storage
to the CLI. Promotion of the stable manifest is the final publication step;
failed builds leave the previous artifact and manifest untouched.

## Pipelines and migration

Website CI builds the existing docs content, tests preserved paths and Rails
routes, then produces a separately deployable container from `site/`. Deploys
follow changes to the site/docs paths, independently of npm publish/release tags.
The central index workflow runs on a schedule, manual dispatch or source-change
notification, checks the current upstream revision and skips unchanged content.
It reuses ingestion in an isolated directory. Publication requires the validated
artifact and does not modify an installed user's index.

Switch the existing Coolify service build context to the new container only after
its URL checks pass. Keep the existing domain; preserve GitHub Pages redirects or
its existing published pages during transition. Actual host configuration and
DNS cannot be established from repository contents and require deployment access.
Do not claim the production migration complete merely because a container builds.
Rollback the serving container independently of CLI releases; keep immutable
snapshots and the previous stable manifest for rollback.

## CLI installation and compatibility

Documentation remains optional. `docs install --source github` explicitly builds
raw source locally (approximately 51,000 files; 5–25 minutes is a labeled estimate based on prior runs and the measured full
semantic build, not a promise). `--source snapshot` downloads a prebuilt searchable database, shows
manifest bytes and a labeled transfer estimate, verifies checksum/schema/integrity
and atomically replaces only the docs index. `--source skip` is explicit. Setup
offers the same choices; noninteractive invocations select a source explicitly.
First search with no index requests approval or gives an actionable command when
prompts are unavailable. Existing indexes search immediately offline; freshness
checks are bounded to once per day and must not delay or invalidate local search.
Manual `docs sync` remains available. Interrupted or incompatible installs retain
the existing database. Mutation history has a separate database and lifecycle.

## JSN decisions

### Global configuration is not the effective project view

`loadConfig()` retains private global and effective snapshots. `saveConfig()`
starts from the global snapshot and persists only changes made since loading (or
its last save), never unchanged project, environment, or flag overlays. Provenance
is per profile, not the coarse `sources.profiles` marker. A modified profile that
was supplied or shadowed by a project is refused before either file is written;
edit it outside the project or use an explicit login destination. Unrelated
trusted profiles and global preferences remain editable inside a project.

Switching selects an existing trusted profile; it does not approve a project
replacement origin. Login with a literal destination (including the setup
wizard's destination input) may establish that destination. Login by profile name
must still match its globally trusted origin. Login persists one reconstructed
profile based on its trusted predecessor and authored login values, not the
project object; making it default requires the existing explicit choice. The
internal `approvedProfile` / `approveDefault` save options express this narrow
login contract and are not sourced from configuration JSON.

Project synchronization applies only authored changes and deletions, preserving
unrelated local profiles/fields. `saveLocalConfig()` remains deliberately
local-only. Hand-built programmatic configs remain an explicit trusted write API;
production writers retain the exact object returned by `loadConfig()`.
`cli/test/config-trust-persistence.test.js` covers this boundary through real CLI
subprocesses, synthetic Basic/OAuth credentials, and loopback sinks.

### CI validation ownership

Website asset preparation and preview belong to the private root npm commands,
not the published `cli/package.json`. `site/**`, `docs/**` and
`site/scripts/build-docs-site.mjs` select website checks without CLI checks. Keep the
existing conservative `docs/**` policy for contributor records too; publication
remains allowlisted separately. CLI commands/tests select CLI checks. Shared
`cli/src/commands/docs/**`, CLI package/lockfile edits, root npm command wiring,
workflows and the selector itself select both. Manifest changes, including script
removal, are genuine CLI changes and must not be excluded. Deterministic temporary
Git histories in `cli/test/changed-components.test.js` exercise this matrix.

Documentation prose no application reads is validated by a third, lightweight
`docs` selection. Root README, `AGENTS.md`, `cli/README.md` and
`cli/examples/README.md` select it alone, so a README-only PR no longer pays for
the Linux/Windows CLI matrix. Markdown is never excluded by extension: everything
else under `cli/`, including `cli/skills/**` shipped in the package and Markdown
fixtures tests read, keeps CLI selection. `.github/scripts/check-docs.mjs` runs on Node
builtins without installation, build or network, validates relative link and path
targets in changed Markdown, and requires the packaged README and advertised
`files` entries to exist. Remote links are counted but not fetched. The `Tests`
aggregator fails when this job fails and passes when it is skipped.

CI selects affected applications once. Its website job calls `docs-site.yml`,
which builds the production Docker image once and runs all Rails tests through
`site/bin/test` plus the shared sync and Markdown JavaScript tests. This includes
`site_test.rb`'s preserved URL/body equality, assets, redirect, and manifest
assertions; the built URL inventory remains an uploaded artifact. The docs
workflow has manual and reusable entry points, not a second automatic push/PR
trigger. The required `Tests` aggregator waits for the reusable website job.

Only superseded PR CI runs may be cancelled. Main CI uses a unique run group;
publish, promotion, snapshot, and release runs remain non-cancelling. Keep Linux
and Windows CLI validation and independent publish/release tests: no latest-green
lookup may replace exact-source validation. Trusted publisher workflow filenames,
`dev`/`prod` environments, OIDC permissions, manual patch/minor/major release,
tag/version equality, and explicit GITHUB_TOKEN downstream dispatch are contracts.
`cli/test/workflow-contracts.test.js` guards these deliberate invariants.

The public results page is `/results`, with `/results/:run_key` detail pages.
It displays sanitized acceptance runs, not a run of the current npm release.
A successful HTTP response or a historical passing subset is not production
acceptance. Do not turn the live site into a blocking release dependency until
an exact-version/source scenario, fixture or approved run producer, freshness
expectation, and outage/failure policy are agreed. Local acceptance page tests
remain part of the Docker suite. The separate observational workflow documented
in [acceptance-ci.md](testing.md#live-acceptance-ci-and-public-results) reuses the pinned genuine producer and
publishes its closed projection when dedicated test/auth and ingest settings are
configured. Missing configuration skips execution, never reports passing
acceptance. The default lane is an explicit readonly subset. PDI mutations need
manual approval and a protected disposable-target environment. This does not add
a required release gate or authorize a live write during implementation.

### Root help is concise; `--all-commands --help` is the reference (2026-11-11)

Ordinary `jsn --help` is a task directory: common commands with short
descriptions, a few essential global flags, three runnable examples, and
pointers to `jsn discover <word>`, `jsn discover --table <table>`,
`jsn <command> <action> --help`, and `jsn --all-commands --help`. It does not
repeat the executable name on every command row. The full grouped reference,
including every registered command and global option, is reached with
`--all-commands --help`; the tips and picker details live there so the short
page stays short.

Command rows still come from the live registry. A concise description uses the
command's declared `summary` when present and its registered description
otherwise; it is never a blind truncation of the full text. Full help keeps the
long descriptions, including mutation safety text. Machine discovery JSON does
not gain a summary field, and profile/capability visibility is unchanged.
Bare `jsn` home behavior remains owned by `src/welcome.js`.

### Table behavior discovery extends `tables` (2026-11-04)

Phase 1 of issue #398 adds `jsn tables behavior <table>` as a subcommand of the
existing `tables` command family rather than a new top-level namespace. That
keeps schema inspection (`tables show`) and configuration discovery on the same
surface, and it inherits the existing command capabilities (the subcommand is
read-only; `tables` keeps its declared create/update/delete mutations).
Categories are `business_rules`, `client_scripts`, `ui_actions`, `ui_policies`
and `data_policies`; flows, workflows and state models are explicitly later
extensions.

The inventory resolves the `sys_db_object` ancestor chain (bounded to 32 levels)
and applies each artifact's inheritance semantics: business rules inherit
through `collection`, client scripts only through `applies_extended`, UI actions
through `table` plus `global`, and UI/data policies through their `inherit`
flag. Business rules and UI actions also include the platform `global`
collection, including for root tables with no ancestors, and mark those rows
with `association_detail: global_actions`. Items report `association`
(`direct`/`inherited`) and
`association_detail`, optionally attached field actions from
`sys_ui_policy_action`/`sys_data_policy_rule`. `sys_overrides` is retained as
evidence only — effective override resolution is not simulated. Client-side
requirements are reported separately from server enforcement. Conditions are
inventoried, never evaluated; scripts are not retrieved in Phase 1, so no
script body can be cut. Metadata identifiers are validated against a bounded
`[A-Za-z0-9_]` allowlist before they enter related queries, so ordinary 32-hex
sys_ids and platform word ids such as `sysverb_query` both work while encoded
query metacharacters are rejected.

Output is bounded per category (`--limit`, default 200, max 200) and by
`--max-bytes` (4096–1048576, default 524288) with whole-item omission,
per-category cursors and explicit `truncated`/`has_more` metadata. Sources are probed through `sys_dictionary`
before querying; permission, missing-layout and malformed-response failures
become `unavailable`/`unsupported` category statuses, never empty results.
Every read is a GET through the existing authenticated SDK (`listStrict`); no
new dependency is added.

Patterns were informed by `now-sdk-ext-core`'s MIT-licensed
`TableBehaviorDiscovery` (Copyright (c) 2026 SoniSoft Inc). The implementation
is original to JSN and uses JSN's readers and output envelope.

### Runtime auth recovery reacts to rejection, not session age

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

### Setup collects answers for the canonical auth operations

Setup remains the human front door, with add/reconnect/status/default/settings/
sign-out/remove actions. It invokes the same exported operations as `auth`;
the wizard has no separate credential or profile persistence. Login collects
new-profile preferences and a default choice before authentication, then saves
through one path. Bots provide explicit values or receive structured missing-
input errors, and never launch browsers implicitly. Preference flags are
idempotent assignments. New usernames cannot inherit the old default's pending
credential slot. Remote browser-extension capture is a separate follow-up
tracked in issue #302.

### Auth output separates profile settings, credentials, and live verification

Auth status uses a compact table for method, saved credential state, live
connection result, and profile options. Users and instance URLs require
`--details` in both human and machine output; identity JSON paths require that
flag as well. The identity column is labeled User. Credential
availability alone does not imply successful live verification. `--local`
skips instance requests. Auth/setup suppress the unrelated current-instance
header through a declared capability. New-profile login and setup share the
same option prompts; noninteractive login uses structured breadcrumbs for
setting hints. Existing-profile reauthentication preserves its settings.

### Browser login launches an isolated browser and manages its connection

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

### The capability registry is authoritative

Command safety capabilities live in `src/capabilities.js`. Middleware derives mutation and daily-check behavior from that registry. New commands must declare their capabilities instead of adding names to separate lists.

### Output goes through one controller

Command data goes through `app.output` so JSON, Markdown, CSV, styled output, and `--get` remain consistent. Handlers must not print data directly with `console.log`.

### Mutations stay guarded

Mutation commands require the instance, respect read-only profile boundaries, and follow the confirmation path in `src/mutations.js`. Verification recipes use read-only commands unless a disposable mutation lane is explicitly established.

### Verification is project-owned

Contributor verification instructions live in `docs/verification/`, with executable helpers in `cli/scripts/`. General product knowledge lives in `docs/`, so verification
procedures and product description do not drift into one document.

### Skipped batches require preview-bound consent

Skipped-update processing is declared as a mutation through the capability registry.
The shared middleware blocks read-only profiles without requesting confirmation.
The domain module previews the exact selected batch before its single confirmation;
automation confirms a snapshot-bound token from a separate read-only preview.
`--force` and profile confirmation opt-outs do not waive this consent. Impact analysis
is pure and reusable, while revert calls the inspected provider lifecycle and verifies
log and artifact readback. Unknown deeper effects remain explicit rather than being
inferred from a field comparison.

### Legacy Workflow Editor inspection is a separate read-only command

Legacy `wf_*` inspection is `jsn workflows`, not an extension of `jsn flows`.
The engines have different records and different lifecycles, and Flow Designer
inspection already assumes `sys_hub_flow`. The legacy reader only issues Table
API GETs, never checks a workflow out, and declares no mutation subcommands.
Missing or ACL-blocked components are returned as explicit `coverage` and
`integrity` states alongside the rest of the readable definition, because an
empty-looking activity set would be a false troubleshooting conclusion.
Version selection is explicit (`--version`, else published, else newest), and
every response states that the definition is design-time configuration rather
than execution history. Association for table-behavior discovery is limited to
`wf_workflow_version.table` and says so, instead of implying a complete
automation inventory.

### New flows get their trigger from the same GraphQL patch as their actions

`POST /api/now/processflow/flow` returns a flow whose `triggerInstances` is
empty — there is no default trigger to patch — so `jsn flows create` inserts the
trigger through the `snFlowDesigner` `flowPatch` alongside the actions, then
verifies it by reading the flow back. Creation is therefore two-stage: a failure
after the parent POST names the orphan draft's sys_id in the error, because flow
deletion is not implemented and the operator has to remove it in Flow Designer.

### Trigger inputs come from the instance, not a hand-written table

`sys_hub_trigger_input` is the source of truth for what each trigger definition
declares. Its owning definition is carried by the `name` column
(`var__m_sys_hub_trigger_input_<definitionId>`); the `model` reference is empty
on the verified instance and a `trigger_definition=` query is ignored, so the
name suffix is the only reliable relation. `internal_type` holds the GraphQL type
as its raw value. The documented record-trigger table descriptor route
(`/api/now/processflow/trigger/record/table`) does not exist (HTTP 400), so the
table label comes from `sys_db_object` and the display column from the nearest
`sys_dictionary` `display=true` element walking up `super_class`.

### The instance derives trigger predicate metadata

The `snFlowDesigner` patch parses the `condition` trigger input into
`metadata.query_parse.predicates` itself, producing the same `field_label`,
`operator_label` and `field_type` Flow Designer shows. This CLI sends `{}` and
verifies the derived predicate by read-back instead of rebuilding the predicate
tree locally, which removes the dead descriptor route from the condition path.

### GraphQL input objects are narrower than the read model

The `snFlowDesigner` input types accept strict key sets that GraphQL
introspection (disabled on the verified instance) cannot reveal. Notably
`global_snFlowDesigner_ActionInstanceValue` takes only
`id/name/children/displayField/scriptActive/parameter/value/displayValue`, with
the provider's UI schema carried inside `parameter`
(`global_snFlowDesigner_FlowDesignParameter`), and `attributes` is a String on
input even though the read path renders an object. Payload builders narrow the
provider's schema to those sets; the accepted keys are recorded in
`src/flow-triggers.js`.

### Revert readback verifies base content, not the previewed version sys_id

`RevertUpdateVersionAjax.revertToBaseSystem` reverts the artifact to the previewed
base version and leaves a new `sys_update_version` record whose payload copies
that baseline. The previewed version `sys_id` is therefore expected to change, so
comparing it after the write reports a real revert as a failure. Revert readback
compares the SHA-256 digest of the base payload captured during review plus the
artifact's meaningful base fields. A fake provider that returns the same version
record after the write cannot expose this, so the regression test simulates the
provider's new record.

### Local Rails feature library and accounts

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

### Public documentation service with daily GitHub ingestion

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

### JSN docs commands consume the hosted REST API

Replace CLI-local docs indexing and serving with `docs search`, `docs show`, and
remote `docs status`. These commands use the public service without login, local
index initialization, or dataset downloads. With no release named, they read the
selected profile's `glide.war` to choose the family, never prompting, and fall back
to the newest family the service lists when they cannot. Preserve
JSON envelopes, full Markdown bodies, `--get`, styled previews and pagination.
Use `JSN_DOCS_URL` for a local or alternate deployment. The default production
host still requires deployment of the Rails service before those APIs work.

Retire the local sync/serve/embed/refresh/community command surface; retain Node
indexing helpers for the site worker. No new runtime dependencies are introduced.
Exact document paths are stable; optional `--revision` protects numeric ID reads
against index changes. Connectivity failures are explicit rather than silently
falling back to a stale local database.

### Separate application roots

The published npm package (including tests, examples and bundled skills) lives in
`cli/`; Rails stays in `site/`, and Eleventy reference sources stay in `docs/`.
The repository-root npm package is private and only forwards developer commands.
The website uses the documentation engine shipped by the CLI, avoiding a second
package/release stream. CI selects application checks from changed paths; shared
docs engine or dependency changes check both applications. Dev npm publication
is limited to CLI and release-workflow changes. Production releases remain explicit.

### One documentation engine for hosted and local use

The npm package owns a Node/SQLite query engine and HTTP service. Rails delegates
queries through a bounded JSON-lines child process, retaining one database handle
for a request so revision checks and ID lookup use the same published snapshot.
This adds process startup overhead but avoids a second search implementation or
an additional deployment service. Both server modes use the same mirror/sync code,
with exclusive publication, staged validation and atomic index replacement.

Setup offers hosted documentation with a default-yes question. Declining offers
a managed local service, also default-yes; only declining both asks for a base URL.
The managed service listens on loopback, starts on demand and refreshes daily;
self-hosting uses the JSON-only `cli/src/commands/docs/server.js` adapter. No separate
package, Docker or LLM setup is required. The optional CLI browser UI, its legacy
server and vendored assets, and the `jsn docs --serve` flag have been removed.
The managed local service and Rails-hosted search are retained; the JSON adapter
does not render documentation metadata as HTML.
Global connection preferences apply to future connections, never retroactively.
### Escape cancels any interactive prompt

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

### Agent skill installation stays paired with the CLI

`jsn skill install` copies the packaged ServiceNow skill rather than downloading
mutable `main`. Skill guidance may omit safeguards only after the matching CLI
implements them, so a newer skill cannot safely be installed by an older CLI.
Installation, `skill show`, and `skill check` use the same bundled source and
version. Upgrade JSN and reinstall the skill to update both together.
`skill fetch` prints the packaged text offline. Checks compare complete contents,
including edits with unchanged versions. A plain reinstall replaces all recorded
installation files; explicit targets select a new set of managed copies.

### 2026-10-28: Declarative record command profiles

The migrated simple-table and ticket factories consume validated keyed JavaScript definitions
for aliases, table, default columns, identifier field, reference/list output and
relationship policy. Executable hooks remain JavaScript. The same definition is
attached to the implemented command as metadata, avoiding a second help-only map.
Bundled wrappers retain their public exports and specialized hooks; additional
profiles can use the same factory without a subprocess or a CRUD implementation.
### Intended customization context is separate from confirmation

`mutation-context.js` checks task-owned CLI/local expectations against fresh
preference records and effective picker selections. Unknown or mismatched context
refuses, even with `--force`. The capability registry declares operational writes
and generic table classification through `sys_metadata` ancestry. Read-only and
command confirmation gates are independent. Domain-scoped customization refuses
until effective transport semantics can be proven. See the update-set guide.
Automatic read banners and their context requests are retired. Explicit
`auth status --context` reports one selected profile, with an offline `--local` mode.


### 2026-10-28: Fixed filters remain invariant in constrained table views

Additional list queries cannot replace a factory's fixed `extraQuery`. These
views accept bounded literal AND filters and ordering; OR/NQ/dynamic clauses
fail before transport instead of escaping the view through encoded-query
branch semantics. Generic records continue to accept advanced encoded queries.
Field-investigation help documents schema, overrides, query rules and ACL
coverage by symptom, without claiming a universal priority or effective-access
proof from a list of ACL records.
### Rails renders allowlisted Markdown guides without a static-site generator

Public guide ownership is `site/config/guides.json` → maintained Markdown in
`docs/` → vendored Marked parser → Rails HTML5 sanitizer → shared Rails layout.
Request input never becomes a filesystem path. Contributor ADR/audit/evidence
files stay in the repository but are not implicitly published. The original
54-URL HTML inventory has an explicit runtime route or deliberate compatibility
redirect in `site/config/legacy-guide-urls.json`; contributor records redirect
to canonical GitHub source rather than silently becoming public guides.
Showcase/SEO/demo sources and public assets move to `site/data/` and
`site/static/`. The asset preparation step needs only Node built-ins, not npm
installation or an HTML generator. The separate ServiceNow corpus ingestion,
search, release selection, snapshots, and `/documentation` reader are unchanged.
This supersedes only the static HTML preservation phase of the earlier decision.

### Rails serves existing documentation output and distributes an independent index

Keep the documentation service in `site/`, beside the Node CLI and existing
Eleventy content project. Preserve the generated public URL tree while replacing
the serving layer with Rails. Build metadata/manifests live in the service's own
database; immutable downloadable indexes live on GitHub Releases/object storage.
The central builder reuses Node ingestion and publishes the stable manifest only
after artifact verification/upload. CLI installation, website deployment and index
publication have independent pipelines. See `docs-distribution-architecture.md`
for the pre-migration audit, host configuration gate and rollback path.

### 2026-10-29: Import update sets through the native XML loader

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

### 2026-10-29: Manage remote MIDs through configured SSH aliases

Keep the controller local and reuse the user's SSH key/known-host policy. Docker
build contexts and Compose manifests stream over SSH stdin; remote volumes replace
client-side bind paths. Native Windows uses the official ZIP and service wrapper
with LocalService and the vendor filesystem allow-list. Native Linux uses the
bundled JRE and SSH-user background launcher, requiring Python 3 but no sudo.
All deployments use unique ownership markers/labels; cleanup stops on mismatches
or uncertain runtime state. Explicit trust uses MIDServerAjax's platform Validate
action, never a direct write to the validated field. Runtime availability and
instance readiness are verified separately. See mid-remote-management.md.

### 2026-10-29: Present commands for the authenticated account

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

### 2026-10-29: Attachment transfers have a standalone command

Expose `attachments list/download/upload` at the root so transfer operations are
discoverable without knowing the record command tree. `get`/`add` remain action
aliases; remove the nested transfer subtree rather than register duplicate
implementations. Preserve optional attachment enrichment on record/request views.
Downloads identify the attachment directly and derive only a safe local basename
from remote metadata; local overwrites are explicit. Uploads retain declared
mutation guards and confirmation.

### 2026-10-30: Explicit browser-session domain commands

Preserve local domain-header configuration for existing auth methods. Add
session-current/list/set/reset for saved browser-session credentials using the
platform picker endpoints. Keep reset separate because broadening to global
changes a potentially shared browser session. Select by exact picker sys_id and
verify reset/selection with current-domain readback. Do not call touch-session:
the supplied successful diagnostic sequence did not require it. Surface probe
errors unless the platform explicitly reports an invalid domain table. The
Windows shutdown assertion remains a separate investigation.

### Current Node.js LTS support (2026-10-31)

Support and test the current Node.js LTS release on Linux and Windows. CI,
publishing workflows, and website Node stages follow the LTS alias. Documentation
directs users to Node.js LTS rather than promising a historical minimum. The CLI
does not declare its own numeric engine floor; dependency engine requirements
remain intact. Older release lines are not part of the compatibility contract.

### 2026-11-04: Preview and commit retrieved update sets through the CICD API

Retrieval stops at a loaded retrieved update set; applying it is a separate,
explicitly confirmed step. `updatesets preview` and `updatesets commit` call the
platform's own CICD Update Set API (`POST /api/sn_cicd/update_set/preview|commit/
{remote_update_set_id}`) and follow `GET /api/sn_cicd/progress/{id}`. Hidden Ajax
processors and `GlideUpdateManager2` background scripts are not used: they bypass
platform validation and are not a public contract. A missing plugin (404) or role
(403) is reported as "nothing was started" instead of degrading silently.

Preview problems live in `sys_update_preview_problem` keyed by `remote_update_set`.
`updatesets problems` reports them read-only; jsn never accepts, skips, or ignores
one, and commit refuses while any remains unresolved. Resolving a problem is a
human decision made in ServiceNow. Both operations verify the retrieved set's
state afterwards (`previewed`, `committed`) and report an unverified outcome as an
error rather than assuming the platform applied it. Neither operation selects an
update set or changes scope. The proposed import modifiers `--name`, `--local`, and
`--state` are refused with the supported alternative: a retrieved set keeps the
identity in its XML envelope, import never converts it to a local set, and state
transitions are preview/commit for retrieved sets and `reopen` for local ones.

A commit resolves the local set it created from `sys_remote_update_set.update_set`
(the platform's exact reference) and only falls back to a name lookup when that
reference is empty. Duplicate names therefore do not turn a known local copy into
ambiguity; an actually ambiguous or missing copy is reported, never guessed.

### Seed empty documentation services from the hosted index (2026-10-31)

Download a validated, consistent SQLite snapshot only when service storage is
empty. GitHub remains authoritative for revision checks and incremental updates.
Publish snapshots from the live documentation index without re-ingesting source
files; never include the Rails accounts database. Bootstrap failure falls back
to the existing Git build and never removes a working index.

### Record watching uses AMB's Bayeux long-poll, not socket.io (2026-11-04)

Issue #396 asks agents to observe one record instead of polling it. ServiceNow's
AMB endpoint (`/amb`) is CometD/Bayeux: JSON message arrays POSTed to
`/amb/handshake` once and `/amb/connect` for subscribe and long-poll. That is
implemented directly with `fetch`, so no socket.io or WebSocket dependency is
added and the protocol stays testable against a local mock. The record-watcher
channel name is `/rw/<actionPrefix>/<table>/<base64(query)>` with `=` padding
replaced by `-`.

AMB authorizes like a browser session (cookies plus X-UserToken), so the command
requires a credential that can produce a UI session. `SDKClient.ambSession()`
makes that requirement explicit and reports recovery guidance when a
bearer-only profile cannot satisfy it, rather than pretending REST auth works.

Delivery is best effort. A reconnect re-subscribes the channel and reports the
gap; missed events are neither replayed nor claimed. Observation is bounded by
`--timeout`/`--max-events`, and Ctrl+C unsubscribes before exiting. Scheduling
and user notification stay with the calling agent.

A watch subscribes to one record (`sys_id=<id>`) or to an encoded query
(`--query`), which the read validator checks before subscribing. Live
verification on 2026-11-04 confirmed the handshake, subscribe ack,
cross-session delivery and a notification shape with a `record` map of
changed fields plus `sys_*` audit fields and no `table`/`sys_id` (the
subscription supplies them). On 2026-11-25 a basic profile's session
subscribed to a query channel and received insert, update and delete
payloads carrying `sys_id`, the changed field names and `entry`/`change`/
`exit`, including `exit` when an update took a record out of the query. A
user without read access got the same events with values withheld, and a
mid-stream `500` was reported as a gap. A query event that arrives without a
`sys_id` carries a `warning`, since a query channel has none to fill in.

### Table behavior mirrors the platform's Configurations inventory (2026-11-04)

`jsn tables behavior` reports the families an administrator checks before changing
a table, matching what ServiceNow's classic "Configurations for <table>" page
shows. Sources: `sys_script`, `sys_script_client`, `sys_ui_action`,
`sys_ui_policy`, `sys_data_policy2`, `sys_dictionary`, `sys_dictionary_override`,
`sysevent_email_action` (by `collection`), `sys_security_acl` (by name pattern
`*`, `*.`, `<table>`, `<table>.`, ancestors), `sys_ui_style` (by `name`),
`sysrule_view` (by `table`) and `sys_flow_record_trigger` (by `table`).

Two deliberate differences from the page's counts, because the page's number
would hide configuration that actually runs:

- Global business rules and global UI actions are included and labelled
  `global_actions`. On the reference instance (dev366743, `incident`) that adds 83
  business rules and 45 UI actions to a page that shows 72 and 51.
- A `<ancestor>` UI policy with `inherit=false` is excluded, because it does not
  apply to the child table.

Ordering travels in `sysparm_query` (`ORDERBY` plus a second `ISEMPTY` phase so
rows missing a primary key sort last), never as an in-memory sort of a returned
page, so per-category cursors stay stable across pages. Rows that satisfy two
ordering phases are de-duplicated by `sys_id`.

Flow coverage is record triggers only. Flow templates and timer/catalog/REST/SLA
triggers have no table-scoped join exposed by the platform, so they are reported
as `unsupported` with the trigger type named rather than matched by text.

### Compact human home supersedes once-only catalog selection

Bare interactive human `jsn` always shows a small local home. The existing
`.welcomed` marker decides only whether to greet; it cannot send returning
users to the command catalog. Fresh users see setup then help. Configured users
see the selected local profile and a few next commands, without auth, probes,
network, config paths, or version banners. Explicit help and machine/agent/piped
output retain their existing contracts, including the explicit profile picker.

The interactive setup add-connection wizard opts into concise success output:
one authentication confirmation and one next command. It skips the redundant
preset recap and status view, not authentication checks or safety prompts.
Explicit auth login/status retain their existing output. The browser PTY fixture
substitutes browser acquisition only; real loopback verification and persistence
still run. Browser discovery is deterministic, never inherited from the host.

### First-run welcome orients above help, once (2026-11-04)

Historical decision; the compact human home above supersedes catalog selection
and config/version banners, while preserving the exclusive greeting marker.

Issue #387 adds a short orientation before setup: bare `jsn` on a fresh
installation prints a compact front door without appending the grouped catalog.
Explicit `jsn --help` remains comprehensive; scripted and configured-user output is unchanged. It is not a connection wizard and never starts an auth or instance
operation, so setup and authentication stay optional until a command needs
ServiceNow.

What it says (12 lines maximum at 80 columns, plain ASCII):
`jsn setup` is the obvious next step; `jsn --help` is the secondary pointer to
the complete command list. The welcome also names the local config path and
installed package version. It does not perform network, auth or instance work.
The `JSN_NO_WELCOME=1` suppression switch remains available.

It is shown at most once, recorded by a `.welcomed` marker in the XDG config dir
(the same directory the daily-check markers use, mode 0600). The marker is
claimed **exclusively** before anything is printed: the stamp is written to a
temp file and hard-linked into place, so two first runs racing on one config
dir produce one note, one complete marker, and no partial writes. A filesystem
without hard links falls back to exclusive create. A read-only config dir does
not fail the command: the note still prints, and it may appear again next run.

It is skipped for machine-readable and piped output (`--json`, `--quiet`,
`--csv`, `--markdown`, `--get`, non-TTY), for agent/CI environments, for
`TERM=dumb`, and for installations that already have a connection. A skipped
run does not write the marker, so piping help once does not consume the welcome.
`JSN_NO_WELCOME` suppresses it only as the literal value `1`; `0`, empty and
unset all mean normal first-run behavior. `--help`, `docs` commands, and every
other command are unaffected.

The note is width-aware: it wraps descriptions under the command on narrow
terminals and never truncates or splits a command name. An interrupted first run
(Ctrl-C) leaves either no marker and no note, or a complete marker and at most
a partial note - never a complete note the marker does not record.

### 2026-11-10: Machine output carries data, and table reads skip the UI session

Three corrections from a week of agent traffic (4,800 `jsn` invocations, 1.8M
output tokens, 50 truncated `flows show` results):

`flows show` returns the extracted steps without the raw ProcessFlow document;
`--raw-payload` keeps it. On a 10-step flow the payload was 536KB of 1.06MB of
data, and `actionInstances`, `flowLogicInstances` and `subFlowInstances` were
byte-identical at both levels, so every step serialized twice.

Flow inspection attaches `_formatted` non-enumerably, the way `catalogitems
show` already does, so the rendered tree stays out of the JSON envelope. The
other commands keep their current `_formatted` contract; stripping it globally
changes a wider surface and stays a separate decision.

Automatic context banners are retired for all reads, including terminals. It printed while the format still reported pretty, so a banner
merged by `2>&1` landed in front of the extracted JSON and broke
`json.load(sys.stdin)` / `jq` at character 0; it also cost five requests per
command (user, application preference, update-set preference, scope, update set).

Table, stats and batch requests authenticate from their own headers and no
longer bootstrap a UI session on every invocation. Everything else keeps the
bootstrap it reads — including binary attachment uploads, which upload with the
session cookie and user token. An instance that needs a session for table reads
sets `JSN_ALWAYS_WARM_SESSION=1`, which restores the previous path for the whole
process; the CLI does not silently retry a refused read behind a caller's back.

**Superseded for OAuth by the current session-default policy.** Live reads of
sys_store_app with ws_access=false returned 403 with Bearer and 200 with the same
account's Cookie/X-UserToken session. OAuth now prefers the existing UI session
for Table/Stats/Batch as well. `JSN_ALWAYS_WARM_SESSION=0` explicitly selects
header-only OAuth only on stateless-capable routes; required UI endpoints and
`stateful:true` cannot be opted out. Value 1 still forces session use. Basic/TOTP,
supplied token and GCK policies, existing bootstrap-unavailable Bearer fallback,
and bounded recovery/mutation-replay rules are unchanged. No 403 warm/retry is
introduced. See [OAuth request transport](../guides/setup.md#oauth-request-transport).

### Table audit status extends `tables` (2026-11-25)

`jsn tables audit <table> [--field <name>]` is a subcommand of `tables`,
like `tables behavior`, so it adds no root command and inherits the family's
capabilities. It answers "is this audited, and why not" from the dictionary and
three properties rather than from `sys_audit` rows, because missing history
cannot show which rule suppressed it. Verdicts follow the dictionary
`attributes` string; `sys_schema_attribute_m2m` rows are compared and every
disagreement is listed. It reads every dictionary row of the table and its
ancestors in one bounded query (2000 rows), because CMDB child tables carry
their own rows for inherited columns: on dev485581 the `cmdb_ci_linux_server`
chain has 552 rows, and 113 of its elements are defined on more than one table
in the chain. See [Table audit status](domain-model.md#table-audit-status).

### Audit verbs are subcommands, not options (2026-11-25)

`jsn tables audit <table> [--field <name>]` reads, and every change is its own
verb under it: `audit enable|disable <table>`, `audit exclude|include <table>
<field>` and `audit deletes <table> on|off`. Capabilities declare the five as
two-token mutation paths (`mutationSubcommands: ['audit enable', ...]`), which
`mutationPaths` already splits on spaces, so the read-only profile, the
mutation guard and capture context block exactly those verbs while the status
read stays a read.

The alternative, one `tables audit` subcommand whose flags made it a mutation
through a new `mutationOptions` capability field, was rejected: it adds a second
classification dimension every consumer must learn (`mutationOptions` would also
need handling in the operation-class derivation from `mutationSubcommands`), it
hides mutating verbs from discovery and `--all-commands`, and it makes the same
subcommand readable or blocked depending on argv. A subcommand costs one word
and needs no capability change.

The read stays the default path for `audit`, so a caller who passes only a table
name still reads; a table literally named like a verb is reached by the verb
names being matched first, which is why the verbs are reserved words here.

### One directory per owner at the repository root

The repository root holds `cli/`, `docs/`, `site/`, and GitHub metadata under
`.github/`, plus the files npm and Git require. Everything else lives with the
thing that owns it: website assets and preview helpers under `site/scripts/`,
CLI acceptance and docs-publishing helpers under `cli/scripts/`, contributor
research under `docs/research/`, repo-only CI tooling under `.github/scripts/`,
and contributor verification guides under `docs/verification/`.

Verification uses neutral contributor documentation rather than personal agent orchestration or skill autodiscovery. Run `node cli/scripts/verify-jsn.mjs` from the repository root. The manual instance lane uses independently configured GitHub environments, not local profile state.

Recorded verification evidence under `docs/verification/` keeps the command paths
it captured. Those files describe runs that happened at the time, so later layout
changes do not rewrite them.

### Documentation source roots are lexical authorization boundaries

Ingestion, refresh and snapshot builds accept explicitly selected real directories,
not filesystem aliases to other trees. Reject symlink/junction roots and any
symlink/junction ancestor, even if the target is inside the source tree; use the
real, canonical directory path when configuring a source. Caller-selected roots
are authorized independently of the destination index/artifact path. Normalize
relative paths and `..` before access, then pin the canonical root and check walked
entries against it using path-component containment (not string prefixes).
Nested file/directory links remain ignored. Missing optional roots remain optional,
but dangling aliases are rejected. Service sync checks existing roots before Git
and checks fetched Markdown before revision shortcuts or publication. Failure
retains the installed index and published snapshot. This is a static-tree input
boundary, not a race-proof sandbox against a process concurrently replacing files
between validation and read, nor a prohibition on hard-linked files.

## JSN feature map

This is the product map for JSN. The verification guide under `docs/verification/` describes how to prove selected surfaces work. It is not a second product map.

| Surface | User entry point | Implementation | Proof |
| --- | --- | --- | --- |
| Records | `records`, `incidents`, `changes`, `requests`, `tasks`, and related table commands | `src/commands/records.js`, `src/commands/_simple.js`, `src/commands/_ticket.js` | CLI tests plus a read-only disposable-instance drive |
| Cross-profile diff | `diff record` | `src/commands/diff.js`, `src/session.js`, `src/resolve-record.js` | Focused fixture tests; live verification requires two authenticated profiles |
| Authentication and profiles | `auth status`, `auth switch`, setup and login commands | `src/commands/auth.js`, `src/config.js`, `src/app.js` | Auth status without exposing credentials; profile-selection tests |
| Raw REST | `rest` | `src/commands/rest.js`, `src/session.js` | GET-only request against a safe read-only profile |
| ServiceNow domain surfaces | CMDB, catalog, ATF, flows, decision tables, users, groups, scopes, and platform commands | `src/commands/` | Command help, focused unit tests, then safe instance-backed proof where available |
| Platform stats | Fixed, bounded, read-only `/xmlstats.do` summary with allowlisted metrics and honest partial/error statuses | `src/commands/platform.js` | `test/platform.test.js`, local JSON smoke, safe authenticated PDI proof |
| Documentation | `docs`, including search, refresh, ingest, and sync flows; shared JSON service | `src/commands/docs/`, `docs/`, `skills/` | Local fixture search in JSON and Markdown; no instance required |
| Output and scripting | `--json`, `--markdown`, `--csv`, `--get`, and styled output | `src/output.js`, `src/cli.js` | Output-shape and CLI tests |
| Performance and diagnostics | `perf`, logs, transactions, snippets, and inspect commands | `src/commands/perf.js`, related command modules | Read-only command checks and focused tests |
| GraphQL | `graphql` with positional, `--query`, `--query-file`, or `--stdin` documents | `src/commands/graphql.js`, `src/sdk.js` | Bounded authenticated query plus command/transport tests |

For proof details, start with the [verification guide](../evidence/verification/README.md). Add a feature here only when the command exists in the source and its user-visible behavior is understood.

## JSN current state

### Verified in this branch

- The repository is a Node.js ESM CLI with no build step.
- `bin/jsn.js` is the executable entry point and `src/cli.js` registers the command surface.
- The project-local verification guide lives under `docs/verification/`.
- Verification evidence belongs under `.verification/evidence/` and must not contain credentials or raw environment dumps.
- The local documentation fixture provides the safe, instance-free drive for documentation status and search.

### Known limits

- Live records and raw REST proof require a disposable read-only ServiceNow profile.
- Integration tests can mutate ServiceNow data and are not part of the default local proof.
- Runtime credentials stay outside the repository in the configured auth backend.

### Update rule

Update this file when a durable project fact changes. Do not turn it into a daily activity log. Record why a durable choice exists in `docs/DECISIONS.md`.

## Targeted documentation retrieval

The document reader supports `--outline` and `--section` alongside `--path`.
Full-document reads remain the default. No ServiceNow connection is needed, though a
selected profile chooses the family when no release is named.

```sh
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --json
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --outline --json
## Copy an ID from that outline, rather than guessing a slug:
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section '<ID>' --styled
node cli/bin/jsn.js docs --path api-reference/web-services/scripted-graph-ql.md --section '<ID>' --json
## Exact unique displayed heading text is also accepted.
## Pin the revision returned by the outline to reject a changed index:
node cli/bin/jsn.js docs --path '<exact-path>' --revision '<revision>' --section '<ID>' --json
```

IDs bind the document path, release, revision, body and heading ordinal. They are
not browser anchors and do not survive changes. Duplicate exact headings produce
an ambiguity error listing candidates. Overloads with distinct signatures remain
distinct headings. A missing section is an error, never a full-document fallback.
Revision selection is a mismatch guard, not historical snapshot access.

CommonMark parses top-level ATX and setext headings. Headings inside blockquotes,
lists, fenced or indented code, and HTML blocks are not selection boundaries.
Selection ends before the next equal-or-shallower heading, retaining descendants.
Source text is sliced verbatim, including tables, code and lists. No section is
cut to fit `--lines`; that flag controls only full-document human previews.

Selections always include the document preamble and each ancestor's introduction.
This retains warnings and prerequisites placed before child headings. It cannot
identify all semantically relevant context: warnings in siblings and linked pages
may still matter. `subtree_complete` means syntactic completeness, not a complete
answer. `semantic_completeness` is always `unknown`. Use the outline and full page
for broader questions. Included source spans use zero-based UTF-16 offsets with
exclusive ends. Outline line numbers are one-based and inclusive.

JSON carries the document body once, without a duplicate `_formatted` preview.
The `commonmark` dependency supplies established CommonMark parsing and source
positions rather than a homegrown fence/heading recognizer. It does not render or
rewrite the selected body. `context_sections` lists omitted heading IDs/titles so
prerequisites in siblings are discoverable without claiming they are irrelevant.
Identity, release, revision, service and selection metadata remain available, as
are `--get data.body` and `--raw --get data.body`. Human views retain Markdown
content with source provenance and explicit context limits.

The shared local/hosted HTTP implementation accepts `outline=true` or
`section=<ID-or-exact-title>` on document endpoints and advertises
`section_protocol: sections-v1`. This PR does not deploy that service. When an
older service ignores these parameters and returns a full document without the
protocol marker, the CLI uses the same parser locally. Retrieval metadata says
`execution: client-fallback` and `full_document_transferred: true`; this saves
stdout/context, not network transfer. A service error is not silently retried.

## Results and bounded task measurements

The public history keeps failures, blocked work, and missing historical metadata.
Selected-task verdicts do not use static product completeness. Cleanup is a separate
reported state; missing history is unknown. Server receipt proves storage only:
there is no runner readback acknowledgement in this slice. No historical record is
rewritten and no database migration is needed.

### Reproduce the six-task fixture contract

```sh
npm --prefix cli ci
node cli/scripts/task-measurements.mjs /path/to/evidence
node --test cli/test/task-report.test.js
```

Catalog: `/benchmarks/bounded-reads-v1.json`, source-controlled under
`site/static/benchmarks/`. It defines five bounded flat reads and a documentation
section desired outcome, reusing #491's exact row/field/subtree verifiers and
instrumented GET-only loopback servers. The runner exercises the existing 33-case
baseline (99 fresh processes), then publishes only the six selected JSON tasks
(18 samples). These are offline fixture measurements, not 71 acceptance scenarios,
live ACL proof, human output measurements, or a cross-SDK ranking.

`tasks.json` contains taskset version, SHA256 of exact catalog bytes, fixture SHA,
source revision/dirty status, tested package version separate from harness source,
Node/process/cache dimensions and each sample's measured end-to-end milliseconds,
UTF-8 stdout and stderr bytes separately, rows and measured server request count.
Token counts, tokenizer provider and encoding are explicitly unavailable/null;
no characters/4 estimate. Agent-generated tokens and cost are not collected.
Live target family/build are null, not copied from fixture document release.
Machine JSON is named explicitly. The closed report omits raw responses, command
arguments, cleanup identifiers, provider URLs and credentials. Existing private
acceptance evidence remains unchanged.

### Optional acceptance projection context

Existing schema 1/2 projections remain accepted. New producers may include this
closed optional root object (the existing workflow is intentionally not edited):

```json
{"measurementContext":{"tasksetVersion":"acceptance-v1","suiteSHA256":"<64 lowercase hex>","environmentLabel":"linux-ci","environmentSHA256":"<64 lowercase hex>","cleanupState":"unknown"}}
```

Allowed tasksets: `acceptance-v1`, `bounded-reads-v1`; environment labels:
`offline-fixture`, `linux-ci`, `linux-local`; cleanup states: `unknown`, `passed`,
`failed`, `not-required`. Producers must hash the actual suite sources and assign
labels only from captured provenance, never infer them from passing checks. The
environment SHA256 must identify the actual sanitized runtime configuration and
machine class; a coarse label alone cannot establish comparable environments.
Do not hash credentials, usernames or private provider URLs into this public key.
This is metadata for comparisons, not an adapter importing bounded tasks into the
acceptance scenario allowlist. No unsupported platform task IDs are admitted.

Timing history compares only successful nonzero clean-source runs in the latest
exact cohort: suite hash, taskset version, sorted check IDs, mode, target label,
environment label and fingerprint, platform, Node, domain separation, harness source, and target
family/build/version/patch/hotfix where captured. Missing live family/build makes
runs non-comparable. Null patch/hotfix remain unknown, not asserted equivalent.
An environment label is coarse: measurements remain observational, not causal
hardware-controlled speed claims. Failed, blocked, zero-execution and unknown
historical runs are visible but excluded from timing bars; there is no leaderboard.

The tested package revision/version stays visible separately; it is not part of
the cohort so future package changes can be observed under the same harness.
No global one-score ranking, SDK adapter, real tokenizer, live provider request
hook, deployment, or CI publication acknowledgement is implemented here.

## Bounded CLI regression baseline

Run from the repository root after `npm --prefix cli ci`:

```sh
node cli/scripts/bounded-baseline.mjs --output /path/to/evidence
## Optional repetitions, minimum 3, default 5
node cli/scripts/bounded-baseline.mjs --repetitions 5 --output /path/to/evidence
node --test cli/test/bounded-baseline.test.js
```

The script exits nonzero on content, request-count or byte-ceiling regression. It writes `results.json` with every command and sample, and `REPORT.md` with per-case medians, nearest-rank p95, row counts, stdout/stderr bytes and count overhead. It never uses a live instance. CLI processes use an allowlisted isolated environment and injected fixture auth. A GET-only transport routes the stable `fixture.example.test` identity to loopback. No real credentials, production dependencies, workflow changes or instance mutations are needed.

### What is measured

Each sample is a fresh Node CLI subprocess timed with `performance.now()`. It includes process startup, fixture auth, HTTP, parsing, formatting, output capture and exit. It is not backend latency. The local HTTP service stays warm, OS caches are uncontrolled, and there is no warm-process measurement. Five repetitions are a modest diagnostic default; p95 is descriptive and at this sample size is the maximum, not a service-level claim. Timing has no pass/fail threshold.

The source fixture contains two flat string-valued rows per table. The first includes Unicode, quotes, commas, tabs, line breaks and literal escapes. JSON, CSV and TSV must decode to the exact same selected rows and fields. Raw references preserve IDs. Display/both reference modes can flatten labels into CSV/TSV and are not claimed lossless equivalents. Existing output tests cover those semantics separately.

The five tables and fields were taken from the earlier bounded five-read profile, not invented as Steve's exact workloads:

| Table | Selected fields |
|---|---|
| sys_properties | sys_id,name,sys_scope,type |
| sys_script_include | sys_id,name,sys_scope,active |
| sys_security_acl | sys_id,name,sys_scope,operation,type |
| sys_scope_privilege | sys_id,source_scope,target_scope,target_name,operation,status |
| sys_flow_context | sys_id,name,state,sys_created_on |

Scoped queries use a fixture scope. Flows use a fixed time window and are not attributed to that scope. Every read explicitly limits to 2 with offset 0 and ORDERBYsys_id. This is a representative correctness fixture, not a volume or accessibility claim for these tables on any live instance. The existing CLI may repeat sys_id in the HTTP projection; the assertion checks the exact ordered distinct selected fields, not that incidental duplication.

Each table runs three formats with and without counts. The fixture returns 2 of 7 matching records. No-count must make one Table API GET. Count must make exactly two GETs, adding the stats API, and CSV/TSV must keep pagination notices on stderr. Count overhead is the difference of unpaired JSON medians, not an isolated server cost.

Documentation uses the existing local documentation server with a pinned SQLite document, revision `bounded-fixture-v1`, release `australia`. Full body, outline titles and selected subtree with ancestor introduction are checked against fixture expectations. JSON must not contain `_formatted` duplication. Outline/section must report service selection, no full document transferred, no truncation and unknown semantic completeness. A complete subtree is not necessarily a complete answer; sibling and linked prerequisites may still matter. This tests offline service selection, not hosted-provider availability or old-service fallback, which has existing dedicated tests.

### Byte baseline policy

`cli/test/fixtures/bounded-baseline/bytes.json` records maximum observed UTF-8 stdout and stderr bytes from at least three real fresh CLI runs for the pinned fixture. They are exact fixture-specific ceilings with no padding, not universal output limits. Response-envelope growth, duplicate presentation or unexpected diagnostics require review. Sizes are unmodified captured output, not wire bytes, JavaScript character counts or estimated tokens. No existing tokenizer is installed as a project dependency, so token counts are explicitly unavailable.

To deliberately accept an explained fixture/output change:

```sh
node cli/scripts/bounded-baseline.mjs --record-baseline --output /path/to/rebaseline-evidence
node cli/scripts/bounded-baseline.mjs --output /path/to/checked-evidence
```

Recording never claims a checked pass. Review the fixture SHA and byte diff before committing. The test lowers one ceiling by one byte, verifies rejection, restores the baseline and verifies acceptance using actual measured outputs. It also checks that targeted docs output is smaller than full output.

### Pending live integration

No live command or vendor trend is delivered in this slice. Integration with PR490's environment/credential delivery remains pending. Do not add a competing workflow or pass credentials as command arguments. A future explicit manual read-only mode should accept a vendor label and existing isolated credential-provider/environment inputs for vendor1 and vendor2, refuse non-GET requests, use identical bounded projections/window/format/count modes, and publish only safe aggregate measurements and source/version identifiers. Keep ACL-denied or unavailable tables distinct from empty success and do not claim equivalent datasets across vendors. Collect repetitions and cold/warm dimensions separately for each vendor; live timing remains measurement-only. No tokens, property values, response bodies or credentials belong in published live evidence.

## Acceptance build identity

The automatic Live acceptance results workflow tests the immutable source checkout selected by `github.sha`. It installs that checkout's CLI dependencies, stages the pinned scenario producer, and executes `cli/bin/jsn.js`. It does not install the npm dev channel.

The producer now reads `version --json` from the executable under test before running scenarios. Its complete version string is retained in the existing public `provenance.version` field. The source commit remains independent in `provenance.sourceSHA`. Workflow summaries explicitly identify the checkout, source commit and pinned harness commit. A checkout of package version `5.5.5` must not be relabeled `5.5.5-dev.197.1`.

### Historical evidence

Read-only inspection of `/results/acceptance_78864ca54ba948288754dc942da922ec`, Actions run `43798098142` and its sanitized public artifacts established:

- The matching public artifact has version `5.5.5` and source `084364837b6c7da724d5e40deb5e7f0635c0a9c7`.
- The workflow checked out that commit and ran `npm --prefix cli ci --ignore-scripts`, not an npm installation of JSN.
- The pinned producer commit is `65c4f3c8a66ea37b3bd3ecca87957bec30eb3fba`, separate from the tested CLI commit.
- Running `node cli/bin/jsn.js version --json` on that exact checkout returned `{"ok":true,"data":{"version":"5.5.5"}}`.
- The historical artifact did not retain a separate raw version-command receipt. Its source and execution path support the checkout identity, not a published prerelease identity.

No historical record was changed. No npm package-to-commit mapping is inferred.

### Published package testing

For a separately approved published-package run, the existing local acceptance wrapper supports `--version EXACT` and verifies registry metadata, integrity and the executable's reported version. This is not the automatic CI lane. Do not substitute `@dev` or `latest`, since either can advance between selection and execution. Wiring automatic CI to publication needs an explicit immutable published-version handoff and a publication dependency. This patch intentionally does not redesign that orchestration.

The site index and detail views already consume the same public version field, but main's server validator currently rejects dotted prereleases such as `5.5.5-dev.197.1`. PR #499 owns site projection/presentation work and must coordinate the matching validator change and index/detail regression coverage. This producer-only patch does not claim end-to-end prerelease ingestion works before that dependency lands. No schema or database changes are required for the version string. Keep artifact kind and harness revision distinct from the tested version and source revision.
