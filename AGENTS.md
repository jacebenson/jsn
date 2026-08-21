# Agent Documentation for JSN CLI

> JSN v4.x — Node.js — branch: `main`

This document provides guidance for AI agents using the JSN CLI to interact with ServiceNow.

## Design Philosophy

JSN is designed for **safe, composable automation**:

1. **Read-only by default** — List and show operations are safe
2. **Explicit mutations** — Create/update/delete require confirmation (`--force` to skip in scripts)
3. **Read-only profiles** — Profiles flagged `read_only` block all mutations
4. **Structured output** — Every command emits a JSON envelope with `--json`
5. **Error handling** — Clear error messages with hints for resolution

## Command Layout

All commands are root-level. Run `jsn help` for the full command list. Every command supports `--help` (e.g. `jsn incidents --help`).

Global options:

| Flag | Purpose |
|------|---------|
| `-i, --instance <url>` | Override the configured instance |
| `-p, --profile <name>` | Use a named profile (resolves its instance URL) |
| `--json` | JSON envelope output (shortcut for `--format=json`) |
| `--csv` | CSV output |
| `-q, --quiet` | Bare data, no envelope |
| `--markdown` / `--styled` | Force markdown table / styled output |
| `--get <path>` | Extract a value from the JSON envelope (e.g. `--get "data.records.0.number"`) — no jq needed |
| `--help` | Per-command help |

## Shell Completion

Tab completion for commands, subcommands, and options:

```bash
# Print install instructions for your shell
jsn completion --help

# bash (with bash-completion package — auto-loaded)
jsn completion > ~/.local/share/bash-completion/jsn

# bash (simple)
jsn completion >> ~/.bashrc

# fish
jsn completion > ~/.config/fish/completions/jsn.fish

# zsh (script is bash-style; load via bashcompinit in ~/.zshrc)
autoload -U +X bashcompinit && bashcompinit
source <(jsn completion)
```

Restart the shell after installing.

## Common Workflows

### Workflow 1: Incident Management

```bash
# List all open critical incidents
jsn incidents list --query "priority=1^active=true^state!=6" --json

# Get details of a specific incident
jsn incidents show INC0010001 --json

# Create a new incident (returns the created record)
jsn incidents create --description "Issue description" --priority 2 --json

# Update an incident
jsn incidents update INC0010001 --data '{"state": "2", "assigned_to": "user_id"}'

# Add a work note
jsn records update --table incident --sys-id <sys_id> --data '{"work_notes": "Updated status"}'
```

### Workflow 2: Change Request Management

```bash
# List pending changes
jsn changes list --query "state=-5" --json

# Create a standard change
jsn changes create --description "Monthly maintenance" --risk low --json

# Approve a change (move to assessment)
jsn changes update CHG0010001 --data '{"state": "1"}'
```

### Workflow 3: User Management

```bash
# Search for users
jsn users "John Smith" --json

# Get user details
jsn users list --query "user_name=john.smith" --json

# Find user's group memberships
jsn records list --table sys_user_grmember --query "user.name=john.smith" --columns "group.name,group.manager" --json
```

### Workflow 4: Development Artifacts

```bash
# Script includes in a scope
jsn includes list --query "sys_scope.scope=x_myapp" --json

# Get script include code
jsn includes show MyScriptInclude --json --get "data.script"

# Business rules on a table
jsn rules list --query "collection=incident^active=true" --json

# Client scripts / UI actions / UI policies on a table
jsn clientscripts list --query "table_name=incident^active=true" --json
jsn uiactions list --query "table=incident^active=true" --json
jsn uipolicies list --query "table=incident^active=true" --json

# Update sets
jsn updatesets list --query "state=in progress" --json
jsn updatesets set "My Development" --json
jsn updatesets export "My Update Set" --out my-update-set.xml

# ACLs for a table
jsn acls list --query "name=incident" --json

# System properties
jsn properties list --query "nameLIKEglide.encryption" --json

# Table schema
jsn tables list --query "nameLIKEincident" --json
jsn columns list --query "name=incident" --json
```

### Workflow 5: Records Inspect (Audit & Diagnostics)

```bash
# Show audit history for a record
jsn records inspect INC0010001 --audit

# Show business rules that fire on a record's table
jsn records inspect INC0010001 --rules

# Show running flows for a record
jsn records inspect INC0010001 --flows

# Run all diagnostics at once
jsn records inspect INC0010001 --all
```

### Workflow 6: Create/Update/Delete on Dev Artifacts

Most artifact commands support full CRUD:

```bash
# Create a business rule
jsn rules create --data '{"name": "My Rule", "collection": "incident", "script": "gs.log(\"hello\");"}'

# Update a script include
jsn includes update <sys_id> --data '{"script": "// updated code"}'

# Delete a UI action
jsn uiactions delete <sys_id> --force
```

### Workflow 7: Data Queries

