# AGENTS.md — working on the jsn codebase

For AI agents (and humans) **building jsn itself**. If you want to *use* jsn
against a ServiceNow instance, see the bundled skill (`jsn skill show`,
source in `skills/`) or README.md.

## Stack

Node.js 18+, ESM (`"type": "module"`), no build step, no TypeScript.
Entry: `bin/jsn.js` → `src/cli.js`. Key deps: yargs 17 (CLI), better-sqlite3
(docs search index). Tests: `node:test` runner, eslint.

## Layout

- `bin/jsn.js` — entry, patches out node:sqlite experimental warning, calls `cli.parse()`
- `src/cli.js` — `buildCLI()`: global options, middleware, command registration
- `src/app.js` — `App`: instance resolution, SDK handle, output controller
- `src/config.js` — profile config (XDG config dir)
- `src/commands/` — one file per command family; `dev/_simple.js` builds the
  many simple table CRUD commands, `commands/_ticket.js` builds ticket-style
  CRUD (incidents/changes/requests/tasks)
- `src/helpers.js`, `src/output.js`, `src/errors.js`, `src/mutations.js`
- `skills/` — the agent skill shipped in the npm package
- `test/` — `*.test.js`, `node:test` + `spawnSync` for CLI-level tests

## Adding a command

1. Create `src/commands/<name>.js` exporting `export const <name>Cmd = (wrap) => ({...yargs command module})`.
2. Register in `src/cli.js` with `.command(<name>Cmd(wrap))` — keep the
   section grouping. Aliases go on the command module.
3. All handlers must go through `wrap(handler)` — it injects `app` and
   converts thrown errors (`err.code`) into clean exits with hints.
4. Simple table CRUD? Don't hand-roll: extend `dev/_simple.js` or use
   `buildTicketCommands` (`_ticket.js`).

## Rules that will bite you

- **Middleware skip-lists.** `src/cli.js` has several lists like
  `['help', 'version', 'completion', 'setup', 'auth', 'skill', 'docs']` that
  skip instance guards / version checks / context headers. A new no-instance
  command must be added to every one of them.
- **strictCommands() is on.** This breaks yargs' default shell-completion
  handler — see the custom filter in `cli.js` and the comment there before
  touching `.completion()`.
- **Mutations are guarded.** `src/mutations.js` (`isMutationCommand`) drives
  the require-instance + read-only-profile + confirmation flow. New mutation
  subcommands must be registered there or they bypass the safety model.
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
