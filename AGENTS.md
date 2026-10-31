# AGENTS.md — working on the jsn codebase

For AI agents (and humans) **building jsn itself**. If you want to *use* jsn
against a ServiceNow instance, see the bundled skill (`jsn skill show`,
source in `skills/`) or README.md.

## Stack

Current Node.js LTS (CI follows `lts/*`; no fixed minimum-version promise), ESM (`"type": "module"`),
no build step, no TypeScript. The npm package lives in `cli/`. Paths in the CLI layout below are relative to `cli/`.
Entry: `cli/bin/jsn.js` → `cli/src/cli.js`.

Runtime deps — keep this list short, every addition needs a reason:

| Package | Why it's here |
|---------|---------------|
| `src/cli-adapter.js` | Local yargs-compatible command API backed by Node's `node:util` argument parser |
| `@inquirer/prompts` + `@inquirer/core` | Interactive pickers (TTY list views, setup wizard) |
| `better-sqlite3` | `jsn docs` search index — native module, needs build tools on git installs (node:sqlite lacks FTS5 on some platforms) |
| `js-yaml` | YAML frontmatter parsing and serialization for docs markdown |
| `saxes` | Strict, entity-safe XML inspection before native update-set upload |
| `turndown` | HTML → markdown for docs ingestion |

The docs site is a separate npm project in `docs/`; its Eleventy dependency
belongs in `docs/package.json`, not this project.

Tests: `node:test` runner + eslint.

## Layout

- `bin/jsn.js` — entry, handles closed pipes, calls `cli.parse()`
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

- `GLOSSARY.md` — the domain model (command, capability registry, record
  resolver, session, output envelope, …) and the invariants that must stay
  true. Update it in the same commit that changes a concept.
- `docs/DECISIONS.md` — short records of durable architectural choices.

## Adding a command

1. Create `src/commands/<name>.js` exporting `export const <name>Cmd = (wrap) => ({...CLI adapter command module})`.
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
- **Strict command handling is on.** The local CLI adapter owns command
  parsing and completion — see the custom filter in `cli.js` and the comment
  there before touching `.completion()`.
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

### Writing and reviewing tests

Keep Node's built-in `node:test`. Choose the observable contract first: public
CLI/API results, output, error codes, persisted data, or side effects. Exercise it
at the lowest useful layer. Use CLI tests when parsing, middleware, permissions,
formatting, or confirmation is the boundary under test; do not repeat an SDK
assertion through a subprocess without a distinct contract.

Distinguish public contracts from deliberate architecture invariants and
incidental internals. A structural restriction needs a documented rationale in
`GLOSSARY.md` or `docs/DECISIONS.md`, linked from the test. Otherwise avoid private
method names, prototype layouts, source-regex checks, and forbidden implementation
patterns. A behavior-preserving refactor should not require restoring obsolete
internals just to satisfy a test.

Recipe for new tests or an audit:

1. Name the contract and the regression that would violate it.
2. Pick the lowest useful layer; inject credentials/transports rather than depend
   on personal keyrings, profiles, or a live instance.
3. Reuse a focused fixture or helper. Table cases should keep distinct inputs,
   expectations, and useful failure labels; fewer declarations alone are no win.
4. Include meaningful edge and failure paths, especially evidence that rejected
   operations made no write. Preserve auth, read-only, mutation confirmation,
   update-set, and write-back safeguards.
5. Run the affected tests, then `npm test` and `npm run lint`. Live tests remain
   explicit opt-in. Report existing failures honestly instead of weakening tests.

For cleanup, explain where each removed scenario remains covered, and report
actual test cases, test lines, and comparable runtime. Do not pursue a numeric
ceiling (including a 50-test goal), deletion percentage, or coverage quota.
See `docs/TEST_AUDIT.md` for the initial audit and upstream examples.

## Git flow

PRs against `main` on github.com/jacebenson/jsn, squash-merged
(`gh pr merge --squash`). Production releases run through the GitHub Actions
release workflow; don't push release tags manually.

Run dependency installation and package/release commands in `cli/` (`npm --prefix cli ci`). Root `npm test` and `npm run lint` forward to that package. Website deployment uses the repository root as Docker build context, with `site/Dockerfile`.
