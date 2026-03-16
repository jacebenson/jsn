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

### Testing Coverage (2026-03-16)
All commands tested and working:
- ✅ `jsn version` - Shows version info
- ✅ `jsn commands` - Lists all commands with metadata
- ✅ `jsn auth status` - Shows authentication status
- ✅ `jsn config list` - Lists configured profiles
- ✅ `jsn tables list` - Lists tables from sys_db_object
- ✅ `jsn tables show incident` - Shows table details
- ✅ `jsn tables columns incident` - Lists table columns
- ✅ `jsn acls list --table incident` - Lists ACLs
- ✅ `jsn acls check --table incident --operation read` - Tests ACL coverage
- ✅ `jsn acls show <sys_id>` - Shows ACL details
- ✅ `jsn choices list task state` - Lists choice values
- ✅ `jsn flows list` - Lists Flow Designer flows
- ✅ `jsn rules list --table incident` - Lists business rules
- ✅ `jsn jobs list` - Lists scheduled jobs
- ✅ `jsn script-includes list` - Lists script includes
- ✅ `jsn ui-policies list --table incident` - Lists UI policies
- ✅ `jsn updateset list` - Lists update sets
- ✅ `jsn client-scripts list --table incident` - Lists client scripts
- ✅ `jsn records query incident "active=true"` - Queries records
- ✅ `jsn docs` - Lists documentation topics
- ✅ `jsn docs operators` - Shows documentation from sn.jace.pro
- ✅ `jsn docs search <term>` - Searches documentation

### Recent Improvements (2026-03-16)

#### Records Show --fields Flag
Added `--fields` flag to `jsn records show` command to filter displayed fields:
- Usage: `jsn records show <table> <sys_id> --fields number,state,short_description`
- Useful for viewing sc_req_item and other tables with many fields
- Shows only the fields you care about

#### Records Variables Command
Added `jsn records variables <ritm_sys_id>` command to display ALL catalog variables:
- Shows single-row variables (from sc_item_option)
- Shows multi-row variable sets (from sc_multi_row_question_answer) in table format
- Groups and displays both types in one view

#### Organized Record Display
Modified `jsn records show` to group fields into logical categories:
- Core, People, Request Info, Dates & Times, Status & Approvals, System, Other
- Uncategorized fields sorted alphabetically
- Makes it easier to find important fields

#### ACLs Display Value Fix
Fixed issue where ACL `operation` and `type` fields were empty:
- Root cause: ServiceNow returns these as objects with `display_value`, not strings
- Added `getDisplayValue()` helper in SDK to handle both formats
- Added `sysparm_display_value=true` to ACL queries

#### Documentation
Created `docs/sc_req_item_variables.md` explaining:
- Where ServiceNow stores request item variables
- How to query sc_item_option for variable answers
- How to find multi-row variable set data tables
- Common fields and query patterns

**Test File Created:** `internal/commands/commands_test.go`
- Tests all command constructors
- Tests subcommand existence
- Tests known topics list

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

## Completed ✓ (Recently)

### Flows
- [x] `jsn flows list [--active]` - List flows
- [x] `jsn flows show [<name>]` - Show flow details (picker if omitted)

### Rules  
- [x] `jsn rules list --table <table>` - List business rules
- [x] `jsn rules show [<sys_id>]` - Show business rule (picker if omitted)
- [x] `jsn rules script <sys_id>` - Output just the script

### Jobs
- [x] `jsn jobs list [--type scheduled|script]` - List scheduled/script jobs
- [x] `jsn jobs show [<sys_id>]` - Show job details (picker if omitted)

### UI Policies
- [x] `jsn ui-policies list --table <table>` - List UI policies for a table
- [x] `jsn ui-policies show <sys_id>` - Show UI policy conditions and scripts
- [x] `jsn ui-policies script <sys_id>` - Output just the scripts

### ACLs
- [x] `jsn acls list --table <table>` - List ACLs for a table
- [x] `jsn acls show <sys_id>` - Show ACL details with roles
- [x] `jsn acls script <sys_id>` - Output just the script

### Client Scripts
- [x] `jsn client-scripts list --table <table>` - List client scripts
- [x] `jsn client-scripts show <sys_id>` - Show client script details
- [x] `jsn client-scripts script <sys_id>` - Output just the script

### Docs
- [x] `jsn docs list` - List available documentation topics
- [x] `jsn docs <topic>` - Show documentation for topic (e.g., `jsn docs gliderecord`)
- [x] `jsn docs search <term>` - Search across all documentation
- [x] `jsn docs update` - Force refresh local cache

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

---

## New Command Recommendations (2026-03-16)

Based on sn.jace.pro docs analysis and real developer workflows.

### 🎯 High-Impact Commands (Priority: High)

#### UI Policies & Client Scripts
- [x] `jsn ui-policies list --table <table>` - List UI policies for a table
- [x] `jsn ui-policies show <sys_id>` - Show conditions and scripts
- [x] `jsn ui-policies script <sys_id>` - Output just the script
- [x] `jsn client-scripts list --table <table>` - List client scripts
- [x] `jsn client-scripts show <sys_id>` - Show script details
- [x] `jsn client-scripts script <sys_id>` - Output just the script