```bash
# Generic table query with jq processing
jsn records list --table incident --query "active=true^opened_at>javascript:gs.daysAgo(7)" --json | \
  jq -r '.data.records[] | "\(.number): \(.short_description)"'

# Count records
jsn records list --table incident --query "priority=1" --json | jq '.data.records | length'

# Export to CSV without jq
jsn records list --table incident --limit 100 --csv

# Extract one value without jq
jsn incidents show INC0010001 --json --get "data.records.0.sys_id"

# Fetch all fields from a record
jsn records get --table incident --sys-id <sys_id> --columns '*' --json
```

## Best Practices for Agents

### 1. Always Use --json for Automation

```bash
# Good - structured output for parsing
jsn incidents list --json --get "data.records.0.number"

# Avoid - parsing human-readable output
jsn incidents list | grep "INC" | awk '{print $1}'
```

### 2. Handle Errors Gracefully

```bash
# Check if command succeeded
if jsn incidents show INC0010001 --json > /dev/null 2>&1; then
    echo "Incident exists"
else
    echo "Incident not found"
fi
```

### 3. Use --limit for Large Tables

```bash
# Prevent timeouts on large tables
jsn records list --table sys_audit --limit 100 --json
```

### 4. Batch Operations

```bash
# Get multiple records efficiently
jsn records list --table incident --query "numberININC0010001,INC0010002,INC0010003" --json
```

### 5. Safe Update Patterns

```bash
# Always verify before updating
SYS_ID=$(jsn incidents show INC0010001 --json --get "data.records.0.sys_id") && \
  jsn records update --table incident --sys-id "$SYS_ID" --data '{"state": "6"}'
```

## Safety Guidelines

### Safe Operations (Read-Only)

- `jsn incidents list` / `show` (same for `changes`, `requests`, `tasks`, `tickets`)
- `jsn records list` / `get` / `inspect`
- `jsn users list`, `jsn groups list`, `jsn groupmembers list`, `jsn grouproles list`
- `jsn cmdb list` / `show` / `relationships` (read-only CI + relationship traversal)
- `jsn atf list` / `suites` / `results`
- `jsn approvals list` / `history`
- All artifact `list` / `show` (`rules`, `includes`, `clientscripts`, `uiactions`, `uipolicies`, `tables`, `columns`, `acls`, `roles`, `updatesets`, `scopes`, `properties`, `logs`, `forms`, `lists`, `flows`, `actions`, `import`, ...)
- `jsn snippets list` / `show`
- `jsn docs *` (no instance required, always read-only)
- `jsn completion`, `jsn version`, `jsn skill show`

### Operations Requiring Confirmation

These modify data and prompt unless `--force` is passed:

- `create` / `update` / `delete` on `incidents`, `changes`, `requests`, `tasks`, `tickets`, `records`, and dev artifacts
- `jsn updatesets set`
- `jsn eval` (executes arbitrary scripts on the instance)
- `jsn atf run` / `run-suite` (schedules tests that act on records)
- `jsn approvals approve` / `reject` / `submit`

Profiles can be flagged `read_only`, which blocks all mutations outright.

**Agent Rule**: Always verify with the user before running mutation commands.

## Output Format Reference

### JSON Output Structure

```json
{
  "ok": true,
  "data": { "records": [ ... ] },
  "summary": "Description of result",
  "breadcrumbs": [
    {
      "action": "create",
      "cmd": "jsn incidents create --description \"...\"",
      "description": "Create a new incident"
    }
  ],
  "meta": { ... }
}
```

### Error Response Structure

```json
{
  "ok": false,
  "error": "Description of error",
  "code": "error_code",
  "hint": "How to fix this error",
  "meta": { ... }
}
```

## Common Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| `auth` | Authentication error | Run `jsn auth login` |
| `usage` | Invalid usage | Check command syntax with `--help` |
| `not_found` | Record not found | Verify the identifier exists |
| `read_only` | Mutation blocked on read-only profile | `jsn auth switch <name>` |
| `confirmation_required` | Mutation needs `--force` or confirm | Re-run with `--force` |
| `api_error` | ServiceNow API error | Check instance status and permissions |
| `network` | Network error | Check connectivity |

## Working with Encoded Queries

ServiceNow uses encoded queries for filtering:

```bash
# Operators
^          AND
^OR        OR
^NQ        New query (OR group)
=          Equals
!=         Not equals
>          Greater than
<          Less than
>=         Greater or equal
<=         Less or equal
LIKE       Contains
NOT LIKE   Does not contain
STARTSWITH Starts with
ENDSWITH   Ends with
EMPTY      Is empty
NOT EMPTY  Is not empty
IN         In list (comma-separated)

# Examples
"priority=1^active=true"                          # Critical and active
"priorityIN1,2^state!=6"                          # Priority 1 or 2, not closed
"short_descriptionLIKEserver^ORnumber=INC0010001" # Contains "server" OR specific number
"opened_at>javascript:gs.daysAgo(7)"              # Opened in last 7 days
```

