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

For unreleased changes, use `npm install -g @jacebenson/jsn@dev`; see [channels and updates](https://github.com/jacebenson/jsn/blob/main/site/docs/maintainers/releases.md).

## Read and discover

```sh
jsn records list --table incident --query "active=true" --limit 5 --json
jsn discover --table incident
jsn docs "GlideRecord" --limit 5
jsn --help
```

Instance reads use your selected profile; add `--profile <name>` to choose another. Documentation search needs no ServiceNow connection and uses the hosted service by default. Use `jsn <command> --help` for options or `jsn --all-commands --help` for the full reference.

## Saved Access Analyzer evidence

```sh
jsn access-analyzer list --limit 20 --profile <name>
jsn access-analyzer show <request-id> --json
jsn access-analyzer explain <result-id> --format styled
jsn access-analyzer show <request-id> --get data.request.user.value
```

These commands read saved `sn_access_analyzer_request`,
`sn_access_analyzer_access_result`, and `sn_access_analyzer_debug_log` records.
They never evaluate access or save an analysis. The Access Analyzer application
and read permissions on its tables are required; denied or unavailable table
reads fail rather than appearing as empty evidence. ACL-filtered empty reads
cannot prove access or absence of saved data.

IDs must be exact 32-character hexadecimal sys_ids. Each command supports
`--limit` (1–200) and `--offset` (default 0). JSON includes `pagination.has_more`
and `next_offset` from one-row lookahead, not a total count. `show` preserves
per-operation execution IDs; these are not shared run IDs and do not imply
that outcomes belong to the request's last run. `explain` orders checks by log sequence then sys_id.
Raw reference values and display labels are retained in JSON; joins use raw IDs.
Passed, Blocked, Skipped and Undefined remain distinct. A record-availability
failure with Business Rule evidence is not automatically an ACL failure.

## Choose output

Use the default terminal view for people, `--csv` or `--tsv` for flat rows, and `--json` when scripts need pagination, context, or errors. CSV/TSV do not fetch more pages or preserve both reference IDs and labels. Pagination notices go to stderr only when more results are explicitly known; silence does not prove completeness. JSON retains reference objects only if the command has not already flattened them. See [output details](https://jsn.jace.pro/docs/output/).

## Slow patterns

```sh
jsn perf slow --limit 10
jsn perf slow --type scripts --order-by count --since 2026-11-01
jsn perf slow show <sys_id> --json
```

`perf slow` reads the platform's Slow Pattern logs (`sys_pattern` and its
subclasses for queries, scripts, transactions, events, mutexes and cache
builds), ranked by total time, run count or average time. `show` finds the
record's class itself and prints the full SQL and the stack trace that issued
it. Both are read-only Table API reads and need read access to those tables,
usually admin. `average` is in milliseconds and `total` is a duration; first
and last seen times are UTC, and `--since` compares with them in UTC.
`executable_sql` and `url` can hold literal values from live requests. An empty
or ACL-filtered list does not prove nothing is slow. `--limit` (1–200) and
`--offset` page the list; JSON has `pagination.has_more` from one-row lookahead.

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
