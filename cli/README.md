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

`jsn roles show <role>` also lists the roles that role directly contains, read
from `sys_user_role_contains` on the role's raw sys_id (first 100, with
`has_more`). Nested contains are not expanded; `--no-essential` skips the read.

## Why a user cannot sign in

```sh
jsn users access <user>
jsn users access <user> --limit 50 --json
jsn users access <user> --get data.sign_in
jsn users unlock <user>          # preview
jsn users unlock <user> --yes
```

`users access` reads the user's `active`, `locked_out`, `password_needs_reset`,
`failed_attempts`, `last_login_time`, `web_service_access_only` and
`internal_integration_user`, says which of them block sign-in, and lists the
newest `login.failed` events for the user name (`--limit` 1–100, default 10).
Event rows rotate out after a few days, and a locked-out user's attempts write
none, so an empty list proves nothing. A password reset on its own lets the UI
ask for a new password and refuses API calls. The password, SSO, MFA and IP
rules are not checked. Read-only.
## Grant a role directly

```sh
jsn userroles list --query "user.user_name=abel.tuter^inherited=false"
jsn userroles add --role itil --user abel.tuter,beth.anglin    # preview
jsn userroles add --role itil --user abel.tuter --yes
jsn userroles remove --role itil --user abel.tuter --expect-count 1 --yes
```

`add` creates one `sys_user_has_role` row per user and skips users who already
hold the role directly; a user who holds it only through a group still gets a
direct row. `remove` deletes only rows with `inherited=false`, so a role held
through a group or a containing role stays, and `--yes` needs the
`--expect-count` its preview printed. Both preview without `--yes`, take up to
100 users, read the rows back, and exit nonzero unless every change is there.

`users unlock` refuses a user who is not locked out. With `--yes` it sets
`locked_out` to false and `failed_attempts` to 0, reads the user back, and exits
nonzero unless both changed. It leaves `password_needs_reset` alone, since an
admin may have forced it, and then says what still blocks.
## Blocked cross-scope calls

```sh
jsn privileges requests                                  # requested, denied, invalidated
jsn privileges requests --target-scope x_acme_core --status all
jsn privileges requests --source-scope "Payroll Sync" --json
```

A call that Restricted Caller Access blocks files a `sys_restricted_caller_access`
row, which stays at Requested until the target application's admin allows it.
`privileges requests` lists those rows newest first, with the calling scope and
script, the target and the status (`--limit` 1–1000, default 20, with
`pagination.has_more`). They are separate from the `sys_scope_privilege` rows
that `privileges list` reads, so allowing a privilege leaves the request
blocked. Scopes match by scope, name or sys_id and filter on raw sys_ids.
ACLs can hide rows, so an empty list means no readable rows, not none.
## Which table holds a sys_id

```sh
jsn records find <sys_id>
jsn records find <sys_id> --get data.table
```

Tries `sys_metadata` and `task` through the Table API, then background scripts
of up to 20 seconds each query the base tables that have a sys_id field
(children included), skipping remote and virtual tables. `--max-tables` and `--time-limit` bound the
search; a limit reached is reported as not found within the bound, and a miss
exits 1. The scripts write no records of their own, but they run server-side code
as `jsn eval` does, so read-only profiles refuse `find` and it needs a user who
may run background scripts.

## Record version history

```sh
jsn records versions sys_script_include <sys_id>
jsn records versions sys_script_include MyUtil --identifier-field name --diff 2
jsn records versions sys_script <sys_id> --get data.latest_update.update_set_state.value
```

Lists a record's `sys_update_version` history newest first (1 is the newest),
and every `sys_update_xml` capture with its update set and that set's state,
newest first and bounded by `--limit`. `--diff N` compares
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

## Group membership

```sh
jsn groupmembers list --query "group.name=Service Desk"
jsn groupmembers add --group "Service Desk" --user abel.tuter,beth.anglin    # preview
jsn groupmembers add --group "Service Desk" --user abel.tuter --yes
jsn groupmembers remove --group "Service Desk" --user abel.tuter --expect-count 1 --yes
```

`add` creates one `sys_user_grmember` row per user and skips users already in
the group; `remove` deletes every row for the users, and `--yes` needs the
`--expect-count` its preview printed. Both match the group and users exactly,
preview without `--yes`, take up to 100 users, read the rows back, and exit
nonzero unless every change is there.
```sh
jsn customizations revert --scope sn_hr_core
jsn customizations revert --scope sn_hr_core --confirm <token>
```

`customizations revert` does the same for every customised file of a Store or
repository application, 100 files a run, after a preview and its token. Files
added on the instance are listed, never deleted.

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
```

These commands read `sysevent_email_action` and never render or send email.
`show` adds `_delivery`: what sends the notification (a record insert or update
with its condition, an event, or a flow) and which body is used. A template
with a body replaces the notification's own `message_html`; an empty template
body leaves it in play. Mail script names come from the body in use. A template
that cannot be read is reported `unavailable`, never as the notification's own
body, and plain-text notifications are `unsupported`.
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

## Fix scripts

```sh
jsn fixscripts list --query "nameLIKEimpact"
jsn fixscripts create -f name="Lower incident impact" -f script=@fix.js \
  --expect-scope global --expect-update-set "Data fixes"
jsn fixscripts show "Lower incident impact" --get data.script.value
jsn fixscripts run "Lower incident impact" \
  --expect-scope global --expect-update-set "Data fixes" --yes
```

A fix script (`sys_script_fix`) is a customization record, so `create`, `update`
and `delete` need `--expect-scope` and `--expect-update-set` from the task, as
other customization writes do, and the platform captures the record in that
update set. `-f script=@fix.js` reads the body from a file. Creating a fix
script does not run it; the platform runs one on its own only when an
application that holds it is installed or upgraded.

`run` previews unless `--yes`, then runs the stored script unchanged as a
background script in the fix script's own scope, which must be the intended
scope, with a rollback context when Record for rollback is ticked. It is the
`jsn eval` path: `--timeout` and Ctrl-C cancel it on the instance, and after a
run with a rollback context `jsn eval rollback <execution>` undoes it. It does
not start the platform's Run Fix Script worker, so no progress worker or fix
script log is written, and it ignores the record's Unloadable setting:
customizations the script writes are captured in the intended update set.
## Outbound REST calls

```sh
jsn restmessage logs "Payroll API"
jsn restmessage logs "Payroll API" --status 5xx --limit 50
jsn restmessage logs <sys_id> --endpoint /employees --json
```

`logs` reads `sys_outbound_http_log`, newest first. A log row names the script that made the call,
not the REST message, so calls are matched by URL: it starts with the host of one of the endpoints
of the message and its methods, and contains the directory of one of them, the path up to its last
`/` before any `${variable}`. A call that `setEndpoint()` sent to another host or directory is not
found, and an endpoint whose host is a variable is listed as not matched. Basic logging, the
default, records no headers. Credential headers and query values are redacted and bodies are never
read. It is a read and works on read-only profiles.

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
