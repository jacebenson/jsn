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
  curl -fsSL https://jsn.jace.pro/install | bash
  Works with Claude Code, OpenCode, Cursor, and agentskills-compatible tools.
metadata:
  author: jacebenson
  version: "1.0.0"
  repository: https://github.com/jacebenson/jsn
---

# Jace's ServiceNow CLI

Explore and manage ServiceNow instances. Works standalone or with AI agents.

## Agent Invariants

**MUST follow these rules:**

1. **Choose the right output mode** — `--json` when parsing data; `--md` when presenting to humans
2. **Use sys_id for updates** — All update/delete operations require sys_id
3. **Check auth first** — Run `jsn auth status` if commands fail
4. **Profile scope** — Use `--profile <name>` or switch with `jsn config switch <name>`

### Output Modes

| Goal | Flag | Format |
|------|------|--------|
| Parse data, pipe to jq | `--json` | JSON envelope: `{ok, data, summary, breadcrumbs}` |
| Show results to user | `--md` | Markdown tables |
| Automation/scripting | `--agent` | JSON + quiet + no interactive prompts |
| Raw data only | `--quiet` | JSON data without envelope |

### JSON Envelope

Every command supports `--json`:

```json
{
  "ok": true,
  "data": [...],
  "summary": "5 tables",
  "breadcrumbs": [
    {"action": "show", "cmd": "jsn tables show incident", "description": "View details"}
  ]
}
```

Breadcrumbs suggest next commands for navigation.

## Quick Reference

| Task | Command |
|------|---------|
| List tables | `jsn tables list --json` |
| Show table schema | `jsn tables schema incident --json` |
| List table columns | `jsn tables columns incident --json` |
| Query records | `jsn records list incident --query "active=true" --json` |
| Show record | `jsn records show incident <sys_id> --json` |
| Count records | `jsn records count incident --query "priority=1" --json` |
| Create record | `jsn records create incident --data '{"short_description":"Test"}' --json` |
| Update record | `jsn records update incident <sys_id> --data '{"state":"2"}' --json` |
| Delete record | `jsn records delete incident <sys_id> --force --json` |
| List business rules | `jsn rules list --table incident --json` |
| Show rule script | `jsn rules script <sys_id>` |
| List flows | `jsn flows list --active --json` |
| List script includes | `jsn script-includes list --json` |
| Show script code | `jsn script-includes code <name>` |
| List ACLs | `jsn acls list --table incident --json` |
| List update sets | `jsn updateset list --json` |
| Set current update set | `jsn updateset use <name>` |
| List choices | `jsn choices list <table> <column> --json` |
| List jobs | `jsn jobs list --json` |
| Run job | `jsn jobs run <sys_id>` |
| List forms | `jsn forms list --table incident --json` |
| List UI policies | `jsn ui-policies list --table incident --json` |
| List client scripts | `jsn client-scripts list --table incident --json` |
| List catalog items | `jsn catalog-item list --json` |
| List item variables | `jsn catalog-item variables <sys_id> --json` |
| List variable choices | `jsn variable choices <name> --json` |
| Add variable choice | `jsn variable add-choice <name> "value"` |
| Variable types | `jsn variable-types --json` |
| Search docs | `jsn docs search <term>` |
| Compare instances | `jsn compare tables --source prod --target dev --json` |
| Generate code | `jsn generate gliderecord --table incident` |

## Command Categories

### Tables & Schema (Read-only exploration)

```bash
jsn tables list --json                    # All tables
jsn tables list --search "incident"       # Filter by name
jsn tables list --app "global"            # Filter by scope
jsn tables show incident --json           # Table details
jsn tables schema incident --json         # Inheritance tree
jsn tables columns incident --json        # Column definitions
```

### Records (CRUD operations)

```bash
jsn records list <table> --json                              # List records
jsn records list <table> --query "active=true" --limit 10    # With filter
jsn records list <table> --fields "number,short_description" # Specific fields
jsn records show <table> <sys_id> --json                     # Single record
jsn records count <table> --query "priority=1"               # Count
jsn records create <table> --data '{"field":"value"}'        # Create
jsn records update <table> <sys_id> --data '{"field":"value"}'  # Update
jsn records delete <table> <sys_id> --force                  # Delete
jsn records variables <ritm_sys_id> --json                   # Catalog variables
```

### Business Rules

```bash
jsn rules list --table incident --json    # Rules on table
jsn rules show <sys_id> --json            # Rule details
jsn rules script <sys_id>                 # Output just the script
```

### Flows

```bash
jsn flows list --json                     # All flows
jsn flows list --active --json            # Active only
jsn flows show <name> --json              # Flow details
```

### Script Includes

```bash
jsn script-includes list --json           # All script includes
jsn script-includes list --scope global   # Filter by scope
jsn script-includes show <name> --json    # Details
jsn script-includes code <name>           # Output just the code
```

### ACLs

```bash
jsn acls list --table incident --json     # ACLs on table
jsn acls show <sys_id> --json             # ACL details
jsn acls script <sys_id>                  # Output condition script
jsn acls check --table incident --operation read  # Test coverage
```

### Update Sets

```bash
jsn updateset list --json                 # All update sets
jsn updateset show <name> --json          # Details
jsn updateset use <name>                  # Set as current
jsn updateset create <name>               # Create new
jsn updateset parent <child> <parent>     # Set parent
```

