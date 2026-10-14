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
after the user performs the manual Validate trust operation. Windows currently
uses a foreground console and does not register a system service.

## Customization capture

A private local schema-versioned JSON report produced by bounded GET-only reads
of application metadata, scopes and upgrade history. Historical OOTB evidence,
caller-declared customer scope artifacts and unclassified metadata stay separate.
An upgrade skip is evidence of a past preserved customization, not a trusted
current OOTB baseline. The upgrade-history read is filtered server-side to the
preserved-customization dispositions, so a bounded budget reaches the evidence
and unmatched counts describe that filtered population. Non-global scope is never
ownership evidence. Coverage never infers exhaustion from a short page: it
compares the rows fetched with the Stats API count for the same query, reports
both, and reports `exhausted` only when the fetched rows account for the available
total. An unavailable count is reported as unknown. A 2xx table body without a
`result` array is a malformed envelope and makes that source unavailable, never
empty; comparing a report that has an unavailable or empty source yields
`unreliable` status so missing coverage is never read as mass creation/deletion.
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

## Capability registry

`src/capabilities.js`. The single source of truth for command metadata the
middleware cares about. Each Command declares its capabilities once at the
definition site via `declareCapabilities(name, caps)`; factories emit the
declaration automatically (e.g. `buildDevCmd`'s existing `readOnly` flag).

The middleware **derives** the skip-lists (instance guard, daily checks,
context header) and the mutation-guard path list from this registry — it never
matches `argv._[0]` against hand-written string lists.

Capabilities: `mutationSubcommands`, `noInstance`, `skipDailyChecks`.

> Replaced: hand-maintained skip-lists in `cli.js` plus the hand-written
> mutation registry in `mutations.js`.

## Record resolver

`src/resolve-record.js`. One deep module that turns a human identifier into a
record. `resolveRecord(sdk, { table, identifier, matchField, resource })` → the
record (with display values) or a standard `not_found` error; `resolveSysId`
returns just the id; `isSysId` / `unwrapSysId` are the primitives.

Behind the interface: identifier classification (32-char hex → `sys_id`, else
the table's human field like `number`/`name`/`user_name`), safe-exact-match
assertion, `sysparm_display_value=all`, single-record extraction, sys_id
unwrapping. Commands do "resolve → mutate → report."

> Replaced: ~12 divergent hand-rolled "query by identifier, throw if empty"
> copies across `_ticket.js`, `users.js`, `tickets.js`, `_generic.js`,
> `catalog.js`.

## Session

The composite answer to "which instance am I talking to, as whom, with what
credentials and flags?" — effective instance URL, active profile (name +
`read_only`/`skip_confirmations` flags), username for credential keying.

`src/session.js` owns session resolution and application. Commands can select
an instance or profile without mutating the saved active profile.

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

## Catalog item enrichment

`src/commands/catalog/enrich.js`. `enrichCatalogItem({ sdk, instanceUrl,
sysID })` → an enriched catalog item: variables fetched and grouped by variable
set, flow/workflow/delivery-plan names resolved. Pure async data-shaping —
no yargs, no output formatting. `catalog.js` keeps wiring, create/submit, list.

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

## Flow execution

`src/flow-context.js` owns the `sys_flow_context` measurement shape. `normalizeFlowContext` resolves instance-specific runtime fields and reports `field_mapping` plus `missing_fields`; `sys_created_on` may describe context age, but it is not used as execution age or for derived runtime duration when the real start field is absent. `summarizeFlowContexts` provides local sample metrics, while summary commands may combine them with server-side Stats API counts.

---

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
