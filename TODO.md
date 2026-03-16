# ServiceNow CLI (jsn) - Implementation Plan

Following basecamp-cli patterns for an agent-native CLI.

## Project Structure

```
servicenow-cli/
├── cmd/jsn/
│   └── main.go                      # Entry point
├── internal/
│   ├── appctx/                      # App context with Config, Auth, SDK
│   │   └── context.go
│   ├── auth/                        # Authentication
│   │   ├── auth.go                  # Auth manager
│   │   └── store.go                 # Credential store (keyring + file fallback)
│   ├── cli/
│   │   └── root.go                  # Root cobra command
│   ├── commands/                    # Command implementations
│   │   ├── auth.go                  # auth login/logout/status
│   │   ├── choices.go               # choices list/create/update/delete/reorder
│   │   ├── config.go                # config add/list/switch
│   │   ├── setup.go                 # Interactive first-time setup
│   │   └── tables.go                # tables list/show/create/update/delete
│   ├── config/
│   │   └── config.go                # Layered configuration (global + local)
│   ├── output/
│   │   └── output.go                # Output formatting (JSON/markdown/styled)
│   └── sdk/
│       └── client.go                # ServiceNow API client
├── go.mod
├── README.md
├── TODO.md                          # This file
└── CONTRIBUTING.md                  # Development guide
```

## Completed ✓

### Foundation & Auth
- [x] Initialize Go module with proper structure
- [x] Set up cobra root command with PersistentPreRunE
- [x] Create config system (global ~/.config/servicenow/config.json + local .servicenow/config.json)
- [x] Set up XDG directories support
- [x] Create auth package with credential store (keyring → file fallback)
- [x] Support both Basic Auth and g_ck token methods
- [x] Add `jsn auth login` with interactive prompts
- [x] Add `jsn auth logout`
- [x] Add `jsn auth status` with JSON output
- [x] Support SERVICENOW_TOKEN env var override
- [x] Create appctx package with App struct
- [x] Implement output package with all format modes (JSON, styled, markdown, quiet)
- [x] Add global flags: --json, --agent, --quiet, --md, --jq
- [x] Add `jsn config add/list/switch` commands
- [x] Add `jsn setup` interactive wizard
- [x] Create SDK client for Table API

### Tables Commands
- [x] `jsn tables list` - List tables with filtering
  - Filter by: --app, --search, --limit, --order, --desc
  - Shows: name, scope, label, extends (when --show-extends)
  - Clickable hyperlinks in styled output
  - Proper column alignment with lipgloss
- [x] `jsn tables show [<name>]` - Show table details (picker if omitted)
  - Shows metadata: name, label, sys_id, scope, extends
  - Shows child tables that extend this one
  - Hints for related commands
  - Follows basecamp's show pattern
- [x] `jsn tables schema [<name>]` - Show table metadata with inheritance tree view
  - Shows "Extends From" (parent tables up to root)
  - Shows "Extends To" (child tables)
  - Tree visualization with highlighted current table
- [x] `jsn tables columns [<name>]` - Show columns only

### Choices Commands
- [x] `jsn choices list <table> <column>` - List choice values ordered by sequence
  - Shows both active and inactive choices
  - Active choices: highlighted label with hyperlink
  - Inactive choices: muted text
  - Shows dependent values
- [x] `jsn choices create <table> <column>` - Create new choice
  - Interactive placement picker (insert at position)
  - Supports --value, --label, --sequence, --dependent flags
- [x] `jsn choices update <sys_id>` - Update choice
  - Supports --label, --sequence, --inactive, --active flags
- [x] `jsn choices delete <sys_id>` - Delete choice with confirmation
  - Supports --force flag for non-interactive mode
- [x] `jsn choices reorder <table> <column>` - Reorder choices
  - --mode hundreds: Normalize to 100, 200, 300, etc.
  - --mode alpha: Sort by label alphabetically

### Update Sets
- [x] `jsn updateset list` - List update sets
- [x] `jsn updateset show [<name>]` - Show update set details (picker if omitted)
- [x] `jsn updateset use [<name>]` - Set current update set (picker if omitted)
- [x] `jsn updateset create <name>` - Create update set
- [x] `jsn updateset parent [<child> <parent>]` - Set parent (picker if args omitted)

### Cleanup Completed
- [x] Fix isTTY() to use proper terminal detection
- [x] Centralize brand color constant (output.BrandColor)
- [x] Sort profile listing alphabetically
- [x] Remove unused code (isFirstRun function)

## In Progress 🚧

### Flows
- [ ] `jsn flows list [--active]` - List flows
- [ ] `jsn flows show [<name>]` - Show flow details (picker if omitted)

### Rules  
- [ ] `jsn rules list --table <table>` - List business rules
- [ ] `jsn rules show [<sys_id>]` - Show business rule (picker if omitted)
- [ ] `jsn rules script <sys_id>` - Output just the script

### Jobs
- [ ] `jsn jobs list [--type scheduled|script]` - List scheduled/script jobs
- [ ] `jsn jobs show [<sys_id>]` - Show job details (picker if omitted)

## Phase 4: Advanced Features

### Script Includes
- [ ] `jsn script-includes list [--scope <scope>]` - List script includes
- [ ] `jsn script-includes show [<name>]` - Show script include (picker if omitted)
- [ ] `jsn script-includes code <name>` - Output just the code

