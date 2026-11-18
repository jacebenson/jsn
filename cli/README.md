# JSN: ServiceNow CLI

Read ServiceNow records, inspect platform metadata, search documentation, and make explicit changes from your terminal or AI agent.

[npm](https://www.npmjs.com/package/@jacebenson/jsn) · [GitHub](https://github.com/jacebenson/jsn) · [JSN docs](https://jsn.jace.pro/docs/install/)

## Install and connect

Use the current [Node.js LTS release](https://nodejs.org/en/about/previous-releases) and npm on macOS, Linux, or Windows. Older Node.js release lines are not supported.

```sh
npm install -g @jacebenson/jsn
jsn setup
```

Setup connects a named profile to your instance. Its default preset allows writes, so enable read-only mode before exploring. See [setup and authentication](https://jsn.jace.pro/docs/setup/).

For unreleased changes, use `npm install -g @jacebenson/jsn@dev`; see [channels and updates](https://github.com/jacebenson/jsn/blob/main/docs/releases.md).

## Read and discover

```sh
jsn records list --table incident --query "active=true" --limit 5 --json
jsn discover --table incident
jsn docs "GlideRecord" --limit 5
jsn --help
```

Instance reads use your selected profile; add `--profile <name>` to choose another. Documentation search needs no ServiceNow connection and uses the hosted service by default. Use `jsn <command> --help` for options or `jsn --all-commands --help` for the full reference.

## Choose output

Use the default terminal view for people, `--csv` or `--tsv` for flat rows, and `--json` when scripts need pagination, context, or errors. CSV/TSV do not fetch more pages or preserve both reference IDs and labels. Pagination notices go to stderr only when more results are explicitly known; silence does not prove completeness. JSON retains reference objects only if the command has not already flattened them. See [output details](https://jsn.jace.pro/docs/output/).

## Work safely

Use `jsn auth modify <profile> --read-only` to block instance writes. ServiceNow roles and ACLs still decide what you can access. Help and discovery may show a compact command list for the connected account; this is not an access grant or an exhaustive capability check.

Writes are not universally dry-run operations or confirmation prompts. Inspect each command's help, target profile, scope, and update set before changing anything. Use `--force` only for an approved operation. See [safety guidance](https://jsn.jace.pro/docs/safety/).

## AI agents

Inspect the bundled skill with `jsn skill show`, then use `jsn skill install` to select your agent or `jsn skill install --target hermes` for Hermes. Reinstall after upgrading JSN; reinstalling replaces recorded copies, including local edits. See [agent installation](https://jsn.jace.pro/docs/agents/).

## Local prompt experiment

From the repository root, run `node cli/scripts/prompt-demo.mjs` in a terminal.
It uses synthetic servers only. Nothing connects to ServiceNow or changes profiles.
Type to filter, use arrows to move and Enter to select. Down past the last loaded
server fetches another page. Escape cancels. Ctrl+C or Ctrl+D exits the prompt.
The forms menu includes masked input, confirmation and a checklist. The editor
menu uses your `$VISUAL` or `$EDITOR`, falling back to `vi`.

From `cli/`, `npm ci` installs lint and test dependencies without Inquirer.
Run `npm run test:pty` for the Linux Python 3 PTY checks. `npm test` also collects
them. Mutation tooling is not part of normal installs. `npm run test:mutation`
fetches pinned Stryker 10.1.1 on demand and uses `stryker.config.json`, retaining
the offline mutation-safety tests. Its execution is separate from normal tests.

## Go deeper

- [CLI guide and feature workflows](https://jsn.jace.pro/docs/cli-guide/)
- [Documentation search and local hosting](https://jsn.jace.pro/docs/install/)
- [Feature library](https://jsn.jace.pro/#features)
- [Development and contributing](https://github.com/jacebenson/jsn#development-and-contributing)
- [MIT license](https://github.com/jacebenson/jsn/blob/main/LICENSE)
