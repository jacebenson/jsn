# JSN — ServiceNow CLI

A command-line interface for ServiceNow. Type `jsn` and start working — no web UI needed.

Works standalone or with AI agents (Claude Code, OpenCode, Hermes, Cursor, Copilot).

## Install

```bash
npm install -g @jacebenson/jsn
```

Node.js 22.5.0 or newer. macOS, Linux, Windows.

The install also copies an AI agent skill file to `~/.agents/skills/servicenow/SKILL.md`.

### Install from GitHub (test unreleased builds)

To test a branch or the freshly merged `main` before it's published to npm:

```bash
npm install -g github:jacebenson/jsn#main        # merged but not yet tagged
npm install -g github:jacebenson/jsn#<branch>    # any PR/feature branch
```

Go back to the released version with:

```bash
npm install -g @jacebenson/jsn
```

**Note:** git installs build `better-sqlite3` (docs search) from source, so the machine needs build tools (Python, make, a C++ compiler).

## Quick Start

```bash
jsn setup                                    # Interactive: add, switch, remove, modify instances
jsn incidents list --query "priority=1"      # Critical incidents
```

## What It Does

jsn talks to the ServiceNow REST API. Read, create, update, delete — tickets, users, groups, records on any table. Inspect flows and business rules. Export update sets. Run background scripts.

Everything outputs JSON when piped, styled tables in a terminal.

```bash
# Core ticket work
jsn incidents list --query "active=true^priority=1"
jsn incidents INC0010001
jsn incidents create --description "Server down" --priority 1

# Admin tasks
jsn flows list                                # Interactive picker with pagination
jsn flows show "Assign Task"                  # Full flow detail
jsn flows executions                          # All states, newest first
jsn flows executions --active                  # Only waiting/running/queued
jsn flows executions --since "2026-08-25 00:00:00" --until "2026-08-26 00:00:00"
jsn flows executions --summary                 # Server totals + sampled duration metrics by flow
jsn flows executions --limit 100               # Inspect more rows from the matching population
jsn flows executions --record <sys_id>        # Executions for one source record
jsn rules list --query "collection=incident"
jsn updatesets set "My Feature"

# Generic table access
jsn records list --table incident --limit 50 --json | jq '.data.records[].number'
jsn records create --table incident --data '{"short_description":"test"}'
jsn records list --table incident --limit 50 --get "data.records.0.number"   # no jq needed
jsn records list --table incident --query "active=true"                       # totals included by default
jsn records list --table incident --limit 10 --no-count                       # opt out of the total query
jsn records bulk --table incident --query "priority=1" --set '{"state":"3"}'  # dry-run by default
jsn records get --table incident --sys-id 8a1234abcd5678 --attachments        # record + its files
jsn records list --table incident --limit 10 --csv                            # output CSV

# Read-only cross-profile record diff
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod --ignore state
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod --no-ignore

# Script execution
jsn eval "gs.info('Hello World')"
cat script.js | jsn eval --stdin          # pipe a script in (no shell escaping)

# Now GraphQL (documents may contain mutations; read-only profiles are blocked)
jsn graphql --query '{ GlideRecord_Query { incident(pagination: {limit: 2}) { _results { number { value } } } } }'
cat incident.graphql | jsn graphql --stdin --variables '{"limit":2}'

# Saved query snippets (stored locally, run against the active profile)
jsn snippets save open-inc --table incident --query "active=true"
jsn snippets run open-inc

# Live log tailing (Ctrl+C to stop)
jsn logs follow --level error --tail 10
```

### Flow Designer actions

`actions` and `action` are the same command. `list`, `show`, and explicit
`delete` remain available. Create and edit use full Process Flow JSON, not
ordinary table-field updates.

```bash
jsn actions step-types --scope <scope_sys_id> --get data > step-types.json
jsn actions create --scope <scope_sys_id> --data-file new-action.json --json
jsn actions definition <action_sys_id> --get data > action.json
# Edit action.json, retaining its ID, scope, lifecycle fields and all arrays.
jsn actions update <action_sys_id> --data-file action.json --json
jsn action edit <action_sys_id> --data-file action.json --json  # same operation
jsn actions test <action_sys_id> --force --output-map '{"response":"hello"}' --wait --timeout 60 --json
jsn actions test <action_sys_id> --force --data-file action.json --output-map '{"response":"hello"}' --wait --get data.outputs.response.value
jsn actions delete <action_sys_id> --force  # explicit cleanup, never automatic
```

Existing targets infer their exact transaction scope from the action record.
An explicit `--scope` must match that record byte-for-byte and exist in
`sys_scope`. For Global, use the literal sys_id `global`.

