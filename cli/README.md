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
jsn columns show incident.priority    # dictionary entry and its choices, inherited from task
jsn docs "GlideRecord" --limit 5
jsn --help
```

Instance reads use your selected profile; add `--profile <name>` to choose another. Documentation search uses the hosted service by default and needs no ServiceNow connection; with a profile selected and no release named, it reads the instance's release to choose the documentation family. Use `jsn <command> --help` for options or `jsn --all-commands --help` for the full reference.

## Why a user holds a role

```sh
jsn users roles <user> --profile <name>
jsn users roles <user> --why --role <role>
jsn users roles <user> --why --json
```

`users roles` lists the user's `sys_user_has_role` rows, joined on raw sys_ids
(`--limit` 1–1000, default 100, with `pagination.has_more`). Row ACLs can hide
rows, so an empty list does not prove the user lacks a role. `--why` asks the
platform's User Role Inheritance API, which needs `user_admin`, for every path
to each role: a direct grant, a chain of contained roles, or a group. Groups
appear by the name the platform prints; the API returns no sys_ids. A missing,
denied or malformed reply is an error, never an empty answer.

## Record version history

```sh
jsn records versions sys_script_include <sys_id>
jsn records versions sys_script_include MyUtil --identifier-field name --diff 2
jsn records versions sys_script <sys_id> --get data.latest_update.update_set.value
```

Lists a record's `sys_update_version` history newest first (1 is the newest),
and the newest `sys_update_xml` capture with its update set. `--diff N` compares
version N to the current version on raw values, line by line for scripts. Current
means the version in state current, as the platform's Compare to Current uses; the
live record is not read. Read-only. No versions does not mean unchanged: only
records tracked by update sets have them.

```sh
jsn records revert sys_script_include MyUtil --identifier-field name
jsn records revert sys_script_include <sys_id> --version <sys_update_version sys_id>
```

`records revert` puts a record back to its base system version (the newest
upgrade or Store app version), or with `--version` to any earlier version. It
runs the platform's Revert to this version in a background script after a
confirmation that names the fields it changes, then reads back the new current
version and the live record. Records created on the instance have no base.

## Saved Access Analyzer evidence

```sh
jsn access-analyzer list --limit 20 --profile <name>
jsn access-analyzer show <request-id> --json
jsn access-analyzer show <result-id> --format styled
jsn access-analyzer show <request-id> --get data.request.user.value
jsn access-analyzer check --user abel.tuter --table incident --record <sys_id>
```

`list` and `show` read saved `sn_access_analyzer_request`,
`sn_access_analyzer_access_result`, and `sn_access_analyzer_debug_log` records.
They never evaluate access or save an analysis. The Access Analyzer application
and read permissions on its tables are required; denied or unavailable table
reads fail rather than appearing as empty evidence. ACL-filtered empty reads
cannot prove access or absence of saved data.

IDs must be exact 32-character hexadecimal sys_ids. Each command supports
`--limit` (1–200) and `--offset` (default 0). JSON includes `pagination.has_more`
and `next_offset` from one-row lookahead, not a total count. `show` preserves
per-operation execution IDs; these are not shared run IDs and do not imply
that outcomes belong to the request's last run. `show` takes either id: a request prints one line per operation, an operation result prints its checks ordered by log sequence then sys_id, and the JSON `kind` says which was found. A sys_id is unique per table, not across tables, so a request wins if an id exists in both.

`check` evaluates access live and saves no analysis. It runs the Access Analyzer's
own evaluation as a background script without a rollback context (`--operations`,
default `read,write,delete`),
lists the active before-query business rules on the table, its parents and
`global` (the `b4rules` filter), and reads the record as `--user` through
`--impersonate`'s session. "Blocked by ACL" comes from the analyzer's ACL result
alone, since its overall decision also counts query rules; an ACL step it
skipped or left undefined is shown as undecided, never as allowed. When ACLs allow the
read but the read as the user returns nothing, it says a listed rule is the
likely cause. It needs a basic or OAuth profile that can run background scripts
and impersonate, and each run leaves an impersonation entry in the instance's logs.
Raw reference values and display labels are retained in JSON; joins use raw IDs.
Passed, Blocked, Skipped and Undefined remain distinct. A record-availability
failure with Business Rule evidence is not automatically an ACL failure.

## Outbound email notifications

```sh
jsn notifications list --query "collection=incident^active=true"
jsn notifications show "Incident opened and unassigned" --format styled
jsn notifications show <sys_id> --get data._delivery
jsn notifications why incident INC0010007 abel.tuter
jsn notifications preview "Incident Opened and Unassigned" incident INC0010007
```

`list`, `show` and `why` read `sysevent_email_action` and never render or send
email. `list` shows what sends each notification, who it targets, its weight
and the winning body; template bodies are read in one bounded batch. `show`
adds `_delivery`: what sends the notification (a record insert or update with
its condition, an event, or a flow) and which body is used. A template with a
body replaces the notification's own `message_html`; an empty template body
leaves it in play. Mail script names come from the body in use. A template
that cannot be read is reported `unavailable`, never as the notification's own
body, and plain-text notifications are `unsupported`.

`why <table> <number|sys_id> <user>` attributes the engine's own evidence for
one record: `notification_engine.process` events (parm1 is the notification),
event-named rows, linked `sys_email` rows, and `syslog_email` inclusion or
exclusion lines when that table is readable. It shows the user's active flag,
email, notification setting, devices and subscriptions, plus the instance
switches that decide whether an absent email means anything. When nothing was
logged it says so and shows the recipient configuration and the record's own
values in those fields; it never recomputes the platform's recipient rules.
Flow-triggered notifications are counted as not covered. A 403 on
`syslog_email` is rendered as unavailable, never as zero.

`preview <notification> <table> <number|sys_id>` calls the platform's
NotificationSimulator over `xmlhttp.do` the same way `jsn scan` calls
ScanAjaxProcessor. It is declared as a mutation because it runs mail scripts:
read-only profiles refuse it and it asks for confirmation (`--force` for
automation). It sends no email, and it reports `sys_email`, `sysevent` and
`syslog_email` counts before and after the call so a write would be visible.
Its answer contains no recipient rows and does not explain inclusion or
exclusion; use `why` for that.

## Find a REST API

```sh
jsn scrapi search attachment upload --method POST
jsn scrapi search change --namespace sn_chg_rest --json
jsn scrapi spec "Table API" > table-api.json
jsn scrapi spec "Attachment API" --yaml > attachment-api.yaml
```

`search` reads the catalogue the instance's REST API Explorer uses, out-of-the-box and scripted
APIs alike; every word must appear, in any case, in the API name, route or descriptions. Each row's
`route` is the path `jsn rest` takes. `--namespace` reads only that namespace, and an unknown one
is an error naming the nearest. `spec` prints the API's OpenAPI 3 document as the instance gives
it (`--json` wraps it in the envelope); a name several APIs match is refused with the candidates
and their namespaces. Both are reads and work on read-only profiles.

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

To run a command as another user, add `--impersonate <user_name or sys_id>`: `jsn records list --table incident --impersonate abel.tuter` shows what that user sees. It needs the admin or impersonator role and runs on a private session that is switched back and logged out afterwards. A record write as that user asks first in a terminal; elsewhere it runs only with `--impersonate-writes`, once your user has approved it, and the usual write guards still apply. Customization writes, `eval` and `rest` writes are refused under `--impersonate`.

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
