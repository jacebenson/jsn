---
name: servicenow
description: |
  Interact with ServiceNow instances via the jsn CLI. Use when working with ServiceNow
  development, administration, or data exploration. Handles tables, records, business rules,
  flows, script includes, ACLs, update sets, and more. Triggered by ServiceNow URLs
  (service-now.com, servicenow.com) or when the user mentions ServiceNow, jsn, servicenow,
  or related terms like tables, records, business rules, flows, script includes, ACLs,
  update sets, or encoded queries.
license: MIT
compatibility: |
  Requires jsn CLI (github.com/jacebenson/jsn). Install via:
  npm install -g @jacebenson/jsn
  Works with Claude Code, OpenCode, Cursor, and agentskills-compatible tools.
metadata:
  author: jacebenson
  version: "3.1.1"
  repository: https://github.com/jacebenson/jsn
---

# Jace's ServiceNow CLI (jsn)

Explore and manage ServiceNow instances. Interactive paginated pickers with server-side search on all list commands.

## Discovery

```bash
jsn --help                # All commands grouped by domain
jsn <command> --help      # Flags, subcommands, and examples
```

## Interactive Picker

All `list` subcommands use a paginated interactive picker in TTY mode:
- Arrow through items (10 per page)
- Type to search (server-side LIKE query)
- Scroll past last loaded item to load next page
- Enter to select, Esc to cancel
- Falls back to table output with `--json`

## Agent Rules

1. **Output modes** — `--json` when parsing data; text when presenting to humans
2. **Use sys_id for updates** — All update/delete operations require sys_id
3. **Check auth first** — Run `jsn auth status` before operations
4. **NEVER logout** — Only run `jsn auth logout` if the user explicitly asks
5. **Use `--profile <name>`** to target a specific instance, or `jsn profiles use <name>` to change default
6. **Before using `eval` or `rest`** — Ask: *"Is there a more specific jsn command?"* Prefer specific over generic over escape hatch over eval.
7. **CONFIRM before destructive operations** — Show what will be created/updated/deleted and ask for approval.

## Command Hierarchy

Pick the most specific tool for the job. **Never default to eval** — it's the last resort:

1. **Specific commands** — `jsn flows`, `jsn rules`, `jsn catalogitems`, etc.
2. **`jsn records --table <name>`** — generic CRUD on any table
3. **`jsn rest`** — raw Table API escape hatch
4. **`jsn eval`** — ⚠️ **LAST RESORT ONLY**
5. **Ask the human** — if none of the above work

## Key Commands

| Domain | Commands |
|--------|---------|
| **Core** | `incidents`, `changes`, `requests`, `tasks` |
| **Catalog** | `catalogitems list/show/create` — items with variables and flow info |
| **Automation** | `flows`, `actions`, `rules`, `workflows`, `triggers`, `scheduledjobs` |
| **Access** | `acls`, `b4rules`, `roles`, `groups`, `users` |
| **UX** | `forms` (section/element layout), `lists`, `clientscripts`, `uipolicies` |
| **Data** | `tables`, `columns`, `includes`, `logs`, `properties`, `records` |
| **Config** | `setup`, `auth`, `profiles`, `updatesets`, `scopes` |
| **Developer** | `eval`, `rest`, `skill`, `version` |

### `jsn rest` examples

```bash
# Query any table by name
jsn rest --table incident --query "active=true" --limit 5 --json

# GET a single record
jsn rest --table incident --sys-id abc123... --json

# Raw endpoint access
jsn rest "/api/now/table/incident?sysparm_limit=3" --json
```

## Troubleshooting Field Behavior

Check order (priority):

1. **Before-query business rules** — `sys_script` with `when=before`, `action=query`
   ```bash
   jsn b4rules list --query "collection=sys_user"
   ```
2. **ACLs** — `jsn acls list --query "name=incident"`
3. **Dictionary overrides** — `jsn records list --table sys_dictionary --query "name=incident^element=caller_id"`
4. **Client scripts** / **UI policies** — form-level field behavior

## Configuration

```
~/.config/servicenow/
├── config.json               # Profiles and settings
└── credentials.json          # Auth tokens (fallback)
```
