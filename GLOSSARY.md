# GLOSSARY.md — jsn domain vocabulary

The names we use for the concepts in this codebase. When code, PRs, and docs
disagree with this file, the file wins until it's updated — update it in the
same commit that changes the concept.

This is the **domain model**: the named things and how they relate. For the
architecture vocabulary used to *reason about* the code (module, interface,
depth, seam, adapter, leverage, locality), see the `codebase-design` skill —
jsn uses those terms exactly.

---

## Direct MID installation

An owned native ZIP installation, identified by `.jsn-mid-direct.json`, separate
from a Docker Compose installation. Prepared means extracted and configured but
not started. Started means the native launcher completed; registration requires
an instance read showing Up. Readiness additionally requires raw `validated=true`
after an explicitly approved platform Validate trust operation. Local Windows
direct mode uses a foreground console; remote Windows mode registers a uniquely
named vendor service under LocalService.

## Remote MID deployment

An SSH-targeted runtime with a private local ownership receipt and independently
verified remote ownership. Docker deployments bind an engine ID and labels to
exact container, volume, network and image names. Native deployments bind a UUID
marker and private directory to a Windows service executable/account or Linux
SSH-user process. Credentials travel on stdin, never in local receipts or SSH
arguments. Runtime start, instance registration Up and trust validation are
separate facts. Teardown must stop and verify the owned runtime before deleting
its files/resources or instance MID record; failure retains an uncertain receipt.

## Customization capture

A private local schema-versioned JSON report produced by bounded GET-only reads
of application metadata, scopes and upgrade history. Historical OOTB evidence,
caller-declared customer scope artifacts and unclassified metadata stay separate.
An upgrade skip is evidence of a past preserved customization, not a trusted
current OOTB baseline. The upgrade-history read is filtered server-side to the
preserved-customization dispositions, so a bounded budget reaches the evidence
and unmatched counts describe that filtered population. Every observed skipped
`file_name` is then resolved against visible `sys_metadata` with chunked
`sys_update_nameIN<chunk>` lookups, so the OOTB inventory covers the observed
skipped artifacts even though the broad `sys_metadata` read is an arbitrary
`sys_id`-ordered slice reported as a bounded sample rather than an inventory;
unresolved names and failed lookup chunks stay explicit. The bounded sample
describes only the unclassified and declared-customer categories. Non-global
scope is never ownership evidence. Coverage never infers exhaustion from a short
page: it compares the rows fetched with the Stats API count for the same query,
reports both, and reports `exhausted` only when the fetched rows account for the
available total. An unavailable count is reported as unknown. A 2xx table body
without a `result` array is a malformed envelope and makes that source
unavailable, never empty; comparing a report that has an unavailable or empty
source yields `unreliable` status so missing coverage is never read as mass
creation/deletion.
Missing ACL visibility, baseline and dependency analysis keep reports incomplete.
Comparisons use artifact table/sys_id identity and captured evidence, ignoring
local capture metadata and ordering. Observed additions/removals do not prove
creation/deletion. Saved review commands require no instance.

The SDK `readOnly` request option requires GET for the data request and
suppresses local credential last-seen writes unconditionally — a caller cannot
re-enable them by passing `touchLastSeen`. It preserves standard authentication,
including OAuth refresh and session/GCK bootstrap. Authentication POSTs and local
refreshed-credential storage are allowed; instance-record mutations and eval are not.
Upgrade history joins `file_name` to metadata `sys_update_name`. Raw dispositions
`4` and `104` identify preserved-customization skips; `reviewed_reverted` resolution
excludes that row. Display labels and other skip reasons are not equivalent evidence.

## Browser session import

An explicit `auth login --browser` operation launches a chosen installed
Chromium-family browser with a fresh temporary profile and waits for login.
Its loopback DevTools port is assigned automatically. It obtains the
page's `g_ck` and only cookies applicable to the current-user API URL, verifies
the current account, and persists standard `gck` credentials. It never chooses
between multiple matching tabs or imports a different account into an existing
named identity. Import is also available in setup's browser-session flow.
The login browser is closed and its temporary profile removed after completion,
cancellation, or failure. `--browser-url` retains an advanced connection path
that does not launch or close the user's existing browser.
Browser import is a credential acquisition path, not a fourth auth method;
Firefox and normal-profile browser integration remain future work.

## Runtime authentication recovery

`src/auth-recovery.js` creates the App-owned, identity-scoped recovery provider
passed to the SDK as `opts.recovery`. Its `recover({ status, kind })` returns
true only after replacing credentials. Its safe `error` supplies guidance
if the single retry is rejected. Only a classified authentication rejection may
recover: HTTP 401, a login redirect, or a login-page body (HTTP 403, 5xx,
network and abort are not rejections).

`src/session-recovery.js` owns classification and replay eligibility. Replay is
bounded to one attempt per request and one in-flight recovery per SDK client,
shared by concurrent requests through a session generation counter; a rejection
observed at an older generation replays with the rebuilt session instead of
recovering again. Recovery invalidates cookies, the user token and the warm-up
promise together, rebuilds the session, and verifies the current user through
the same `_setAuth` cookie/CSRF path before any replay; a different account or
an unverifiable session ends recovery without replaying.

Reads replay once after successful recovery. Writes and stateful processors
replay only on HTTP 401, which is definitive pre-execution; a login page or
redirect on a write is refused with an actionable error unless the caller
explicitly opts in. Store install/update are GET-shaped stateful requests;
`SDKClient.request` consumes their internal `stateful: true` policy before
constructing the HTTP request, so login-page/redirect recovery cannot resubmit
them. Ordinary read recovery and definitive HTTP 401 handling are unchanged.
Captured GCK/browser-session credentials are not renewable:
their rejection is reported with `recapture_required` and an explicit
`jsn auth refresh <profile> --browser` step. Uncertain mutation outcomes never
replay.