### Choices

```bash
jsn choices list <table> <column> --json  # List choices
jsn choices create <table> <column> --value 5 --label "Critical"
jsn choices update <sys_id> --label "New Label"
jsn choices delete <sys_id> --force
jsn choices reorder <table> <column> --mode hundreds
```

### Jobs & Scheduling

```bash
jsn jobs list --json                      # All jobs
jsn jobs list --type scheduled            # Scheduled only
jsn jobs show <sys_id> --json             # Job details
jsn jobs executions <sys_id> --json       # Execution history
jsn jobs run <sys_id>                     # Execute now
```

### UI Configuration

```bash
jsn forms list --table incident --json           # Form views
jsn forms show incident --view default --json    # Form layout
jsn ui-policies list --table incident --json     # UI policies
jsn ui-policies script <sys_id>                  # Policy script
jsn client-scripts list --table incident --json  # Client scripts
jsn client-scripts script <sys_id>               # Script code
jsn ui-scripts list --json                       # UI scripts
```

### Service Portal

```bash
jsn sp list --json                        # Portals
jsn sp show <id> --json                   # Portal details
jsn sp-widgets list --json                # Widgets
jsn sp-pages list --json                  # Pages
```

### Service Catalog

```bash
jsn catalog-item list --json              # List catalog items
jsn catalog-item list --active --json     # Active items only
jsn catalog-item show <sys_id> --json     # Item details
jsn catalog-item variables <sys_id> --json  # Variables on item

jsn variable show <name_or_sys_id> --json # Variable details
jsn variable choices <name> --json        # Choices for dropdown variable
jsn variable add-choice <name> "value" "Display Text"  # Add choice
jsn variable remove-choice <name> "value" # Remove choice

jsn variable-types --json                 # Variable type reference
```

**Note:** `jsn choices` manages `sys_choice` (field-level choices). Use `jsn variable choices` for catalog variable dropdown choices (`question_choice` table).

### Logs

```bash
jsn logs --json                           # Recent logs
jsn logs --level error --json             # Filter by level
jsn logs --source <name> --json           # Filter by source
```

### Documentation

```bash
jsn docs list                             # Available topics
jsn docs gliderecord                      # Show topic
jsn docs search "encoded query"           # Search docs
jsn docs update                           # Refresh cache
```

### Cross-Instance Operations

```bash
jsn compare tables --source prod --target dev --json
jsn compare script-includes --source prod --target dev --name "MyUtil"
jsn compare choices --source prod --target dev --table incident --column priority
jsn export script-includes --name "MyUtil" --output ./scripts
jsn export tables --name incident --output ./schema
```

### Code Generation

```bash
jsn generate gliderecord --table incident
jsn generate script-include --name "MyUtil"
jsn generate rest --name "MyAPI"
jsn generate acl --table incident --operation read
jsn generate test --table incident
```

## Configuration

```
~/.config/servicenow/         # Global config
├── config.json               #   Profiles and settings
└── credentials.json          #   Auth tokens (fallback)

.servicenow/                  # Per-repo config (optional)
└── config.json               #   Project-specific settings
```

### Profiles

```bash
jsn config list                           # List profiles
jsn config add                            # Add new profile
jsn config switch <name>                  # Switch active profile
jsn --profile prod tables list            # Use specific profile
```

### Authentication

```bash
jsn auth login                            # Interactive login
jsn auth status                           # Check auth
jsn auth logout                           # Clear credentials
```

**Environment variables:**
- `SERVICENOW_TOKEN` — Override stored token
- `SERVICENOW_INSTANCE` — Override instance URL

## Interactive Pickers

Commands with `[optional]` arguments open pickers when omitted:

```bash
jsn tables show [<name>]      # Opens picker if name not provided
jsn rules show [<id>]         # Opens picker if id not provided
jsn updateset use [<name>]    # Opens picker if name not provided
```

## Global Flags

```
--config <path>       # Use specific config file
--profile <name>      # Use specific profile
--json                # Output as JSON
--quiet, -q           # Output data only (no envelope)
--md                  # Output as Markdown
--agent               # Agent mode (JSON + quiet + no prompts)
--jq <filter>         # Apply jq filter to JSON output
```

## Error Handling

```bash
jsn auth status                           # Check authentication
jsn instance info                         # Check connectivity
```

**Common errors:**
- Auth error → `jsn auth login`
- Not found → Verify sys_id or table name
- Forbidden → Check user roles/permissions

## System Tables Reference

| Area | Tables |
|------|--------|
| Tables | `sys_db_object`, `sys_dictionary` |
| Choices | `sys_choice` |
| Business Rules | `sys_script` |
| Script Includes | `sys_script_include` |
| Flows | `sys_hub_flow` |
| ACLs | `sys_security_acl` |
| Update Sets | `sys_update_set` |
| UI Policies | `sys_ui_policy` |
| Client Scripts | `sys_script_client` |
| Forms | `sys_ui_section`, `sys_ui_element` |
| Jobs | `sysauto_script`, `sys_trigger` |
| Logs | `syslog` |
| Service Portal | `sp_portal`, `sp_widget`, `sp_page` |
| Service Catalog | `sc_cat_item`, `item_option_new`, `question_choice`, `sc_item_option_mtom` |
