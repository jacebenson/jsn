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

### Core Commands (Ready for Use)

#### Foundation
- ✅ `jsn version` - Shows version info
- ✅ `jsn commands` - Lists all commands with metadata
- ✅ `jsn auth login/logout/status` - Authentication management
- ✅ `jsn config add/list/switch` - Profile management
- ✅ `jsn setup` - Interactive first-time setup

#### Tables & Schema
- ✅ `jsn tables list` - List tables with filtering (--app, --search, --show-extends)
- ✅ `jsn tables show [<name>]` - Show table details (picker if omitted)
- ✅ `jsn tables schema [<name>]` - Show inheritance tree view
- ✅ `jsn tables columns [<name>]` - Show columns only

#### Choices Management
- ✅ `jsn choices list <table> <column>` - List choice values
- ✅ `jsn choices create <table> <column>` - Create new choice
- ✅ `jsn choices update <sys_id>` - Update choice
- ✅ `jsn choices delete <sys_id>` - Delete choice
- ✅ `jsn choices reorder <table> <column>` - Reorder choices

#### Records (CRUD)
- ✅ `jsn records query <table> [--where <query>]` - Query records
- ✅ `jsn records list <table>` - List records
- ✅ `jsn records show <table> [<sys_id>]` - Show record (picker if omitted)
- ✅ `jsn records count <table>` - Count records
- ✅ `jsn records create <table> --data '<json>'` - Create record
- ✅ `jsn records update <table> <sys_id> --data '<json>'` - Update record
- ✅ `jsn records delete <table> <sys_id>` - Delete record
- ✅ `jsn records variables <ritm_sys_id>` - Show catalog variables

#### Automation & Logic
- ✅ `jsn flows list [--active]` - List Flow Designer flows
- ✅ `jsn flows show [<name>]` - Show flow details
- ✅ `jsn rules list --table <table>` - List business rules
- ✅ `jsn rules show [<sys_id>]` - Show rule (picker if omitted)
- ✅ `jsn rules script <sys_id>` - Output just the script
- ✅ `jsn jobs list [--type scheduled|script]` - List scheduled jobs
- ✅ `jsn jobs show [<sys_id>]` - Show job details
- ✅ `jsn jobs executions <sys_id>` - Show job execution history
- ✅ `jsn jobs run <sys_id>` - Execute job now

#### UI & Security
- ✅ `jsn ui-policies list --table <table>` - List UI policies
- ✅ `jsn ui-policies show <sys_id>` - Show policy details
- ✅ `jsn ui-policies script <sys_id>` - Output just the script
- ✅ `jsn client-scripts list --table <table>` - List client scripts
- ✅ `jsn client-scripts show <sys_id>` - Show script details
- ✅ `jsn client-scripts script <sys_id>` - Output just the script
- ✅ `jsn acls list --table <table>` - List ACLs
- ✅ `jsn acls check --table <table> --operation <op>` - Test ACL coverage
- ✅ `jsn acls show <sys_id>` - Show ACL details
- ✅ `jsn acls script <sys_id>` - Output just the script

#### Code & Configuration
- ✅ `jsn script-includes list [--scope <scope>]` - List script includes
- ✅ `jsn script-includes show [<name>]` - Show script include
- ✅ `jsn script-includes code <name>` - Output just the code
- ✅ `jsn updateset list` - List update sets
- ✅ `jsn updateset show [<name>]` - Show update set
- ✅ `jsn updateset use [<name>]` - Set current update set
- ✅ `jsn updateset create <name>` - Create update set
- ✅ `jsn updateset parent [<child> <parent>]` - Set parent

#### Service Portal
- ✅ `jsn sp list` - List service portals
- ✅ `jsn sp show [<id>]` - Show portal details
- ✅ `jsn sp-widget list` - List widgets
- ✅ `jsn sp-widget show [<id>]` - Show widget details
- ✅ `jsn sp-page list` - List portal pages
- ✅ `jsn sp-page show [<id>]` - Show page details

#### UI Scripts & Forms
- ✅ `jsn ui-scripts list` - List UI scripts
- ✅ `jsn ui-scripts show <name>` - Show UI script
- ✅ `jsn forms list --table <table>` - List form views
- ✅ `jsn forms show <table> [--view <view>]` - Show form layout

#### Documentation
- ✅ `jsn docs list` - List documentation topics
- ✅ `jsn docs <topic>` - Show documentation
- ✅ `jsn docs search <term>` - Search documentation
- ✅ `jsn docs update` - Refresh documentation cache

### Recent Improvements (2026-03-18)

#### Forms Command Added
- `jsn forms list --table <table>` - Lists form views (Core UI & Workspaces)
- `jsn forms show <table> [--view <view>]` - Shows form layout with sections and fields
- Uses `sys_ui_section` and `sys_ui_element` tables
- Fields displayed in position order
- Handles both Core UI views and Workspace views

