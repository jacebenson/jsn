# ADR-0001: Architecture-deepening program — declared capabilities, record resolver, typed output shapes

- **Status:** Accepted (Wave 1 merged: PRs #185–#188). Session resolver in progress (Wave 2).
- **Date:** 2026-08-21
- **Deciders:** Jace, Holly (with parallel explorer/implementer subagents)

## Context

A three-zone architecture scan (hot-spot analysis of 200 commits, then parallel
explorers over CLI-wiring, command-factories, and I/O/auth/docs) found the
codebase's friction concentrated in **shallow, hand-maintained mirror data** —
lists that re-stated facts the command modules already knew, in places far from
where those facts live. The drift wasn't hypothetical; it had already produced
live bugs.

## The bugs that forced the decision

1. **Read-only bypass.** `src/mutations.js` registered `['catalog','create-item']`,
   but the real command is `catalogitems create`. On a read-only profile,
   `jsn catalogitems create` bypassed the mutation guard entirely. A hand-maintained
   path list had drifted from the command tree it mirrored.
2. **Divergent record lookups.** ~12 inline "resolve one record by identifier"
   copies across `_ticket.js`, `users.js`, `tickets.js`, `_generic.js`,
   `catalog.js` — and `users.js`'s delete lookup forgot `sysparm_display_value=all`.
3. **Wrong variable types.** `catalog.js` had an inline `item_option_new` type map
   (`select:'3'`, `date:'4'`, `checkbox:'12'`…) contradicting the canonical
   `ITEM_OPTION_TYPE_NAMES` in `helpers.js` (`select:5`, `date:9`, `checkbox:7`).
   Five of its values were wrong (`3` = Multiple Choice, `4` = Numeric Scale,
   `12` = Break).
4. **Dead/duplicate registrations.** `restmethods` guarded a command that was never
   registered; `uipoliciesCmd` was defined twice (the re-export silently won).
5. **Domain knowledge in the generic formatter.** `output.js` hardcoded
   `auth status` profile rendering (lock icons, badges); 15 commands bypassed the
   formatter via an undocumented `_formatted` magic key.

## Decision

Deepen, don't layer. Each fix moves a fact to the module that actually owns it,
behind a small interface:

- **Capability registry** (`src/capabilities.js`) — Commands declare
  `mutationSubcommands` / `noInstance` / `skipDailyChecks` / `devAlias` once at
  the definition site; factories emit declarations from flags they already take
  (`readOnly`). Middleware **derives** skip-lists and mutation paths from the
  registry. `mutations.js` keeps `isMutationCommand(argv)` as the public face;
  its data is generated at `buildCLI()` time, never hand-maintained.
- **Record resolver** (`src/resolve-record.js`) — one module owns "identifier →
  record": classification, safe-match, display-value params, unwrap. Commands do
  resolve → mutate → report.
- **Catalog split** (`src/commands/catalog/enrich.js`) — enrichment is a deep
  pure-async module; one canonical type map (`resolveItemOptionType`).
- **Typed output shapes** — `output.js` stops knowing about auth profiles; the
  `_formatted` / shape keys become the declared side-channel interface. `auth
  status` renders its own badges into `_formatted`.
- **Unified error renderer** (`src/errors.js` `renderAppError`/`exitWithError`) —
  one module owns AppError → (stream, text, exit code); `wrap()` and `guardExit`
  route through it. The `usage`/`usage_error` literal split is consolidated.

## Consequences

**Positive**
- Adding a command touches its own file; the safety model derives from it.
  The AGENTS.md "add to every skip-list" warning deletes itself.
- Query-construction and type-map bugs have one home; the interface is the test
  surface (resolver + registry are unit-testable without spawning the CLI).

**Negative / costs**
- `declareCapabilities` calls sit at module top-level and run at registration —
  the registry is complete only after `buildCLI()` returns. Fine for a CLI, but
  worth knowing before importing command modules in isolation.
- The `_formatted` escape hatch is now *documented* but still a stringly-typed
  seam; a richer typed-shape system was deliberately deferred (see below).

## Rejected / deferred alternatives (don't re-litigate without new friction)

- **Hand-maintained skip-lists + a separate mutation registry** — the status quo
  ante. Rejected: produced the read-only bypass and dead entries. This is the
  load-bearing rejection a future review must not undo.
- **Full typed-shape redesign of `output.js`** (dispatch on declared payload
  types, removing all duck-typing) — deferred: touches every command's output
  path for marginal gain over documenting the existing `_formatted`/shape keys.
  Reopen only if shape-sniffing (`detectRecord`) causes a real bug.
- **`detectRecord` / col-width table removal** — deferred: col-widths are now
  overridable via `data.columnWidths`; full removal is tidiness, not depth.
- **help.js table derivation from the registry** — deferred: the grouped/divider
  help layout doesn't map cleanly onto the flat capability registry.
- **sdk.js split** (860 LOC: transport + attachments + scripts + impersonation) —
  deferred; the transport half is deep and healthy. Reopen as its own effort.