**Tables**: `sys_ui_policy`, `sys_ui_policy_action`, `sys_script_client`

#### ACL Exploration
- [x] `jsn acls list --table <table>` - List ACLs for a table
- [x] `jsn acls check --table <table> --operation <read|write|create|delete>` - Test ACL coverage
- [x] `jsn acls show <sys_id>` - Show ACL script and conditions
- [x] `jsn acls script <sys_id>` - Output just the script

**Tables**: `sys_security_acl`, `sys_security_acl_role`

#### Documentation Integration
- [x] `jsn docs <topic>` - Show docs from sn.jace.pro (cached or linked)
  - Topics: `gliderecord`, `operators`, `table-api`, `glidequery`, etc.
- [x] `jsn docs list` - List available documentation topics
- [x] `jsn docs search <term>` - Search documentation
- [x] `jsn docs update` - Force refresh local cache

### 🔍 Debugging & Investigation Commands (Priority: Medium)

#### Enhanced Job Commands
- [ ] `jsn jobs executions <sys_id> [--limit 10]` - Show last N executions
- [ ] `jsn jobs logs <sys_id>` - Get recent job logs
- [ ] `jsn jobs run <sys_id>` - Execute scheduled job now (via API)

**Tables**: `sysauto_script`, `sys_trigger`, `sys_scheduled_job`

#### System Logs
- [ ] `jsn logs --table <table> --sys_id <id>` - Get related logs for a record
- [ ] `jsn logs --source <source> --minutes <n>` - Recent logs by source
- [ ] `jsn logs --script <script_name>` - Script-specific errors
- [ ] `jsn instance info` - Show instance version, plugins, patch level

**Tables**: `syslog`, `syslog_transaction`, `sys_plugins`

#### Flow Designer Debugging
- [ ] `jsn flows executions <flow_name> [--limit 10]` - Show recent flow executions
- [ ] `jsn flows debug <flow_name>` - Show flow with all actions and subflows
- [ ] `jsn flows variables <flow_name>` - Show flow inputs/outputs/schema
- [ ] `jsn flows activate <flow_name>` - Activate flow
- [ ] `jsn flows deactivate <flow_name>` - Deactivate flow

**Tables**: `sys_hub_flow`, `sys_hub_flow_instance`, `sys_hub_action_instance`

### 📦 Migration & Comparison Commands (Priority: High)

#### Cross-Instance Comparison
- [ ] `jsn compare tables --source <profile> --target <profile>` - Compare table schemas
- [ ] `jsn compare script-includes --source <profile> --target <profile>` - Compare scripts
- [ ] `jsn compare choices --table <table> --field <field> --source <profile> --target <profile>`
- [ ] `jsn compare flows --source <profile> --target <profile>`

#### Export/Import Utilities
- [ ] `jsn export script-includes --scope <scope> [--format json|xml]` - Export scripts
- [ ] `jsn export tables --app <app_name>` - Export table definitions
- [ ] `jsn export update-set <name> --format xml` - Export update set as XML
- [ ] `jsn import --file <path> --preview` - Preview import changes

### 🏗️ Development Aid Commands (Priority: Medium)

#### Code Generation
- [ ] `jsn generate gliderecord --table <table>` - Generate GlideRecord template
- [ ] `jsn generate script-include --name <name> [--scope <scope>]` - Generate Script Include template
- [ ] `jsn generate rest --name <name>` - Generate Scripted REST API template
- [ ] `jsn generate test --table <table> --count <n>` - Generate test data
- [ ] `jsn generate acl --table <table> --operation <op>` - Generate ACL template

#### Table Relationships & Data Model
- [ ] `jsn tables relationships <table>` - Show reference fields TO this table
- [ ] `jsn tables dependencies <table>` - Show what tables reference this one
- [ ] `jsn tables diagram <table> [--format mermaid|dot]` - Generate relationship diagram

**Tables**: `sys_dictionary` (where internal_type = 'reference')

#### Form & List Layouts
- [ ] `jsn forms list --table <table>` - List form sections and fields
- [ ] `jsn forms show <table> [--view <view_name>]` - Show form layout
- [ ] `jsn lists list --table <table>` - List list layouts
- [ ] `jsn lists show <table> [--view <view_name>]` - Show list columns

**Tables**: `sys_ui_section`, `sys_ui_element`, `sys_ui_list_element`

### 🎨 Service Portal Commands (Priority: Medium)

#### Service Portal Management
- [ ] `jsn portals list` - List Service Portals
- [ ] `jsn portals show [<portal_id>]` - Show portal config and pages
- [ ] `jsn portals clone <source_id> <new_id>` - Clone a portal

#### Widget Commands
- [ ] `jsn widgets list [--portal <id>]` - List widgets (SP or global)
- [ ] `jsn widgets show [<widget_id>]` - Show widget details
- [ ] `jsn widgets code <widget_id>` - Output widget HTML/CSS/Client/Server scripts
- [ ] `jsn widgets create <name>` - Create new widget template
- [ ] `jsn widgets test <widget_id>` - Show test data options

