# CONTEXT.md — jsn domain vocabulary

The names we use for the concepts in this codebase. When code, PRs, and docs
disagree with this file, the file wins until it's updated — update it in the
same commit that changes the concept.

This is the **domain model**: the named things and how they relate. For the
architecture vocabulary used to *reason about* the code (module, interface,
depth, seam, adapter, leverage, locality), see the `codebase-design` skill —
jsn uses those terms exactly.

---

## Command

A yargs command module — one file in `src/commands/`, exported as
`<name>Cmd = (wrap) => ({...})`. Everything the user types after `jsn` maps to
one. Commands are the unit the CLI registers, guards, and renders output for.

- **Factory-built command** — a Command produced by a builder rather than
  hand-written: `buildDevCmd` (`src/commands/dev/_generic.js`) covers most
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

Capabilities: `mutationSubcommands`, `devAlias`, `noInstance`,
`skipDailyChecks`.

> Replaced: hand-maintained skip-lists in `cli.js` + the hand-written mutation
> registry in `mutations.js` (see `docs/adr/0001-architecture-deepening.md`).

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

> **In progress** (Wave 2). Today this is assembled ad hoc across `app.js`
> (`_overrideInstance`, `getEffectiveInstance`), `cli.js` middleware, `auth.js`,
> and `config.js`. The session resolver consolidates it into one module. See
> ADR-0001.

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
  inline copy is a bug — the first one drifted 5 values wrong (see ADR-0001).