Browser profiles persist `reauth: auto | confirm | never`; missing means
`confirm`. Both `auto` and `confirm` require a prompt-capable invocation through
`canUsePicker`. The interactive `confirm` prompt defaults to Yes; explicitly
declining keeps the browser closed and does not replay the rejected command.
OAuth refreshes the selected credential identity; Basic never
renews. HTTP 401 is `auth_error` with status and recovery guidance, HTTP 403 is
`forbidden` with ACL/role guidance. Neither exposes provider bodies.

## Authentication status

A status report separates saved credential availability from live connection
verification. Its default table and machine output omit user identity and
instance URLs; `auth status --details` explicitly reveals those fields, with
**User** as the identity column label. `--local` reports saved metadata without
an instance request. Profile names remain visible as selection identifiers.

## Authentication operations

The operations exported by `src/commands/auth.js` are the common implementation
for both `auth` command handlers and the human `setup` menu. The setup wizard
collects answers and calls `loginProfile`; it does not store credentials or
persist profiles independently. Login owns identity verification, preferences,
and saving. `--name` creates a new connection; `--profile` reconnects an existing
one. Defaults change only through a human choice, `--make-default`, or
`auth switch`. Public settings flags assign explicit values, so repeating a
bot's `auth modify` request is idempotent. Noninteractive commands never open
implicit prompts or browsers.

## CI search

`cmdb search` is a read-only, literal substring lookup across four common CI
identity fields. Every OR branch keeps the exact class restriction. Stable
name/sys_id ordering and one-row lookahead provide bounded pagination without
claiming an unreadable count is zero. Failed strict reads remain errors.

## Record metadata reader

An invocation-scoped SDK-bound reader of shared form layouts, table inheritance,
and related-list definitions. It caches metadata reads in-process, uses optional
GET-only batching and bulk section queries, and reports coverage uncertainty.
It retrieves definitions rather than related record data. Static references can
be described declaratively; scripted relationships remain platform-required.
Generic record retrieval does not automatically fetch form metadata.

## Command

A yargs command module — one file in `src/commands/`, exported as
`<name>Cmd = (wrap) => ({...})`. Everything the user types after `jsn` maps to
one. Commands are the unit the CLI registers, guards, and renders output for.

- **Factory-built command** — a Command produced by a builder rather than
  hand-written: `buildDevCmd` (`src/commands/_generic.js`) covers most
  simple table CRUD, `buildTicketCommands` (`src/commands/_ticket.js`) covers
  incidents/changes/requests/tasks. One line of config → a full command family
  (list/show/create/update/delete, aliases, scope validation, pickers).
- **No-instance command** — a Command that runs without a configured
  ServiceNow instance (`help`, `version`, `completion`, `setup`, `auth`,
  `skill`, `docs`). Declared via `noInstance: true` capability.
- **Mutation subcommand** — a subcommand that writes to the instance
  (`create`/`update`/`delete`/etc.). Declared via `mutationSubcommands`.
  Read-only profiles block these. See *capability registry*.

## Attachment transfer

`attachments` is the standalone owner of file listing, download and upload.
`download`/`get` identifies the attachment itself, without requiring its parent;
`upload`/`add` identifies the destination table and parent record and declares a
mutation capability. The former `records attachments` subtree is removed.
`records get --attachments` remains an optional record-view enrichment. Download
metadata cannot choose directories or device filenames, and existing local
files require explicit `--overwrite`. Results use the normal output envelope.

## Command discovery

`jsn discover` searches the live command registrations used for dispatch. Root
names, aliases, descriptions and child help paths are derived from the command
tree. Factory-built commands additionally expose their actual table/default
column configuration and supported view benefits through optional `discovery`
metadata on the command definition. This metadata is additive to the existing
root JSON registry; it is not a second command inventory or a mutation policy.

After login or OAuth refresh, the selected profile caches a command audience
bound to its account and instance. A verified `admin` role shows the full
surface. Other authenticated accounts see a compact task and connection surface;
an unavailable role check also uses that compact presentation and records the
uncertainty. Existing profiles without a cached audience retain the full surface
until authentication is renewed. Root help, root JSON, `discover`, and root shell
completion share this policy. `--all-commands` restores the full surface.
Explicit command paths are always registered; this is presentation, never an
ACL or an authorization claim. Role changes are picked up on authentication.

## First-run welcome

`src/welcome.js`. A short orientation printed **above**, never instead of, the
grouped root help when a fresh installation runs bare `jsn`. It names the two
ways in (`jsn setup`, interactive; `jsn auth login <instance>`, scriptable),
`jsn --help`, `jsn docs search`, `jsn skill install`, where config lives, the
installed version from `package.json`, and `jsn upgrade`; every command it
mentions is registered and declared `noInstance`. It requires no instance or
credentials and never reaches the network. It is shown at most once - a
`.welcomed` marker in the XDG config dir, claimed exclusively before the note is
printed, so racing first runs cannot both print it - and only to a human
terminal: never for `--json`/`--quiet`/`--csv`/`--markdown`/`--get`, piped
output, agent/CI environments, `TERM=dumb`, an installation that already has a
connection, or `JSN_NO_WELCOME=1` (the literal `1`; `0` and empty do not
suppress). A suppressed or piped run does not consume the once-only marker. The
text is width-aware: at 80 columns it stays within 12 lines, and on narrower
terminals it wraps rather than truncating a command name. It is not a connection
wizard: authentication stays optional until an instance-backed command needs it.

