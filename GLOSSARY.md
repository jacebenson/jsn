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
passed to the SDK as `opts.recovery`. Its `recover({ status, method, url })`
returns true only after replacing credentials. Its safe `error` supplies guidance
if the single retry is rejected. Only HTTP 401 from a non-bootstrap request may
recover and replay once; uncertain mutation outcomes never replay.

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
A preview never posts; unknown submission outcomes never cause automatic replay.
Inputs are catalog variables, not arbitrary fields on an RITM or request header.

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

## Flow inspection

`src/flow-inspection.js` is the single deep module for `flows show` and the
interactive flow picker. `inspectFlow({ adapter, identifier, instanceURL,
depth })` delegates remote flow/custom-action inspection through the narrow
adapter, then owns depth normalization, recursive subflow traversal, custom
action expansion, caches, cycle handling, nested failures, and `_formatted`
rendering. `src/commands/flows.js` only adapts yargs/App output to this seam.

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
by version. After publishing, versions outside that window are deprecated with an
update-before-reporting-issues notice. Stable and dev windows are independent;
existing deprecations are preserved and no package versions are unpublished.

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
