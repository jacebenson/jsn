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
  version: "4.3.10"
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
4. **Verify the intended instance** — Use `--profile <name>` for explicit targeting; never assume the default is right. `jsn auth switch <name>` changes the default.
5. **Eval safety** — Prefer purpose-built or `records` commands. Never use `eval` to bypass a blocked business rule, ACL, or other ServiceNow protection. If eval is genuinely needed, explain why and obtain explicit user approval.
6. **CONFIRM before destructive operations** — Show what will be created/updated/deleted and ask for approval.

## Command Hierarchy

Pick the most specific tool for the job. **Never default to eval** — it's the last resort:

1. **Specific commands** — `jsn flows`, `jsn rules`, `jsn catalogitems`, etc.
2. **`jsn records --table <name>`** — generic CRUD on any table
3. **`jsn docs search <query>`** — offline ServiceNow documentation search (no instance needed)
4. **`jsn rest`** — raw Table API escape hatch
5. **`jsn eval`** — ⚠️ **LAST RESORT ONLY**
6. **Ask the human** — if none of the above work

## Key Commands

| Domain | Commands |
|--------|---------|
| **Core** | `incidents`, `changes`, `requests`, `tasks` |
| **Catalog** | `catalogitems list/show/create` — items with variables and flow info |
| **Automation** | `flows`, `actions`, `rules`, `triggers`, `scheduledjobs` |
| **Access** | `acls`, `b4rules`, `roles`, `groups`, `users` |
| **UX** | `forms` (section/element layout), `lists`, `clientscripts`, `uipolicies` |
| **Data** | `tables`, `columns`, `includes`, `logs`, `properties`, `records` |
| **Config** | `setup`, `auth`, `updatesets`, `scopes` |
| **Docs** | `docs sync`, `docs status`, `docs search`, `docs serve` |
| **Developer** | `eval`, `rest`, `skill`, `version` |

### Customization evidence

Use `jsn customizations --help` to discover bounded read-only capture and offline
review/comparison. For example:

```sh
jsn customizations capture --label review --customer-scope x_acme_app --json
jsn customizations show <run_id> --json
```

Read the CLI's interpretation, coverage and per-artifact triage before drawing
conclusions. Verify ownership and current behavior before proposing changes;
never recommend automatic reversion.

### Complete an update set

Before development changes, identify the intended application scope and update
set. Keep related changes together, use the appropriate update-set or application
deployment mechanism, and report where changes were captured. Not all changes
are update-set tracked. Only complete a set when the human explicitly asks,
including sets you created; completing the current set returns selection to Default.

```bash
jsn updatesets complete "My Feature" --notes "Fixed validation" --force --json
```

`complete [name]` defaults to the current set when the name is omitted. Explicit
names must be unique. Supply nonempty `--notes` in automation; real newlines
separate bullets. A human terminal opens a notes editor when `--notes` is absent.
Existing Description text is preserved and appended after confirmation. Use
`--force` only after approval, or the profile's `skip_confirmations` policy.
Notes apply only to the selected set. ServiceNow's normal batch rules can complete
child sets when the parent completes; their descriptions are not replaced.
Both selected-set Description and state are read back before success. On
verification failure, inspect the set before retrying.

### Table and raw REST discovery

Use `jsn records list --help`, `jsn records get --help`, and `jsn rest --help`
for syntax and examples. REST is blocked on read-only connections, including GET.

### `jsn docs` — offline documentation search

No ServiceNow instance required. Searches the full ServiceNow docs locally with FTS5 + semantic hybrid search.

```bash
# First run: download docs and build the index (~45k files, ~3-5 min)
jsn docs sync

# Check state
jsn docs status

# Search (keyword + semantic hybrid)
jsn docs search "GlideRecord query" --limit 5 --json

# Filter by bundle
jsn docs search "REST API" --bundle it-service-management --json

# Start the web UI
jsn docs serve

```

**Re-running `jsn docs sync`** does a smart incremental refresh — pulls latest docs and only rebuilds changed files (seconds, not minutes).

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
└── credentials/              # Auth tokens (fallback, one file per key)
```