## Capability registry

`src/capabilities.js`. The single source of truth for command metadata the
middleware cares about. Each Command declares its capabilities once at the
definition site via `declareCapabilities(name, caps)`; factories emit the
declaration automatically (e.g. `buildDevCmd`'s existing `readOnly` flag).

The middleware **derives** the skip-lists (instance guard, daily checks,
context header) and the mutation-guard path list from this registry — it never
matches `argv._[0]` against hand-written string lists.

Capabilities: `mutationSubcommands`, `noInstance`, `skipDailyChecks`,
`skipContextHeader`. Auth and setup declare `skipContextHeader` so profile
management does not display or probe the old instance's scope/user/update set.
Daily checks remain independently controlled.

> Replaced: hand-maintained skip-lists in `cli.js` plus the hand-written
> mutation registry in `mutations.js`.

## Record resolver

`src/resolve-record.js`. One deep module that turns a human identifier into a
record. `resolveRecord(sdk, { table, identifier, matchField, resource })` → the
record (with display values) or a standard `not_found` error; `resolveSysId`
returns just the id; `isSysId` / `unwrapSysId` are the primitives.

Behind the interface: configured human-field precedence for nonhex identifiers,
explicit `identifierField` disambiguation (including legacy/nonhex sys_ids),
exact lookup followed by sys_id prefix then suffix. Each query requests at most
two rows; multiple matches fail with `ambiguous`, zero with `not_found`. Errors
carry machine-readable `resolution` metadata. Explicit human fields never use
partial matching. `isSysId` remains a 32-hex precedence heuristic, not a claim
that other values cannot be sys_ids. Commands do "resolve → mutate → report."

`src/records-engine.js` supplies shared in-process list/get/create/update/delete
operations. Generic records, ticket and table factories call this engine while
retaining their payload, confirmation, scope, picker and output policies. Read
commands accept explicit `--display-values raw|display|both`; omitted preserves
existing reference representation. No engine operation spawns another CLI.

> Replaced: ~12 divergent hand-rolled "query by identifier, throw if empty"
> copies across `_ticket.js`, `users.js`, `tickets.js`, `_generic.js`,
> `catalog.js`.

## Record watch

`jsn records watch` observes one record through an AMB record-watcher
subscription instead of polling the table. `src/amb.js` owns the protocol
(ServiceNow's `/amb` endpoint speaks Bayeux/CometD long-polling, not
socket.io, so no transport dependency is added) and event normalization;
`src/record-watch.js` owns the observation session — bounds, cancellation,
state fetching, reconnect backoff and gap reporting.

A **record-watch event** is what the notification itself carried: table,
record identity, operation and any change list or embedded record. A
**fetched state** is a separate follow-up read attached as `event.state`
with `source: "fetched"`; it is never merged into the notification, and a
failed read becomes `state_error` rather than changing the event. The
default `auto` policy fetches only when the notification lacks detail.

A **gap** is the window between a dropped connection and a successful
re-subscription. Record watchers are best-effort delivery: the platform does
not replay missed events, so the stream reports the gap (and the summary
reports `complete: false`) instead of implying a continuous history.
Observation is bounded by `--timeout` seconds or `--max-events`; Ctrl+C
unsubscribes and disconnects. Scheduling, retries across runs and user
notification belong to the calling agent/runtime.

AMB authorizes like a browser session: it needs session cookies and
X-UserToken, not a bearer or Basic header. `SDKClient.ambSession()` supplies
them from a gck credential or a warmed UI session, and fails with recovery
guidance when the profile cannot produce one. Watch is read-only.

## Record command profiles

`src/record-command-profiles.js` owns table/alias/default-column, identifier,
reference representation, list projection and essential/supplementary relationship
policy for the migrated table and ticket factories. `src/record-profiles.js`
validates immutable definitions and builds actual commands through the existing
factories. `buildRecordProfile` accepts an additional declarative definition;
`buildProfileCommand` selects a bundled one. Executable hooks (scope checks,
show enrichment, custom resolvers) remain code and extend the configured command.
The command's `recordProfile` metadata is the same validated definition used to
implement it; it is not a separate discovery-only map.

## Essential related records

A specialized record profile opts in through `relationships.essential` entries
(name, table, foreignKey, columns, ordering, bounded limit). Its show operation
reads those children in parallel and attaches `_essential` results with records,
loaded count, visible-row/ACL coverage, truncation and an exact retrieval hint.
`--no-essential` skips those reads. Unavailable sources stay explicit; they never
become successful empty arrays. Profile hooks remain composable. Generic get
and supplementary metadata/counts are separate and never fetch these children
implicitly. UI policies declare actions as essential, replacing console-only
output with the same children in JSON and human record sections.

## Constrained table views

A table factory's `extraQuery` defines a fixed list filter, not a default that a
user query replaces. `src/constrained-query.js` combines that filter with
literal AND predicates and ordering. OR/NQ/dynamic directives are rejected
before requests because encoded queries have no portable grouping syntax that
would preserve the fixed constraint. Generic records retain unrestricted
encoded-query support. `b4rules` specifically constrains `when=before` and the
Boolean `action_query=true`; rule order is not the classification.

## Session

The composite answer to "which instance am I talking to, as whom, with what
credentials and flags?" — effective instance URL, active profile (name +
`read_only`/`skip_confirmations` flags), username for credential keying.

`src/session.js` owns session resolution and application. Commands can select
an instance or profile without mutating the saved active profile.

