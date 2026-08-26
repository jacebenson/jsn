# JSN — ServiceNow CLI

A command-line interface for ServiceNow. Type `jsn` and start working — no web UI needed.

Works standalone or with AI agents (Claude Code, OpenCode, Hermes, Cursor, Copilot).

## Install

```bash
npm install -g @jacebenson/jsn
```

Node.js (see `engines` in package.json). macOS, Linux, Windows.

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
jsn records list --table incident --limit 50 --json | jq '.[].number'
jsn records create --table incident --data '{"short_description":"test"}'
jsn records list --table incident --limit 50 --get "data.records.0.number"   # no jq needed
jsn records list --table incident --query "active=true"                       # totals included by default
jsn records list --table incident --limit 10 --no-count                       # opt out of the total query
jsn records bulk --table incident --query "priority=1" --set '{"state":"3"}'  # dry-run by default
jsn records get --table incident --sys-id 8a1234abcd5678 --attachments        # record + its files
jsn records list --table incident --limit 10 --csv                            # output CSV

# Script execution
jsn eval "gs.info('Hello World')"
cat script.js | jsn eval --stdin          # pipe a script in (no shell escaping)

# Saved query snippets (stored locally, run against the active profile)
jsn snippets save open-inc --table incident --query "active=true"
jsn snippets run open-inc

# Live log tailing (Ctrl+C to stop)
jsn logs follow --level error --tail 10
```

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

**Data** — `records` (list/get/create/update/delete/count/bulk/attachments), `tables`, `columns`, `includes`, `import`, `logs` (list/show/follow), `snippets` (save/run), `users`, `groups`

Every command supports `--json`, `--query`, and `--help`.

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

OAuth 2.0 with PKCE. Credentials in `~/.config/servicenow/credentials/`.

```bash
jsn auth login https://dev12345.service-now.com
```

For CI/CD, set environment variables:

```bash
export SERVICENOW_INSTANCE_URL="https://dev12345.service-now.com"
export SERVICENOW_OAUTH_TOKEN="***"
jsn incidents list
```

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

Releases: `npm run release -- patch` (or `minor`, `major`). Tags, pushes, and publishes to npm via GitHub Actions.

## License

MIT