#### Service Portal Commands Added
- `jsn sp list` - List service portals
- `jsn sp show [<id>]` - Show portal details
- `jsn sp-widget list/show` - Widget management
- `jsn sp-page list/show` - Portal page management
- `jsn ui-scripts list/show` - UI scripts

#### Records Enhancements
- `--fields` flag for filtering displayed fields
- `jsn records variables <ritm_sys_id>` for catalog variables
- Organized field display by category (Core, People, Status, etc.)

#### Bug Fixes
- ACL display values fixed (operation/type fields)
- `getInt()` helper now handles display_value objects
- Form section ordering (main section first)
- Element position ordering for correct field sequence

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
- [x] Pre-commit hooks with go fmt and go vet

## Still To Do

### UI & Layout (High Priority)
- [ ] `jsn lists list --table <table>` - List UI list layouts
- [ ] `jsn lists show <table> [--view <view>]` - Show list columns
- [ ] `jsn workspaces list` - List workspaces
- [ ] `jsn workspaces show [<name>]` - Show workspace details

### Attachments & Files
- [ ] `jsn attachments list --table <table> --record <sys_id>` - List attachments
- [ ] `jsn attachments download <sys_id> [--output <path>]` - Download attachment

### Developer Experience
- [ ] Add install script
- [ ] Create comprehensive README with examples
- [ ] Implement tab completion (bash/zsh/fish)
- [ ] Add `jsn doctor` command for diagnostics
- [ ] Add `--help --agent` structured JSON output for AI integration

### Future Ideas (Lower Priority)
- Cross-instance comparison commands
- Export/import utilities
- Code generation templates
- Table relationship diagrams
- UI Builder / Next Experience commands
- Batch operations
- Analytics & stats

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
jsn records list incident --where "active=true"
jsn records show incident 12345     # Interactive picker if sys_id omitted
jsn records count incident --query "active=true"
jsn records create incident --data '{"short_description": "Test", "priority": "1"}'
jsn records update incident 12345 --data '{"state": "2"}'
jsn records delete incident 12345 --force

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
            Cmd: fmt.Sprintf("jsn records show %s %s", table, sysID),
            Description: "View record",
        },
        output.Breadcrumb{
            Action: "list",
            Cmd: fmt.Sprintf("jsn records list %s", table),
            Description: "List records",
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

---

## Command Reference

### System Tables Used

| Command Area | Primary Tables |
|--------------|----------------|
| Tables | `sys_db_object`, `sys_dictionary` |
| Choices | `sys_choice` |
| Records | Any table via Table API |
| Flows | `sys_hub_flow` |
| Rules | `sys_script` |
| Jobs | `sysauto_script`, `sys_trigger`, `syslog_transaction` |
| UI Policies | `sys_ui_policy`, `sys_ui_policy_action` |
| Client Scripts | `sys_script_client` |
| ACLs | `sys_security_acl`, `sys_security_acl_role` |
| Script Includes | `sys_script_include` |
| Update Sets | `sys_update_set` |
| Service Portal | `sp_portal`, `sp_widget`, `sp_instance`, `sp_page` |
| UI Scripts | `sys_ui_script` |
| Forms | `sys_ui_section`, `sys_ui_element`, `sys_ui_view` |

### Top Priority for Next Release

Based on **Getting Real** philosophy (solve 80% of pain with 20% effort):

1. **`jsn lists list/show`** - UI list layouts (complement to forms)
2. **`jsn workspaces list/show`** - Workspace views
4. **`jsn open`** - Open records in browser
5. **`jsn doctor`** - Diagnostics for troubleshooting

---

## Additional System Tables Reference

### UI & Forms
- `sys_ui_policy` - UI Policies
- `sys_ui_policy_action` - UI Policy actions
- `sys_script_client` - Client Scripts
- `sys_ui_section` - Form sections
- `sys_ui_element` - Form elements
- `sys_ui_list_element` - List column elements

### Security
- `sys_security_acl` - ACL definitions
- `sys_security_acl_role` - ACL role assignments
- `sys_user_role` - Roles

### Service Portal
- `sp_portal` - Portals
- `sp_widget` - Widgets
- `sp_instance` - Widget instances
- `sp_theme` - Themes
- `sp_css` - CSS includes

### Automation
- `sysauto_script` - Scheduled Scripts
- `sys_trigger` - Scheduled Job triggers
- `sys_hub_flow` - Flow Designer flows
- `sys_hub_action_instance` - Flow actions

### Logs & Debugging
- `syslog` - System logs
- `syslog_transaction` - Transaction logs
- `sys_plugins` - Installed plugins

---

## Architecture Notes

### Documentation Integration (Implemented)
The CLI integrates with sn.jace.pro documentation:
- **Source**: `https://sn.jace.pro/core/assets/js/search_index.json`
- **Cache**: `~/.config/servicenow/docs/` with 24hr TTL
- **Topics**: gliderecord, operators, table-api, glidequery, etc.
- **Offline**: Uses stale cache with warning when offline