The provider's authenticated HTTP session is separate from this local identity.
Concurrent requests on one SDK client share session initialization; failed
initialization can be retried by a later request.
Its effective application and capture update set are selected through the
concourse picker API in `src/context.js`, with session readback before success.
Writing a `sys_user_preference` row does not synchronize an already-warmed HTTP
session. When selecting an update set, select its application first, then the
set. A flow's explicit transaction scope does not select its capture update set.

## Output envelope

Everything a command emits goes through `app.output` (`src/output.js`).
Formats: `auto`, `json`, `markdown`, `styled`, `quiet`, `csv`, plus `--get`
(JSON path into the envelope — jsn's jq substitute).

- **Typed shapes / side-channel keys** — the declared way a command tells the
  styled writer what it's emitting: `records`/`columns`/`table`, `relationships`,
  `_context`, `_attachments`, `_variables`. Documented on `writeStyled`.
- **`_formatted`** — a Command may pre-render its styled view as a string on
  `data._formatted`; the writer prints it verbatim (and suppresses the raw
  field dump). JSON/quiet formats ignore it. This is the honest escape hatch —
  15+ commands use it. Domain-specific visuals (e.g. `auth status` badges)
  belong in the Command that owns the domain, rendered into `_formatted` —
  **not** as special cases inside `output.js`.
- **One format resolution.** `resolveRequestedFormat(argv)` (`src/cli.js`) is
  the single policy for which format a command line asked for, and the format
  middleware applies it. A parse-time failure never reaches that middleware, so
  the failure renderer calls the same function on argv from
  `LocalCLI.parseGlobalOptions` (the adapter's own parse, in tolerant mode) —
  never a re-scan of raw tokens. Precedence: the shortcut flags
  (`--json`/`--quiet`/`--styled`/`--markdown`/`--csv`) beat `--format`, and the
  last shortcut applied wins (`csv` > `markdown` > `styled` > `quiet` > `json`).

## Catalog ordering

`catalogitems search/describe/order` uses the native Service Catalog API for
requester access and fulfillment. Ordering is a declared mutation with its own
confirmation and read-only guard. It is exempt from development capture-context
selection because it submits runtime business requests, not metadata changes.
A preview only reads and never posts; unknown submission outcomes never cause
automatic replay. Inputs are catalog variables, not arbitrary fields on an RITM
or request header. Item inspection is one command — `catalogitems show`, with
`describe`/`inputs` as aliases — that reads the definition and the catalog API
and reports which one answered (`variables_source`). Questions are
`{name, label, type, friendly_type, mandatory, instance_supplied}` plus
required names; layout entries (containers, labels, HTML and rich text blocks,
breaks, UI macros) are not questions and are omitted. "Requested
for" is instance-supplied — the API marks it mandatory, the instance fills it
from the session, and `--requested-for` overrides it — so it is reported
separately and never blocks an order. `order` refuses a locally provable missing
mandatory answer before the confirmation boundary and reports unknown names
without blocking. `order_now` answers with the request (REQ); the requested item
(RITM) identity is a follow-up read whose failure still reports the placed order
and never triggers a resubmission.

## Case views

`cases` reads the caller's own accessible cases through the authenticated Table
API; nothing here changes a record. "Case" is application-specific, so the table
is detected from the known case applications in presentation order
(`sn_customerservice_case`, then `sn_hr_core_case`), named with `--table`, or
selected with `--hr`. Detection distinguishes a table that is not installed
(available: false) from access denied (HTTP 403, `forbidden`) and never reports
an unreadable source as an empty result. `cases tables` reports the same probes
per application. HR support is this generic path plus the explicit HR table;
employee self-service visibility remains the account's roles and ACLs, so an
administrator session is not evidence of an end-user view.

## Catalog item enrichment

`src/commands/catalog/enrich.js`. `enrichCatalogItem({ sdk, instanceUrl,
sysID })` → an enriched catalog item: variables fetched and grouped by variable
set, flow/workflow/delivery-plan names resolved. Pure async data-shaping —
no yargs, no output formatting. `catalog.js` keeps wiring, create/submit, list.

## Knowledge search

`knowledge` (`kb`) searches and reads through the native Knowledge API, keeping
article access decisions on the instance. It never retries via the Table API.
Search text is passed as a query parameter, not interpolated into an encoded
table query. Article HTML stays intact in JSON and renders as Markdown for
humans. Read commands omit parameters that explicitly increment view counts.

## Docs data layer

`src/commands/docs/{db,search,ingest,sync,refresh}.js`. All SQLite/FTS5 schema
knowledge lives here. `docs.js` command handlers stay thin: argv → options →
`app.ok`; they call data-layer functions (`searchDocs`, `getDocsIndexStats`,
`getDocByIdOrPath`) rather than running SQL.

## Table behavior inventory

`src/table-behavior.js` is the read-only discovery layer behind
`jsn tables behavior <table>`. It inventories accessible configuration for a
table and its ancestors: business rules, client scripts, UI actions, UI policies,
server data policies, dictionary entries, dictionary overrides, notifications,
access controls, styles, view rules and flow record triggers. It never executes
scripts, flows or notifications, evaluates conditions, or claims to predict which
artifact runs for a record.

A **behavior category** is one artifact family with a fixed layer. Client
requirements (`client_scripts`, `ui_actions`, `ui_policies`) stay distinct from
server enforcement (`business_rules`, `data_policies`); a client mandatory field
is not server-enforced. Each item carries a stable **behavior reference**
(`{ kind, source_table, sys_id }`) for later direct retrieval.

An **association** is `direct` when the artifact's table field equals the
requested table, or `inherited` otherwise. **Association detail** records the
basis: `exact_table`, `ancestor_table` (platform inheritance, business rules and
UI actions), `ancestor_applies_extended` (`sys_script_client.applies_extended`),
`ancestor_inherit_flag` (`sys_ui_policy.inherit`, `sys_data_policy2.inherit`), or
`global_actions` (`global` business rules and UI actions). Access controls carry
the clause that matched instead of a table field: `direct_table`, `direct_field`,
`direct_table_wildcard`, `ancestor_table`, `ancestor_field`,
`ancestor_table_wildcard`, `global_all` and `global_field`. Dictionary rows with
no element are **table-level rows** (`level: table`) rather than columns.
`sys_overrides` links are preserved as **override evidence**; effective override
resolution is not simulated.

Results are **ordered by the instance query**, never by sorting a returned page,
so continuation stays stable: business rules by `when` (platform phase order,
missing last) then `order` then `name`; UI actions by `order` then `name`;
client scripts, notifications, styles, view rules and flows by `name`; access
controls by `name` then `operation`; dictionary categories by `element`; policies
by `order` then `name`. Rows missing a primary sort key are fetched in a second
`ISEMPTY` phase so they sort last.

A **category status** is `complete`, `partial`, `unavailable` or `unsupported`.
`unavailable` (permission, missing table, malformed response) and `unsupported`
(missing required field/layout) are never empty results. `partial` covers
continuation, response-budget truncation, child-read failures and
ACL-restricted fields. Results describe **accessible configuration** only.

Discovery defaults to active configuration, applies per-category bounds
(`--limit`, default 200, max 500) and a response-byte budget (`--max-bytes`,
default 524288, max 1048576).
Oversized items are omitted whole with explicit truncation metadata; script,
message and notification bodies are never requested or cut. A **behavior
cursor** is a stateless per-category phase+offset token tied to the table and
filter signature; it provides continuation, not snapshot isolation. Reading
fields from `sys_dictionary` before filtering means a missing plugin/layout
produces an `unsupported` status instead of an unfiltered query.

**Flow coverage is record triggers only** (`sys_flow_record_trigger`). Flow
templates and other trigger families (timer, catalog, REST, SLA) are reported as
`unsupported` with the trigger type named, because the platform exposes no
table-scoped join for them; no text match over flow definitions is guessed.

## Flow inspection

`src/flow-inspection.js` is the single deep module for `flows show` and the
interactive flow picker. `inspectFlow({ adapter, identifier, instanceURL,
depth })` delegates remote flow/custom-action inspection through the narrow
adapter, then owns depth normalization, recursive subflow traversal, custom
action expansion, caches, cycle handling, nested failures, and `_formatted`
rendering. `src/commands/flows.js` only adapts yargs/App output to this seam.

## Legacy Workflow Editor inspection

`src/workflow-inspection.js` is the read-only reader for the legacy Workflow
Editor (`wf_workflow`, `wf_workflow_version`, `wf_activity`, `wf_transition`,
`wf_condition`, `wf_stage`, activity configuration in `sys_variable_value`).
`jsn workflows` exposes it; `jsn flows` remains Flow Designer and the two are
never conflated. It resolves a workflow by name, workflow sys_id or version
sys_id, selects the requested or published or newest version explicitly, and
keeps every activity, condition, transition and definition sys_id. A version's
definition is **design-time configuration**, not evidence of what executed.
Missing definitions, dangling links and ACL-blocked components are reported in
`integrity`/`coverage` and never rendered as empty data. The reader issues only
Table API GETs and requires no checkout. `listPublishedWorkflowVersionsForTable`
is the reuse seam for table-behavior discovery; it reports the named table
association only and does not discover script-started workflows.

The flat `transitions` JSON remains compatible; `transitions_by_activity` adds
name/sys_id-ordered source groups (including terminal activities) with outgoing
edges ordered by destination name then transition sys_id. `loops` reports cyclic
strongly connected components (including self-loops), every participating edge,
and members entered from outside the component. Analysis is in-memory only.
`coverage.loops_found` counts observed components, not every simple cycle;
`coverage.loop_detection_complete` requires complete activity/transition reads
and known endpoints. Incomplete detection must never claim no loops. Graph
completeness is independent of missing conditions or activity definitions;
existing integrity findings remain visible. Reaching a transition query bound
sets `coverage.transitions_truncated` and makes overall coverage incomplete.

`src/workflow-steps.js` numbers already-loaded activities by iterative depth-first
preorder from the selected version's `start_activity_id`. Outgoing edges prefer
unconditional or `Always`, then destination name/ID, condition name/ID and edge
ID (locale-independent). Already-numbered activities are never revisited.
Unreached activities append by name/ID and are labelled as not reached from start.
`steps` exposes `{ number, sys_id, name, reached_from_start }`; `step_order` names
`start_traversal` or `stable_fallback` and supplies a fallback reason when the start
is missing/unreadable or topology cannot be read. Fallback numbers do not claim
flow order. Partial topology is explicitly described as observed only.

Every transition adds `is_sequential`: only one preferred edge to the next
reached step can be implicit, so parallel conditions remain visible. Fallback
and unreached steps hide no edges. Human `STEPS` prints numbered activities,
terminal markers (only with complete topology), and non-sequential exceptions;
`LOOPS` uses those same numbers. Only edges within a detected cyclic component
that return to an earlier/equal step get the closing `↺` marker. This changes no
SCC membership or completeness semantics. Record IDs (including IDs embedded in
scripts/free text) stay in JSON, not the formatted outline. Configuration detail
is separate from the steps so scripts do not interrupt the numbered flow.

## Flow Designer action definition

`src/processflow-actions.js` owns the resource-specific action lifecycle.
A complete **action definition** is Process Flow metadata plus executable
`steps` from `/step_instances`, including inputs, outputs, scripts and mappings.
The `sys_hub_action_type_definition` row alone is only the **parent**, not proof
of an executable action. Create combines a source document's executable fields
with the new parent's own defaults and binds new steps to that parent. Create
rejects persisted step IDs and parent bindings before allocating a parent.
Update requires a full target document, preserving state and reserved output IDs.
A **verified save** compares persisted executable fields after the PUT in both
directions. Only known empty defaults and server UI metadata are normalized. A
**test dispatch** only returns a context ID; a **completed action test** also
requires `COMPLETE`, blank error fields and actual declared runtime outputs.
Neither operation implies publication.

## Flow Designer terminal orchestration

`src/flow-designer-interactive.js` owns guided prompts and target selection,
not provider persistence. A guided action produces a complete executable
source definition from discovered step schemas; a guided flow produces the
existing create/update manifest. Both reuse the SDK/domain lifecycle and its
readback. Editors clone saved definitions and change only selected fields.

A **prompt-capable invocation** requires `canPrompt()` and `FormatAuto`, with
no explicit definition data, output-map or `--get`. Optional parser identifiers
are validated by handlers outside that mode. Cancellation and refused wizard
save confirmations never allocate a parent or dispatch a mutation. Flow Designer
usage errors opt into the shared renderer's JSON envelope with
`error.jsonEnvelope = true`; other command families retain legacy stderr usage
errors and all usage errors keep exit status 2.

## Flow safe-edit session

`src/flow-safe-edit.js` owns the provider's `safeEdit` acquisition/read/release
contract around existing-flow patch, preservation verification and Autosave.
The session is a user-level edit lock, not a published snapshot, execution or
artifact deletion. Preview never changes it. Refuse pre-existing same-user and
other-user sessions; release only a newly acknowledged acquisition and verify
its absence. Stale or unreadable freshness stops content writes. Ambiguous
acquisition is reported without guessing ownership; failed cleanup cannot
return save success or hide an earlier partial-write error.

## Skipped update review and impact analysis

`src/skipped-updates.js` owns instance-wide unresolved skipped-finding discovery,
read-only reviews, exact selected batch previews and per-finding verified outcomes.
A finding is a `sys_upgrade_history_log` row, not the customized artifact itself.
A **confirmed batch** binds the effective instance, selected IDs, explicit action,
evidence and snapshots to a SHA-256 token, or receives one interactive confirmation
only after the exact preview. Recommendations never choose or dispatch actions.

`src/impact-analysis.js` is a reusable pure module for current/base field comparison,
known dependency evidence and explicit unknown deeper effects. Provider adaptation
lives in `src/skipped-update-provider.js`, exposed through the SDK. A **revert** uses
the observed provider version lifecycle, never a generic resolution-field update.
Dispatch is not success; log and artifact readback are required.

## Flow execution

`src/flow-context.js` owns the `sys_flow_context` measurement shape. `normalizeFlowContext` resolves instance-specific runtime fields and reports `field_mapping` plus `missing_fields`; `sys_created_on` may describe context age, but it is not used as execution age or for derived runtime duration when the real start field is absent. `summarizeFlowContexts` provides local sample metrics, while summary commands may combine them with server-side Stats API counts.

---

## Release channel

The installed package version determines the npm update channel: versions with
`-dev.` use the `dev` dist-tag; stable versions use `latest`. Both the daily
notification and `version --check` query that channel and offer its install
command. Daily checks are throttled separately per channel. Updates require an
explicit npm install; JSN does not replace itself.

Each channel supports its current release plus its two previous releases, ordered
by version. Stable and dev windows are independent. Publishing advances the
channel's dist-tag through OIDC without deprecating older versions or requiring
an npm access-token secret. Older versions remain available outside the support
window. Deprecation is an optional, separately authenticated maintenance action;
existing deprecations are preserved and no package versions are unpublished.

## Store application lifecycle

`src/store.js` owns ServiceNow Store discovery, inspection and the explicit
install/update lifecycle; `src/commands/store.js` keeps only argv and output
adaptation. Discovery (`list`, `search`) and inspection (`show`, `status`) are
read-only; `install` and `update` are declared mutations. The App Client search
endpoint is POST-shaped but performs no mutation.

A Store application is identified by a `sys_store_app` sys_id, an exact scope or
an exact name. Company application-repository applications (`sys_app`) are a
different source and are refused, never treated as Store apps. Version lists,
entitlement/licensing flags, dependencies and compatibility data are reported as
the platform supplies them; jsn never infers purchase authorization or accepts
commercial terms.

The App Client's **list** payload is not its **detail** payload. A list row
carries `version` (only for installed applications), `update_available` and a
JSON-encoded `indicators` array — not `isInstalled`, `can_install_or_upgrade`,
`price_type` or `isAppstorePlugin`. Reading detail spellings off a list row
reports every installed application as not installed. A **blocked** application
is one the platform refuses on this instance (`block_install`, or an `indicators`
entry of type `error` such as `not_available_for_instance_type`); it can still
report `can_install_or_upgrade=true`, so the block flags are checked before any
lifecycle request.

A submitted lifecycle request returns an asynchronous tracker id, and submission
is not a completed installation. A tracker's terminal success is still verified
by reading the installed version back from `sys_store_app`: a mismatch is a
failure, and an unreadable record is reported as unverified rather than
successful. An expired wait keeps the tracker id without cancelling or
resubmitting, and a submission without a tracker id is an error that is never
retried. Discovery and inspection are verified against a live instance. The lifecycle
requests were dispatched there too — every one accepted, every one killed by the
instance's own 403 on the App Repository download — so the request shape is
proven and completion is not. They ship because that contract is the one the
published OpenAPI and the reference implementation both use.

The list endpoint is `POST /api/sn_appclient/appmanager/apps` — `GET` returns
405 — and `store`'s positional is named `application`, never `app`, because
`cli.js` attaches the command's App context as `argv.app` on every command and
would overwrite it.

## Invariants (things that must stay true)

- **Mutations are declared, not listed.** Adding a mutating subcommand means
  declaring `mutationSubcommands` on its Command — the guard derives from it.
  If you hand-maintain a parallel list, you've reintroduced the bug farm.
- **The interface is the test surface.** Commands and tests cross the same
  seam. Don't test past a module's interface — reshape the module instead.
- **Domain rendering lives with the domain.** `output.js` stays generic; a
  Command that needs a bespoke styled view ships `_formatted`.
- **One canonical map per domain concept.** e.g. `item_option_new` types live
  in `ITEM_OPTION_TYPE_NAMES` / `resolveItemOptionType` (helpers.js). A second
  inline copy is a bug.
- **One owner per command token.** Registration (`CommandNode.register`) leaves
  exactly one command answering to any name or alias: a re-registration replaces
  the slot, a shared alias goes to the later registration, a canonical name that
  was another command's alias replaces it, and a self-alias is dropped at the
  node. Anything else makes dispatch order, help, completion and the registry
  disagree about which command a token runs.
- **Every handler and the parent-discovery callback go through `wrap()`.** The
  discovery fallback runs outside any command, but its `app.ok` can still throw
  (a missing `--get` path does), and an unwrapped rejection exits through a Node
  stack instead of the structured error contract.

## Website account and feature recording

A website account is a SQLite-backed identity for the Rails documentation site,
independent of CLI profiles and ServiceNow credentials. Site administrators are provisioned from a terminal; public signup is disabled. Browser sessions expire and can be revoked on logout.
A feature recording is an administrator-published HTTPS video/watch URL associated
with an existing feature slug. Documentation and feature pages remain public.

## Hosted documentation index

A server-owned SQLite FTS5 database, built from the public documentation Git
mirror using JSN's existing ingestion/refresh functions. Public browser and REST
readers share the published file. Daily sync stages changes and atomically swaps
in a validated index; a failed sync never replaces the live file. Its Git source
revision scopes numeric document IDs; paths provide stable references. Site
administrators are provisioned locally; there is no public account registration.

## Documentation source and shared service

`jsn docs "query"` searches and `jsn docs --path <path>` reads through the public
HTTP API, independently of ServiceNow profiles and credentials. Hosted mode is
the default and creates no local database. Installation-wide setup preferences
can instead select a JSN-managed local service or a custom service base URL.
`JSN_DOCS_URL` overrides that selection. Local and hosted readers reuse the same
Node SQLite query and summary implementation; the Rails website is an adapter.
The server owns Git synchronization, daily refresh and atomic publication.
IDs may be pinned with `--revision`; exact paths identify documents across revisions.
Legacy search/show/status spellings remain callable but hidden from normal help.

## Defaults for future connections

Installation-wide `connection_defaults` contain read-only, delete confirmation
and result-total preferences. New connections copy these values after one
confirmation or customization step. Existing profiles preserve their explicit
settings and historical defaults for omitted fields. Editing global preferences
does not rewrite existing profiles. Documentation source is also installation-wide,
not a per-instance setting; project-local configuration cannot override either.
## Auth implementation modules

`src/auth.js` preserves the public auth API and identity-aware `AuthManager`.
Credential storage, OAuth/PKCE helpers, browser-session input parsing and pure
credential-state classification live under `src/auth/`. This separation does
not change credential keys, environment precedence or probe side effects.

## Customization interpretation

`interpretation` is derived guidance shared by customization help, JSON/text
review and comparison, and offline HTML reports. It explains evidence meaning,
coverage limits and safe next steps without changing captured evidence or the
stored capture schema. Older captures receive the same guidance when viewed;
no report migration is required. Per-artifact `triage` remains the classification
and confidence assessment, separate from unverified runtime/reversion risk.

### Supplementary related-list observations

A **related-list count** is an opt-in aggregate observation attached as `_related`
to a specialized show result. It is distinct from eager essential-child data.
Safe reference metadata and AND-only literal filters bind each aggregate query
to the resolved parent record. Only actual aggregate zero means zero; denied,
unserviced, malformed, unknown and capped descriptors retain unavailable counts
and partial coverage. Counts are scoped to Aggregate API permissions. Nonempty
lists suggest exact, connection-pinned commands rather than fetching related
records. Descriptor fanout defaults to 50, individual reads use at most four
concurrent calls, and caches are SDK/invocation-bound. Generic get is unchanged.

### Optional batch reads

A **batch read** is an explicit `SDKClient.batch` operation over independent,
same-instance GET subrequests. The native Batch API envelope is correlated by ID;
per-item failures, unserviced IDs, and missing responses stay distinct. Only an
explicitly unsupported outer endpoint permits sequential read fallback. Normal
SDK methods stay unbatched, writes are rejected before dispatch, and authentication
or ACL errors never silently trigger fallback. See `docs/sdk-batch.md`.

## Local mutation history

Table API creates, updates and deletes invoked by the CLI record one final local
history event after authentication retries finish. The seven-day SQLite store is
independent of documentation indexes. Events contain instance origin, profile,
table, resolved record ID, operation, outcome and an optional non-sensitive
reason; request/response bodies and credentials are never serialized. A definitive
HTTP rejection is failed; an uncertain transport outcome is unknown. Local storage
failure warns without changing the remote operation's result. This convenience
history is not a durable ServiceNow audit log. Human output uses local time and
a compact table; `--details` expands identifiers and reasons. Structured output
retains full IDs, instance origins and ISO timestamps. Fixture test runs use a
disposable history store instead of the developer's store.

### Mutation capture-context approval

A **capture-context guard** resolves the selected application and update set before
an instance mutation, independently of output headers and delete-confirmation
preferences. Confirmed Global scope plus the exact Default update-set name requires
explicit approval; `--force` records approval for that invocation. A missing scope
preference or failed lookup is unknown context, never evidence of Global scope.
Scope mismatches are warnings with a concrete selection command; selected completed
capture sets are errors. Success JSON carries `context.mutation`; blocked commands
carry `context` with stable diagnostic codes, severity, remediation, and approval
state. Ordinary creates/updates in other contexts need no confirmation.

Capabilities declare remediation exemptions (`mutationContextExemptSubcommands`)
and read methods (`mutationContextReadMethods`) separately from mutation paths.
Creating/selecting an application or update set remains possible to resolve unsafe
context. REST GET bypasses capture-context approval but remains blocked on read-only
profiles, along with every other raw REST request.

## Documentation snapshot

A documentation snapshot is an immutable compressed SQLite FTS5 index, built once
from a recorded source revision with the existing ingestion code. Its manifest
identifies format/schema compatibility, source revision, sizes, checksum and an
artifact-storage URL. A lightweight Rails service records build/publication state
and exposes the last good manifest; the CLI downloads artifact bytes directly
from storage. Documentation remains optional, independently installed from local
mutation-history storage. Snapshot installation uses cooperative local reader and
installer leases and validates the staged database before replacing the index.
Local search remains available offline; freshness work cannot delay it.

### Capture context

A capture context is the update set a provider write actually lands in, and it is
not the same thing as the persisted `sys_user_preference` row (`name=sys_update_set`)
that `jsn` reports. The provider captures into the authenticated session's effective
picker selection (`/api/now/ui/concoursepicker/updateset`), which a fresh CLI
invocation has to re-establish. Flow create/update therefore return
`capture_context` (`intended`, `effective`, `aligned`, `action`) after reconciling
the two before any content write, and refuse the write when a readable mismatch
cannot be aligned. `update_set_capture.status: "missing"` additionally carries
`elsewhere.update_sets` and a `diagnosis` when matching `sys_update_xml` rows exist
in a different set; nothing is moved automatically.

### Retrieved update-set XML

A retrieved update set (`sys_remote_update_set`) is an inert promotion artifact,
separate from the current local capture set (`sys_update_set`). `updatesets import`
loads a validated XML export through the native upload processor, verifies its
member identities/actions, and leaves it loaded and uncommitted. It never changes
the current capture context or completes a set. Its declared `--dry-run` preview
is local only, including on read-only profiles. XML member summaries and the
separate payload-operation summary distinguish captured updates from subsidiary
operations that would run on a later platform commit. `platform_default` means
that a payload record omitted an explicit action; inspection does not infer it.
Reopening is an explicit local state change, independent of selection or export.

## Managed agent skill copies

The packaged ServiceNow skill is the source for `skill show`, `fetch`, `check`
and `install`. Installation records all selected file locations; the legacy
`skillLocation` points to the first. A plain reinstall replaces that recorded set.
Explicit destinations select a new managed set. Freshness means identical file
contents, including edits that leave the frontmatter version unchanged.
## Instance Scan

`jsn scan` separates check definitions (`checks`), groups of checks (`suites`),
explicit targets (`run`), execution progress (`status`), and findings/coverage
(`results`). Activation changes eligibility without starting an execution.
Provider execution success is separate from findings and recorded check counts;
unreadable or truncated coverage must never become a clean zero. Scan dispatch
is not automatically retried, and an expired local wait does not cancel the
provider's execution. Instance-wide runs require explicit `--full`, including
when reusing a previous instance-wide target.

## Retrieved update set promotion

`import` loads an exported XML file as a retrieved update set
(`sys_remote_update_set`) and stops there. `preview`, `problems`, and `commit`
are the platform's own later steps, driven through the CICD Update Set API with
its progress tracker; retrieval never converts the set to a local set or changes
its state. Preview problems (`sys_update_preview_problem`, keyed by
`remote_update_set`) are decisions for a human: jsn reports them read-only, never
accepts or skips one, and refuses to commit while any is unresolved. Preview and
commit verify `previewed`/`committed` by readback and report an unverified result
as an error. Neither selects an update set or changes scope, and the proposed
`--name`/`--local`/`--state` import modifiers are refused rather than silently
approximated.

## Configured domain and browser-session domain

`session.domain` is the selected profile's configured `X-Now-Domain` header;
it is not a snapshot of the platform's actual session domain. `domains current`
reports configuration. Explicit `domains session-*` commands read or change the
server-side domain using saved browser-session credentials. These requests omit
the configured header without mutating SDK or profile state. Picker results are
paged and limited by the actual session domain. Resetting to global is an
explicit mutation, never an implicit prerequisite to listing or selecting.
Session changes require readback verification and may affect a shared browser.