#### Portal Themes
- [ ] `jsn themes list [--portal <id>]` - List themes
- [ ] `jsn themes show <theme_id>` - Show theme CSS and variables

**Tables**: `sp_portal`, `sp_widget`, `sp_instance`, `sp_theme`, `sp_css`

### 🖥️ UI Builder / Next Experience Commands (Priority: Medium)

- [ ] `jsn ui-builder pages list [--workspace <name>]` - List UI Builder pages
- [ ] `jsn ui-builder pages show <page_id>` - Show page components and layout
- [ ] `jsn ui-builder components list [--custom-only]` - List custom components
- [ ] `jsn ui-builder variables list --page <id>` - List client state parameters
- [ ] `jsn ui-builder events list --page <id>` - List page events

**Tables**: `sys_ux_page`, `sys_ux_macroponent`, `sys_ux_client_script`

### 💡 Smart Utilities (Priority: Medium)

#### Query Builder
- [ ] `jsn query encode --table <table> --field "priority=1" --field "stateIN1,2"` - Build encoded query
- [ ] `jsn query decode "priority=1^stateIN1,2"` - Decode query to human-readable
- [ ] `jsn query validate --table <table> "<encoded_query>"` - Validate query syntax

#### Record Navigation
- [ ] `jsn open incident <number>` - Open record in browser
- [ ] `jsn open table <table> --record <sys_id>` - Open any record
- [ ] `jsn open list <table> --query "<encoded_query>"` - Open filtered list
- [ ] `jsn open form <table> --designer` - Open in Form Designer

#### Batch Operations
- [ ] `jsn batch query <table> --query "<encoded>" --action export --format csv`
- [ ] `jsn batch update <table> --query "<encoded>" --set "field=value" [--dry-run]`
- [ ] `jsn batch delete <table> --query "<encoded>" [--dry-run]`
- [ ] `jsn batch count <table> --query "<encoded>"` - Quick count

**API**: Table API with batching, potentially Attachment API for exports

### 📊 Analytics & Reporting Commands (Priority: Low)

- [ ] `jsn stats tables --top 20` - Top 20 tables by row count
- [ ] `jsn stats scripts --by-author` - Script includes by author
- [ ] `jsn stats flows --by-status` - Flows by active/inactive status
- [ ] `jsn stats jobs --runtime` - Scheduled job average runtimes
- [ ] `jsn stats instance --size` - Instance storage usage

**Tables**: `sys_db_stats`, `sys_table_size`, custom aggregation queries

---

### Top 5 Priority Commands

Based on **Getting Real** philosophy (solve 80% of pain with 20% effort):

1. ✅ **`jsn ui-policies list --table <table>`** - Daily debugging need
2. ✅ **`jsn acls list --table <table>`** - Security debugging is constant
3. ✅ **`jsn client-scripts list --table <table>`** - Client-side debugging
4. ✅ **`jsn docs <topic>`** - Surface sn.jace.pro content in CLI
5. **`jsn query encode/decode`** - Your docs have great operator reference, make it executable

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

## Documentation Integration (sn.jace.pro)

### Overview
Integrate with sn.jace.pro documentation site to provide CLI access to ServiceNow API docs.

### Data Source
- **Primary**: `https://sn.jace.pro/core/assets/js/search_index.json` (330KB)
  - Contains all pages with titles, descriptions, and content
  - Updated automatically when site rebuilds
- **Individual docs**: `https://sn.jace.pro/docs/{topic}.md`
  - Raw markdown with frontmatter
  - AI-optimized format

### Commands
- [ ] `jsn docs list` - List available documentation topics
- [ ] `jsn docs <topic>` - Show documentation for topic (e.g., `jsn docs gliderecord`)
- [ ] `jsn docs search <term>` - Search across all documentation
- [ ] `jsn docs update` - Force refresh local cache

### Implementation Plan
1. **Fetcher** (`internal/docs/fetcher.go`)
   - Fetch search_index.json from sn.jace.pro
   - Cache locally with 24hr TTL
   - Offline fallback support
   
2. **Parser** (`internal/docs/parser.go`)
   - Parse markdown frontmatter
   - Extract methods from tables
   - Parse code examples
   
3. **Display** (`internal/commands/docs.go`)
   - Styled terminal output (lipgloss)
   - Method tables with categories
   - Copy-to-clipboard for examples
   - --json and --md output modes

### Topics to Include
- API Reference: gliderecord, glidequery, glideaggregate, gliderecordsecure
- Operators: operators (query operators reference)
- Client-side: glideform, glideuser, glideajax
- Server-side: glidesystem, glideelement, glidedatetime
- REST: restmessagev2, restapirequest, restapiresponse

### Caching Strategy
- Cache dir: `~/.config/servicenow/docs/`
- search_index.json: 24hr TTL
- Individual .md files: 24hr TTL
- Offline mode: Use stale cache with warning

### Priority
Medium - Enhances developer experience without blocking core functionality