### Portals & UX
- [ ] `jsn portals list` - List service portals
- [ ] `jsn portals show [<id>]` - Show portal details (picker if omitted)
- [ ] `jsn portal-widgets list [--portal <id>]` - List widgets
- [ ] `jsn portal-themes list` - List portal themes
- [ ] `jsn forms list [--table <table>]` - List UI forms
- [ ] `jsn forms show <table>` - Show form layout
- [ ] `jsn lists list [--table <table>]` - List UI lists
- [ ] `jsn ui-policies list [--table <table>]` - List UI policies
- [ ] `jsn ui-scripts list [--table <table>]` - List UI scripts
- [ ] `jsn workspaces list` - List workspaces
- [ ] `jsn workspaces show [<name>]` - Show workspace (picker if omitted)

### Attachments
- [ ] `jsn attachments list --table <table> --record <sys_id>` - List attachments
- [ ] `jsn attachments download <sys_id> [--output <path>]` - Download attachment

### Record Commands (Fallback - Lower Priority)
> These enable data manipulation, but 80% of dev/testing works without them

- [ ] `jsn records query <table> [--where <encoded_query>] [--fields <fields>] [--limit <n>]`
- [ ] `jsn records get <table> [<sys_id>]` - Picker if sys_id omitted
- [ ] `jsn records count <table> [--where <encoded_query>]`
- [ ] `jsn records create <table> --data '<json>'`
- [ ] `jsn records update <table> <sys_id> --data '<json>'`
- [ ] `jsn records delete <table> <sys_id> [--force]`

### Developer Experience
- [ ] Add install script
- [ ] Create comprehensive README
- [ ] Add --help --agent structured JSON output
- [ ] Implement tab completion
- [ ] Add `jsn doctor` command for diagnostics

## Design Philosophy

### Separate Concerns
The CLI separates **metadata exploration** from **data manipulation**:

- **Tables**: Discover schema, relationships, columns (read-only metadata)
- **Records**: CRUD operations on actual data (fallback commands)
- **Rules/Flows/Jobs**: Automation logic exploration
- **Portals/Forms**: UI structure understanding

This separation enables 80% of development work (understanding, debugging, exploring) without needing full record CRUD capabilities.

### Interactive Pickers
Commands use `[optional]` syntax to indicate when an interactive picker is available:
```bash
jsn tables show [<name>]      # Opens picker if name not provided
jsn rules show [<id>]         # Opens picker if id not provided
jsn updateset use [<name>]    # Opens picker if name not provided
```

## Design Patterns

### Command Structure
```go
// Tables (metadata)
jsn tables list --search "incident" --limit 20
jsn tables show incident           # Interactive picker if name omitted
jsn tables schema incident
jsn tables columns incident

// Choices (sys_choice)
jsn choices list incident priority
jsn choices create incident priority --value 5 --label "Critical"
jsn choices update <sys_id> --inactive
jsn choices reorder incident priority --mode hundreds

// Records (CRUD)
jsn records query incident --where "active=true" --fields "number,short_description" --limit 10
jsn records get incident 12345     # Interactive picker if sys_id omitted
jsn records create incident --data '{"short_description": "Test", "priority": "1"}'
jsn records update incident 12345 --data '{"state": "2"}'
jsn records delete incident 12345 --force
jsn records count incident --where "active=true"

// Automation
jsn flows list --active
jsn flows show "Flow Name"         # Interactive picker if name omitted
jsn rules list --table incident
jsn rules show <sys_id>            # Interactive picker if id omitted
jsn jobs list --type scheduled
jsn jobs show <sys_id>             # Interactive picker if id omitted

// Update Sets
jsn updateset list --scope myapp --state in_progress
jsn updateset show "Update Set Name"  # Interactive picker if name omitted
jsn updateset use "Update Set Name"   # Interactive picker if name omitted
jsn updateset create "fix-login" --scope myapp
jsn updateset parent child parent     # Interactive picker if args omitted
```

### Output Modes
All commands support:
- `--json` - JSON envelope `{ok, data, summary, breadcrumbs}`
- `--agent` - JSON + quiet (no interactive prompts)
- `--md` - Markdown tables for humans
- `--quiet` - Data only, no envelope
- `--jq <filter>` - Apply jq filter to JSON output

### Success Response Pattern
```go
return outputWriter.OK(data,
    output.WithSummary(fmt.Sprintf("Created record in %s", table)),
    output.WithBreadcrumbs(
        output.Breadcrumb{
            Action: "show",
            Cmd: fmt.Sprintf("jsn tables get %s %s", table, sysID),
            Description: "View record",
        },
        output.Breadcrumb{
            Action: "list",
            Cmd: fmt.Sprintf("jsn tables query %s", table),
            Description: "Query table",
        },
    ),
)
```

### Error Handling
```go
return output.ErrUsage("--data is required")
return output.ErrNotFound(fmt.Sprintf("table '%s' not found", table))
return output.ErrAuth("not authenticated. Run: jsn auth login")
return output.ErrAPI(statusCode, err.Error())
```

## ServiceNow API Reference

### Table API
- GET /api/now/table/{table_name} - List/query records
- GET /api/now/table/{table_name}/{sys_id} - Get single record
- POST /api/now/table/{table_name} - Create record
- PATCH /api/now/table/{table_name}/{sys_id} - Update record
- DELETE /api/now/table/{table_name}/{sys_id} - Delete record

### Query Parameters
- sysparm_query - Encoded query string
- sysparm_fields - Comma-separated field names
- sysparm_limit - Maximum records to return
- sysparm_offset - Pagination offset
- sysparm_orderby - Sort field

### System Tables
- sys_db_object - Tables
- sys_dictionary - Columns/fields
- sys_choice - Choice values
- sys_script - Business rules
- sys_script_include - Script includes
- sys_scope - Scopes
- sys_update_set - Update sets