This **illustrative create document** shows an input/script/output mapping.
Replace `<SCRIPT_STEP_TYPE_SYS_ID>` with the target's `step-types` result.
Start from that step type's full input/output schemas, preserving runtime
settings, status outputs and any other required fields. The shortened example
is not a captured or instance-verified template. New steps/variables need their
own identifiers; do not clone another action's record IDs. Leave new steps'
`step_id` and `action` blank or omitted. Create binds their `action` to the newly
allocated parent; persisted step IDs or parent bindings are rejected before creation.

```json
{
  "name": "Echo response",
  "description": "Return the supplied response",
  "internal_name": "echo_response",
  "inputs": [{"name": "response", "label": "Response", "type": "string", "mandatory": true}],
  "outputs": [{"name": "response", "label": "Response", "type": "string", "value": "{{step[11111111-2222-4333-8444-555555555555].response}}"}],
  "steps": [{
    "cid": "11111111-2222-4333-8444-555555555555",
    "step_type": "SCRIPT",
    "step_type_id": "<SCRIPT_STEP_TYPE_SYS_ID>",
    "label": "Echo script",
    "order": 1,
    "inputs": [
      {"name": "required_run_time", "type": "choice", "value": "instance"},
      {"name": "script", "type": "script", "value": "(function execute(inputs, outputs) { outputs.response = inputs.response; })(inputs, outputs);"}
    ],
    "outputs": [],
    "extended_inputs": [{"name": "response", "type": "string", "value": "{{inputs.response}}", "extended": true}],
    "extended_outputs": [{"name": "response", "type": "string", "extended": true}]
  }]
}
```

Create first inserts the parent in `sys_hub_action_type_definition`, reads that
parent's own Process Flow defaults, then saves the inputs, outputs and nonempty
steps with the internal `/api/now/processflow/action/action_types/{id}` PUT.
It retains fresh lifecycle/status metadata instead of copying source snapshot
or status IDs. A subsequent definition GET plus `/step_instances` GET verifies
scripts, mappings and schemas. Update requires a complete document from
`definition`, including target-owned lifecycle fields. Omitted fields are
rejected before mutation. A PUT timeout triggers readback, not another PUT;
`persisted_after_timeout` means persistence was verified, not that HTTP success
was received. Failed creation reports the parent ID and leaves cleanup to you.

Test sends `action`, `outputMap`, `runOnThread` and `tracingEnabled` to `/test`.
Despite its wire name, `--output-map` supplies **action inputs**. Without
`--wait`, success means dispatch only, with `status: dispatched` and no outputs.
With `--wait`, JSN requires a `COMPLETE` context, blank `error_message`, and each
declared user output's actual value from `sys_flow_runtime_value`. Output entries
have `value`, `displayValue` and `hasValue`; false, zero and empty strings count.
Failures, denied/missing outputs and timeouts exit nonzero. The wait budget
starts after dispatch, defaults to 60 seconds, and is capped at 3600 seconds.
Timeout does not cancel the server execution. Draft actions can be tested without
publication. Testing runs their scripts and can have side effects. It requires
interactive confirmation or `--force`, unless the profile explicitly skips
confirmations. Read-only profiles block create/update/delete/test. No publish
or snapshot command is added.
These internal endpoints and runtime-table permissions can vary by instance.

### Flow execution fields

`jsn flows executions` reads `sys_flow_context` and returns both the raw row and a normalized `execution` object. JSN discovers the runtime columns from `sys_dictionary` first, then uses these mappings:

- `started`: `started`, `start_time`, `started_at`, then `sys_created_on`
- `ended`: `ended`, `end_time`, `ended_at`, then `completed_on`
- `duration_seconds`: stored `duration`, `run_time`, or `execution_duration`, otherwise `ended - started`
- `waiting_age_seconds`: current time minus `started` while the status is waiting, queued, paused, or pending
- `execution_age_seconds`: current time minus `started` while the status is running, executing, or processing
- `status`: `state`, then `status`, then `execution_state`
- `error`: `error`, `error_message`, `exception`, then `message`

The timestamp fields are instance-dependent. `sys_created_on` is a fallback for when the context row was created, not a claim that it is the true runtime start time.

## Commands

Run `jsn` for the full grouped list. Commands are organized by ServiceNow domain:

**Core** — `incidents`, `changes`, `requests`, `tasks`, `tickets`

**Automation** — `flows`, `actions`, `rules`, `scrapi`, `updatesets`, `eval`, `rest`

**Access** — `acls`, `roles`, `scopes`, `properties`, `privileges`

**User Experience** — `forms`, `lists`, `clientscripts`, `uipolicies`, `uiactions`

**Data** — `records` (list/get/create/update/delete/count/bulk/attachments), `diff record` (cross-profile read-only comparison), `tables`, `columns`, `includes`, `import`, `logs` (list/show/follow), `snippets` (save/run), `users`, `groups`

