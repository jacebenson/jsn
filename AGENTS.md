# AGENTS.md — working on the jsn codebase

For AI agents (and humans) **building jsn itself**. If you want to *use* jsn
against a ServiceNow instance, see the bundled skill (`jsn skill show`,
source in `skills/`) or README.md.

## Stack

Node.js (see `engines` in package.json for the floor), ESM (`"type": "module"`),
no build step, no TypeScript. Entry: `bin/jsn.js` → `src/cli.js`.

Runtime deps — keep this list short, every addition needs a reason:

| Package | Why it's here |
|---------|---------------|
| `yargs` | CLI framework — commands, options, help, shell completion |
| `@inquirer/prompts` + `@inquirer/core` | Interactive pickers (TTY list views, setup wizard) |
| `better-sqlite3` | `jsn docs` search index — native module, needs build tools on git installs (node:sqlite lacks FTS5 on some platforms) |
| `gray-matter` | Frontmatter parsing for docs markdown |
| `turndown` | HTML → markdown for docs ingestion |

Tests: `node:test` runner + eslint.

## Layout

- `bin/jsn.js` — entry, patches out node:sqlite experimental warning, calls `cli.parse()`
- `src/cli.js` — `buildCLI()`: global options, middleware, command registration
- `src/app.js` — `App`: instance resolution, SDK handle, output controller
- `src/config.js` — profile config (XDG config dir)
- `src/commands/` — one file per command family; `_simple.js` builds the
  many simple table CRUD commands, `commands/_ticket.js` builds ticket-style
  CRUD (incidents/changes/requests/tasks)
- `src/helpers.js`, `src/output.js`, `src/errors.js`, `src/mutations.js`
- `skills/` — the agent skill shipped in the npm package
- `test/` — `*.test.js`, `node:test` + `spawnSync` for CLI-level tests

## Domain vocabulary & decisions

- `CONTEXT.md` — the domain model (command, capability registry, record
  resolver, session, output envelope, …) and the invariants that must stay
  true. Update it in the same commit that changes a concept.
- `docs/adr/` — architecture decision records (ADR-0001 covers the
  capability-registry / record-resolver / output-shapes deepening). Don't
  re-litigate a rejected alternative without new friction.

## Adding a command

1. Create `src/commands/<name>.js` exporting `export const <name>Cmd = (wrap) => ({...yargs command module})`.
2. Register in `src/cli.js` with `.command(<name>Cmd(wrap))` — keep the
   section grouping. Aliases go on the command module.
3. All handlers must go through `wrap(handler)` — it injects `app` and
   converts thrown errors (`err.code`) into clean exits with hints.
4. Simple table CRUD? Don't hand-roll: extend `_simple.js` or use
   `buildTicketCommands` (`_ticket.js`).

## Rules that will bite you

- **Command capabilities are declared, not listed.** `src/capabilities.js`
  (`declareCapabilities`) is the source of truth for `noInstance` /
  `skipDailyChecks` / `mutationSubcommands`. Middleware derives
  the skip-lists and the mutation guard from it — never add a command name to
  a hand-written string list. Factories (`buildDevCmd`, `buildTicketCommands`)
  declare automatically from flags like `readOnly`.
- **strictCommands() is on.** This breaks yargs' default shell-completion
  handler — see the custom filter in `cli.js` and the comment there before
  touching `.completion()`.
- **Mutations are guarded.** `src/mutations.js` (`isMutationCommand`) drives
  the require-instance + read-only-profile + confirmation flow, with its path
  list derived from the capability registry. Declare a mutation via
  `mutationSubcommands` on the command — never edit a path list by hand.
- **`.fail()` is custom.** The "You must specify a command" path prints
  `renderHelp()` and exits 0; lone `--profile` prints the profile list.
- **Output envelope.** Everything goes through `app.output` (formats: auto,
  json, markdown, styled, quiet, csv). Never `console.log` data — write to
  stdout via the output controller so `--json`/`--get` keep working.
- **`--get`** is jsn's jq substitute (JSON path into the envelope) — keep it
  working for new output shapes.

## Testing

```bash
npm test                    # full suite (node --test, no instance needed)
npm run lint                # eslint src/ bin/ test/
JSN_INTEGRATION_TESTS=true npm test   # live-instance e2e (creates/deletes records!)
```

Test env vars: `JSN_NO_VERSION_CHECK=1`, `JSN_NO_SKILL_CHECK=1` (disable the
daily checks — set these in tests), `JSN_HERMES_BASE_DIR` (skill tests).
CLI-level tests spawn `bin/jsn.js` via `spawnSync` — see
`test/completion.test.js` for the pattern.

## Git flow

PRs against `main` on github.com/jacebenson/jsn, squash-merged
(`gh pr merge --squash`). Jace tests merged main; don't push release tags.