## Integration Patterns

### With jq (JSON processing)

```bash
# Extract specific fields
jsn incidents list --json | jq '.data.records[].number'

# Filter results
jsn incidents list --json | jq '.data.records[] | select(.priority == "1")'
```

### With --get (no jq)

```bash
jsn incidents show INC0010001 --json --get "data.records.0.assigned_to.display_value"
```

### With Other CLIs

```bash
# Create incident and send notification
NUMBER=$(jsn incidents create --description "Issue" --json --get "data.number")
echo "Created $NUMBER" | mail -s "New Incident" admin@example.com
```

## Testing Commands

When testing or exploring:

```bash
# Use --limit to prevent timeouts
jsn records list --table sys_audit --limit 5 --json

# Use quiet mode to see just the data
jsn incidents list --limit 5 -q

# Combine with head/tail
jsn incidents list --json --get "data.records" | head -50
```

## Running Tests

```bash
# Run the full test suite
npm test

# Run tests matching a pattern
node --test $(find test -name '*inspect*')

# Run with lint check
npm run lint && npm test

# Instance-backed E2E tests (requires configured auth; creates/deletes records)
JSN_INTEGRATION_TESTS=true npm test
```

**Test env vars:** `JSN_HERMES_BASE_DIR` points skill tests at a temp `.hermes` tree; `JSN_NO_VERSION_CHECK=1` and `JSN_NO_SKILL_CHECK=1` disable the daily npm/skill checks.

## AI Agent Integration

JSN ships a built-in agent skill file. Use the `jsn skill` command to manage it:

```bash
# View the bundled skill content
jsn skill show

# Download the latest skill from GitHub (prints to stdout)
jsn skill fetch | head -30

# Install to Hermes skills directory
jsn skill install

# Install to a custom location
jsn skill install /path/to/project/.hermes/skills/servicenow/
```

## Checking for Updates

```bash
jsn version                    # Show current version
jsn version --check            # Check npm for newer versions
```

## Workflow 8: Documentation Search

`jsn docs` provides local offline search of ServiceNow documentation — no instance required.

```bash
# One-time setup: download docs and build the search index (~45k files, ~3-5 min)
jsn docs sync

# Check what state things are in
jsn docs status

# Full-text + semantic hybrid search
jsn docs search "incident management" --limit 5 --json

# Filter by bundle
jsn docs search "REST API" --bundle it-service-management --json

# Start the web UI for browsing
jsn docs serve

# Share on your network
jsn docs serve --expose
```

**State flow:** `not downloaded` → `not indexed` → `indexed (not embedded)` → `ready`

**Re-running `jsn docs sync`** on an existing DB does a smart incremental refresh (seconds, not minutes). It pulls the latest docs and only rebuilds changed files.

### Workflow 9: CMDB Inspection

```bash
# List CIs
jsn cmdb list --json

# Show a CI with key fields + parents/siblings/children (capped, counts)
jsn cmdb show <ci_sys_id_or_name> --json

# Traverse the relationship graph (BFS, zero deps)
jsn cmdb relationships --ci <sys_id> --direction both --depth 3 --json

# Options: --direction upstream|downstream|both, --depth 1-5, --type <substring>,
#          --class <substring>, --impact (upstream only), --limit
```

### Workflow 10: ATF Test Execution

```bash
# List ATF tests / suites (read-only)
jsn atf list --query "active=true" --json
jsn atf suites --json

# Run a test or suite (mutation-gated, confirm required; --no-wait to skip polling)
jsn atf run <test_sys_id> --json
jsn atf run-suite <suite_sys_id> --json

# Fetch results for a run
jsn atf results <execution_id> --json
```

### Workflow 11: Approvals

```bash
# List pending approval requests (read-only; default state=requested)
jsn approvals list --json

# Only approvals assigned to the current user (fails loudly if the profile has no username)
jsn approvals list --mine --json

# Approvals for a specific record
jsn approvals list --for CHG0010001 --json

# Show the approval progression for a record (approver rows + rollup state)
jsn approvals history CHG0010001 --json

# Approve/reject a request (mutation-gated, confirm required)
jsn approvals approve <approver_sys_id> --comments "Looks good" --json
jsn approvals reject <approver_sys_id> --comments "Needs more info" --json

# Request approval on a record (mutation-gated; sets approval=requested)
jsn approvals submit change_request <sys_id> --json
```

## References

- [ServiceNow Table API Docs](https://docs.servicenow.com/bundle/tokyo-application-development/page/integrate/inbound-rest/concept/c_TableAPI.html)
- [ServiceNow Encoded Query Docs](https://docs.servicenow.com/bundle/tokyo-platform-administration/page/administer/table-administration/concept/c_EncodedQueryStrings.html)
- [jq Manual](https://stedolan.github.io/jq/manual/)