**Platform** — `platform health` (cluster records) and `platform stats` (bounded, read-only `/xmlstats.do` summary; allowlisted metrics only)

Every command supports `--json`, `--query`, and `--help`.

For multiline script fields, `--data-file` parses the file as UTF-8 JSON and
passes the resulting values through unchanged. On Windows PowerShell, generate
the payload as JSON text and inspect it before invoking JSN, for example:

```powershell
$script = [string](Get-Content -Path .\Example.script.js -Raw)
$payload = @{ script = $script; description = 'Example' } |
  ConvertTo-Json -Depth 5 -Compress
Set-Content -Path .\Example.update.json -Value $payload -Encoding UTF8
Get-Content .\Example.update.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty script
jsn includes update Example --data-file .\Example.update.json --json
```

`JSON.parse` preserves a JSON string as a JavaScript string, and the SDK
serializes update payloads with `JSON.stringify`. If the file already contains
a `{value=...}` or FileSystem-provider representation, that text is external
to JSN and must be corrected before the update. Use a read-back command or
`records update --strict` where applicable to verify persisted fields.

## Instances

Switch between instances without re-authenticating.

```bash
jsn setup                    # Interactive: add, switch, remove, or modify instances
jsn auth status              # Dashboard — auth state, read-only 🔒, skip-confirmations ⚡
```

`jsn setup` is the human front door — one command, interactive menu. For scripts and CI, use the atomic commands:

```bash
jsn auth login https://dev12345.service-now.com   # Add + authenticate (scripted)
jsn auth refresh                                  # Manually refresh the OAuth token
jsn auth switch dev12345                          # Flip the active profile (scripted)
jsn auth modify dev12345                          # Toggle read-only / skip confirmations
```

## Output Formats

| Flag | When to use |
|------|-------------|
| (default) | Terminal — styled tables |
| `--json` | Pipelines, scripts |
| `--markdown` | Documentation |
| `--quiet` / `-q` | Data only, no envelope |
| `--csv` | Spreadsheets (opens straight into Excel) |
| `--get <path>` | Pull one value out of the JSON envelope — no jq (e.g. `--get "data.records.0.number"`) |

## Authentication

JSN supports OAuth 2.0 with PKCE, Basic Auth, and browser-session auth. Credentials are stored in the operating system's credential store, with a file fallback under `~/.config/servicenow/credentials/` when the keyring is unavailable.

```bash
jsn auth login https://dev12345.service-now.com
```

For Basic Auth, set `SN_USERNAME` and `SN_PASSWORD`, then run `jsn auth login --basic <instance>`.
For browser-session auth, run `jsn auth login --gck <instance>` and paste the request headers when prompted.

For CI/CD, set environment variables:

```bash
export SERVICENOW_INSTANCE_URL="https://dev12345.service-now.com"
export SERVICENOW_OAUTH_TOKEN="***"
jsn incidents list
```

For the credential identity, auth-method, diagnostics, migration, and concurrency contract, see [`docs/AUTH_LIFECYCLE.md`](docs/AUTH_LIFECYCLE.md).

GraphQL uses ServiceNow's `/api/now/graphql` endpoint and sends `{query, variables}` through the authenticated SDK transport. The command preserves GraphQL `data` and `errors`; introspection and available namespaces depend on the target instance.

`jsn platform stats` uses a fixed `GET /xmlstats.do` request. It never accepts a processor path, query parameters, or request body, and it does not emit raw XML, cookies, credentials, or full node identifiers. Oversized, HTML/login, permission, unsupported, timeout, and malformed responses are reported with bounded collector statuses; missing metrics remain unavailable rather than being reported as zero.

## Local data

JSN stores durable local data under `~/.jsn/`. Documentation lives in
`~/.jsn/docs/`, including `docs.db`, the ServiceNowDocs source checkout, and
community markdown. Configuration stays under `~/.config/servicenow/` and
credentials use the operating system's credential store, with a file fallback under `~/.config/servicenow/credentials/`.

Existing installations migrate documentation from
`~/.cache/servicenow-cli/docs/` automatically the first time the docs data is
accessed. The old directory is removed only after the destination is verified.


## AI Agents

jsn ships with a skill file that tells AI agents how to use it. Installed automatically to `~/.agents/skills/servicenow/SKILL.md`.

```bash
jsn skill show                  # View the skill
jsn skill install               # Install to Hermes
jsn skill install --target all  # All supported agents
```

## Development

```bash
git clone https://github.com/jacebenson/jsn.git
cd jsn
npm install
npm test
```

Releases run from the GitHub Actions workflow. Dispatch `Release production` with `patch`, `minor`, or `major`. The workflow tests and lints the repo, bumps the version, pushes the commit and tag, dispatches the npm publish workflow, and creates the GitHub release.

## License

MIT
