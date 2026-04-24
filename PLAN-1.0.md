# JSN CLI 1.0 Rewrite Plan

## Executive Summary

Rewrite the jsn CLI from scratch using [basecamp-cli](https://github.com/basecamp/basecamp-cli) as the architectural template. The current codebase has become a mess from multiple half-started efforts. This plan provides a clean slate with clear separation of concerns.

## Guiding Principles (from basecamp-cli)

1. **Commands are actions, not objects** - `jsn incidents create` not `jsn incidents --create`
2. **Work vs Dev separation** - Day-to-day work at top level, platform config under `jsn dev`
3. **Generic Table API for most things** - Don't create SDK files for simple CRUD
4. **Comprehensive tests with mocks** - Every command tested like basecamp-cli
5. **Agent-first design** - Built for AI agents to consume safely

## Project Structure

```
cmd/jsn/
├── main.go                    # Entry point

internal/
├── appctx/                    # Application context (from basecamp)
│   └── app.go                 # App struct with Config, Auth, SDK, Output
├── auth/                      # Authentication management
│   └── auth.go
├── commands/                  # Top-level work commands
│   ├── incidents.go           # IT incidents (inc, incident)
│   ├── changes.go             # Change requests (chg, change)
│   ├── requests.go            # Service catalog requests (req, ritm)
│   ├── tasks.go               # SC tasks (task)
│   ├── users.go               # User management
│   ├── groups.go              # Group management
│   ├── records.go             # Generic Table API fallback
│   ├── dev.go                 # Dev command group
│   └── dev/                   # Dev subcommands
│       ├── scriptincludes.go
│       ├── businessrules.go
│       ├── flows.go
│       ├── updatesets.go
│       ├── scopes.go
│       └── ...
├── config/                    # Configuration management
│   └── config.go
├── helpers/                   # Shared helper functions
│   └── helpers.go             # GetStringField, FormatValue, etc.
├── output/                    # Output formatting
│   └── output.go              # JSON, Markdown, styled output
├── sdk/                       # ServiceNow SDK
│   ├── client.go              # Generic Table API client
│   ├── flows.go               # Flow Designer (non-Table API)
│   └── updatesets.go          # Update sets (special handling)
└── tui/                       # Terminal UI components
    └── picker.go              # Interactive picker
```

## Phase 1: Foundation (Week 1)

### 1.1 Authentication (ServiceNow OAuth)

**Simplified Approach: OAuth Only**

Unlike basecamp-cli which supports multiple auth methods, we'll simplify to OAuth only for ServiceNow:

```bash
# Login flow
$ jsn auth login
# Opens browser to ServiceNow OAuth consent screen
# User authorizes app
# CLI receives and stores access token

# Check status
$ jsn auth status
# Shows: Logged in as john.doe@example.com to https://instance.service-now.com

# Logout
$ jsn auth logout
```

**Implementation:**

```go
// internal/auth/auth.go
package auth

import (
    "context"
    "fmt"
    "os/exec"
    "runtime"
)

// Manager handles ServiceNow OAuth
type Manager struct {
    tokenPath string
}

// Login initiates OAuth flow and stores token
func (m *Manager) Login(ctx context.Context, instanceURL string) error {
    // 1. Generate OAuth state and PKCE verifier
    // 2. Open browser to ServiceNow OAuth authorize URL
    // 3. Start local callback server (localhost:8765)
    // 4. Exchange code for access token
    // 5. Store token in ~/.config/servicenow/token.json
}

// GetToken returns stored OAuth token
func (m *Manager) GetToken() (string, error) {
    // Read from secure storage
}

// Logout removes stored credentials
func (m *Manager) Logout() error {
    // Delete token file
}
```

**OAuth Flow:**

1. CLI generates PKCE code verifier + challenge
2. Opens browser: `https://instance.service-now.com/oauth_auth.do?...`
3. User approves in browser
4. ServiceNow redirects to `http://localhost:8765/callback?code=...`
5. CLI exchanges code for access token
6. Stores token for future use

**Token Storage:**
- Platform keychain/credential manager preferred
- Fallback to `~/.config/servicenow/credentials.json` with 0600 permissions

**Differences from basecamp-cli:**
- basecamp uses API tokens (simpler)
- ServiceNow uses OAuth 2.0 (more complex but standard)
- We'll implement OAuth once and be done

### 1.2 Bootstrap from basecamp-cli

Copy the foundational structure:
- `internal/appctx/` - Application context pattern
- `internal/output/` - Output formatting with JSON/Markdown/styled
- `internal/auth/` - Authentication management
- `internal/config/` - Configuration
- Test infrastructure with mock transports

### 1.2 Core SDK

Create a **single generic Table API client**:

```go
// sdk/client.go
package sdk

type Client struct {
    baseURL string
    httpClient *http.Client
    getAuth func() (token, username, method string)
}

// Generic CRUD operations
func (c *Client) List(table string, query url.Values) ([]map[string]interface{}, error)
func (c *Client) Get(table, sysID string) (map[string]interface{}, error)
func (c *Client) GetByNumber(table, number string) (map[string]interface{}, error)
func (c *Client) Create(table string, data map[string]interface{}) (map[string]interface{}, error)
func (c *Client) Update(table, sysID string, data map[string]interface{}) error
func (c *Client) Delete(table, sysID string) error

// Special handling for non-Table API
func (c *Client) ListFlows() ([]Flow, error)
func (c *Client) SetUpdateSet(sysID string) error
```

**Rule**: Only create special SDK methods when the Table API can't handle it (flows, update sets, scopes).

### 1.3 Test Infrastructure

From basecamp-cli:
- `setupTestApp()` - Create test app with mock transport
- `executeCommand()` - Execute cobra commands in tests
- `mockTransport` - HTTP transport for mocking ServiceNow responses
- Pattern: Every command has `Test<Command>Cmd`, `Test<Command>Integration`

## Phase 2: Work Commands (Week 2)

These are day-to-day ServiceNow operations:

### 2.1 Incidents
```bash
jsn incidents                    # List with interactive picker
jsn incidents INC0010001         # Show incident
jsn incidents create             # Create new incident
jsn incidents update INC0010001  # Update incident
jsn incidents delete INC0010001  # Delete incident
```

### 2.2 Changes
```bash
jsn changes                      # List change requests
jsn changes CHG0010001           # Show change
jsn changes create               # Create change
```

### 2.3 Requests
```bash
jsn requests                     # List service catalog requests
jsn requests RITM0010001         # Show request item
```

### 2.4 Tasks
```bash
jsn tasks                        # List tasks
jsn tasks SCTASK0010001          # Show task
```

### 2.5 Users & Groups
```bash
jsn users                        # List users
jsn users "John Doe"             # Find user
jsn groups                       # List groups
```

### 2.6 Generic Fallback
```bash
jsn records --table cmdb_ci      # Query any table
jsn records --table incident --query "priority=1"
```

**Implementation Pattern**:
```go
func NewIncidentsCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "incidents [number]",
        Short: "Manage IT incidents",
        Long:  "...",
    }
    
    cmd.AddCommand(newIncidentsListCmd())
    cmd.AddCommand(newIncidentsCreateCmd())
    cmd.AddCommand(newIncidentsUpdateCmd())
    cmd.AddCommand(newIncidentsDeleteCmd())
    
    return cmd
}
```

## Phase 3: Dev Commands (Week 3)

Platform configuration under `jsn dev`:

### 3.1 Scripts & Logic
```bash
jsn dev scriptincludes           # Script includes
jsn dev businessrules            # Business rules
jsn dev clientscripts            # Client scripts
```

### 3.2 Flows
```bash
jsn dev flows                    # Flow Designer flows
jsn dev flows create             # Create flow
jsn dev flows run "My Flow"      # Execute flow
```

### 3.3 Platform Config
```bash
jsn dev updatesets               # Update sets
jsn dev scopes                   # Application scopes
jsn dev tables                   # Table definitions
```

### 3.4 Tools
```bash
jsn dev logs                     # System logs
jsn dev rest                     # Raw REST API
jsn dev eval                     # Background scripts
```

## Phase 4: Testing Strategy

Every command MUST have:

### 4.1 Structure Tests
```go
func TestIncidentsCmd(t *testing.T) {
    cmd := NewIncidentsCmd()
    assert.NotNil(t, cmd)
    assert.Contains(t, cmd.Use, "incidents")
    assert.Equal(t, []string{"inc", "incident"}, cmd.Aliases)
}
```

### 4.2 Integration Tests with Mocks
```go
func TestIncidentsListIntegration(t *testing.T) {
    transport := &mockTransport{
        responseStatus: 200,
        responseBody: `{"result": [{"number": "INC001"}]}`,
    }
    
    app, _ := setupTestAppWithTransport(t, transport)
    cmd := NewIncidentsCmd()
    err := executeCommand(cmd, app)
    
    assert.NoError(t, err)
    assert.Contains(t, transport.capturedPath, "/api/now/table/incident")
}
```

### 4.3 Validation Tests
```go
func TestIncidentsCreateRequiresShortDescription(t *testing.T) {
    app, _ := setupTestApp(t)
    cmd := NewIncidentsCmd()
    err := executeCommand(cmd, app, "create")
    
    assert.Error(t, err)
    assert.Contains(t, err.Error(), "short-description")
}
```

## Phase 5: Documentation & Polish (Week 4)

### 5.1 README
- Quick start
- Command reference
- Authentication setup

### 5.2 Agent Documentation
- How AI agents should use the CLI
- Common workflows
- Error handling

### 5.3 Examples
- Shell scripts for common operations
- CI/CD integration examples

---

## Incremental Command Development (The PR #261 Pattern)

Just like PR #261 in basecamp-cli added the `accounts` command as a single, complete PR, each jsn command should be added incrementally with:

1. **The command implementation**
2. **The tests**
3. **Registration in root.go**
4. **Registration in command catalog**

### Example: Adding the `incidents` Command

**Step 1: Create the command file**

```go
// internal/commands/incidents.go
package commands

import (
	"github.com/spf13/cobra"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

func NewIncidentsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "incidents [number]",
		Aliases: []string{"incident", "inc"},
		Short:   "Manage IT incidents",
		Long:    "Create, view, and manage ServiceNow incidents.",
	}

	cmd.AddCommand(
		newIncidentsListCmd(),
		newIncidentsCreateCmd(),
		newIncidentsUpdateCmd(),
		newIncidentsDeleteCmd(),
	)

	return cmd
}

func newIncidentsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List incidents",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			records, err := app.SDK.List("incident", nil)
			if err != nil {
				return err
			}
			return app.OK(records)
		},
	}
}
// ... other subcommands
```

**Step 2: Create the test file**

```go
// internal/commands/incidents_test.go
package commands

import (
	"testing"
	"github.com/stretchr/testify/assert"
	"io"
	"net/http"
	"strings"
)

// Mock transport
func TestIncidentsCmd(t *testing.T) {
	cmd := NewIncidentsCmd()
	assert.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "incidents")
}

func TestIncidentsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseBody: `{"result": [{"number": "INC001"}]}`,
		responseStatus: 200,
	}
	app, _ := setupTestAppWithTransport(t, transport)
	
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "list")
	
	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/incident")
}
```

**Step 3: Register in root.go**

```go
// internal/cli/root.go
func Execute() {
	cmd := NewRootCmd()
	cmd.AddCommand(commands.NewIncidentsCmd())  // Add this line
	// ... other commands
}
```

**Step 4: Register in command catalog**

```go
// internal/commands/commands.go
func CommandCategories() []CommandCategory {
	return []CommandCategory{
		{
			Name: "Work",
			Commands: []CommandInfo{
				{Name: "incidents", Category: "work", Description: "Manage incidents"},
				// ... other commands
			},
		},
	}
}
```

**Step 5: Run tests**

```bash
cd /home/jace/git/CLIs/jsn-v1.0
go test ./internal/commands/... -run TestIncidents -v
```

**Step 6: Commit**

```bash
git add .
git commit -m "Add incidents command with tests

- List incidents with table output
- Create, update, delete subcommands
- Full test coverage with mock transport
- Registered in root and command catalog"
```

### Command Development Checklist

For each new command:

- [ ] Command file created (`internal/commands/<command>.go`)
- [ ] Test file created (`internal/commands/<command>_test.go`)
- [ ] Tests pass (`go test ./internal/commands/... -run Test<Command>`)
- [ ] Registered in `internal/cli/root.go`
- [ ] Registered in `internal/commands/commands.go`
- [ ] Help text is clear (`jsn <command> --help`)
- [ ] Examples work (manual test)

### PR Structure per Command

Each command should be a complete, reviewable PR:

```
PR: Add incidents command

- Implements list, show, create, update, delete
- Full test coverage with mock HTTP
- JSON and styled output support
- Breadcrumbs for navigation

Files changed:
- internal/commands/incidents.go (200 lines)
- internal/commands/incidents_test.go (150 lines)
- internal/cli/root.go (+1 line)
- internal/commands/commands.go (+5 lines)
```

This mirrors how basecamp-cli PR #261 added the accounts command in a single, focused PR.

---

## Using Subagents with Worktrees

When using AI assistants (like OpenCode) to help with the rewrite:

### For AI Sessions

1. **Start in the v1.0 worktree**
   ```bash
   cd /home/jace/git/CLIs/jsn-v1.0
   ```

2. **Reference original code when needed**
   - "Check how the original incidents command handles pagination in `/home/jace/git/CLIs/jsn/internal/commands/incidents.go`"
   - "Copy the table schema lookup from the original but clean it up"

3. **Reference basecamp-cli patterns**
   - "Follow the test pattern from `/home/jace/git/CLIs/basecamp-cli/internal/commands/todos_test.go`"
   - "Use the same mock transport approach as basecamp-cli"

4. **Parallel development with subagents**
   - Subagent 1: Work on incidents command in jsn-v1.0
   - Subagent 2: Work on changes command in jsn-v1.0
   - Subagent 3: Set up test infrastructure
   - They can all reference the original jsn/ and basecamp-cli/ directories

### Subagent Task Examples

```
Task 1: Create incidents command
- Work in /home/jace/git/CLIs/jsn-v1.0
- Follow basecamp-cli patterns
- Reference /home/jace/git/CLIs/basecamp-cli/internal/commands/todos.go
- Create: incidents.go, incidents_test.go

Task 2: Create SDK client
- Work in /home/jace/git/CLIs/jsn-v1.0
- Follow basecamp-cli SDK patterns
- Reference /home/jace/git/CLIs/basecamp-cli/internal/sdk/
- Create: sdk/client.go with generic Table API

Task 3: Create test infrastructure
- Work in /home/jace/git/CLIs/jsn-v1.0
- Copy from basecamp-cli
- Create: internal/commands/testutil_test.go
```

All subagents can:
- Read from `jsn/` (original code)
- Read from `basecamp-cli/` (reference patterns)
- Write to `jsn-v1.0/` (new code)

## Migration Guide

### From Old jsn to New jsn

| Old Command | New Command |
|------------|-------------|
| `jsn records --table incident` | `jsn incidents` |
| `jsn script-includes` | `jsn dev scriptincludes` |
| `jsn rules` | `jsn dev rules` |
| `jsn flows` | `jsn dev flows` |
| `jsn updateset` | `jsn dev updatesets` |

## Key Decisions

### Why Basecamp-CLI Pattern?

1. **Proven at scale** - Basecamp uses this for production
2. **AI-friendly** - Clear command structure, comprehensive tests
3. **Maintainable** - Clear separation of concerns
4. **Testable** - Mock HTTP pattern is solid

### Why Separate Work vs Dev?

- **Different audiences** - Service desk vs developers
- **Different frequencies** - Daily vs occasional
- **Different mental models** - "My tickets" vs "platform config"

### Why Generic Table API?

- **ServiceNow is just tables** - 95% of operations are Table API
- **Less code** - One client vs 50 SDK files
- **More flexible** - Works with any custom table

## Success Criteria

- [ ] All work commands (incidents, changes, requests, tasks) implemented
- [ ] All dev commands (scriptincludes, flows, updatesets, etc.) implemented
- [ ] Every command has tests with mock HTTP
- [ ] Build passes with no errors
- [ ] Test coverage > 80%
- [ ] Documentation complete
- [ ] Migration guide provided

## Appendix: File Structure Comparison

### Current (Messy)
```
internal/commands/
├── incidents.go          # OK
├── script-includes.go    # Should be in dev/
├── rules.go              # Should be in dev/
├── flows.go              # Should be in dev/
├── records.go            # OK
└── dev/
    ├── scriptincludes.go # Duplicate?
    └── ...

internal/sdk/
├── script_includes.go    # Unnecessary - Table API
├── rules.go              # Unnecessary - Table API
├── flows.go              # OK - special handling
└── 30+ other files       # Mostly unnecessary
```

### Target (Clean)
```
internal/commands/
├── incidents.go          # Work command
├── changes.go            # Work command
├── requests.go           # Work command
├── records.go            # Generic fallback
└── dev/
    ├── scriptincludes.go # Dev command
    ├── flows.go          # Dev command (special)
    └── updatesets.go     # Dev command (special)

internal/sdk/
├── client.go             # Generic Table API
├── flows.go              # Flow Designer only
└── updatesets.go         # Update sets only
```

## Development Workflow with Git Worktrees

Since this is a complete rewrite while keeping the original code accessible, use git worktrees:

### Setup Worktrees

```bash
# From the main jsn repo
cd /home/jace/git/CLIs/jsn

# Create a worktree for the v1.0 rewrite
git worktree add ../jsn-v1.0 v1.0-rewrite

# Now you have two directories:
# /home/jace/git/CLIs/jsn        - Original code (messy but working)
# /home/jace/git/CLIs/jsn-v1.0   - Clean rewrite

# Clone basecamp-cli for reference
git clone https://github.com/basecamp/basecamp-cli.git ../basecamp-cli
```

### Workflow

```bash
# Terminal 1: Reference original code
cd /home/jace/git/CLIs/jsn
# Look up how things work, copy useful snippets

# Terminal 2: Reference basecamp-cli patterns
cd /home/jace/git/CLIs/basecamp-cli
# Study their structure, test patterns

# Terminal 3: Do the rewrite
cd /home/jace/git/CLIs/jsn-v1.0
# Write new code following basecamp patterns
```

### Basecamp-CLI Command Addition Pattern

From analyzing PR #261 (accounts command) and other PRs, here's the exact pattern for adding a command:

**6 Files Changed:**

1. **`.surface`** - Metadata file (optional for jsn)
2. **`internal/cli/root.go`** - Register the command
3. **`internal/commands/<command>.go`** - The actual command
4. **`internal/commands/commands.go`** - Add to command catalog
5. **`internal/commands/commands_test.go`** - Add to test catalog
6. **`internal/tui/resolve/<resource>.go`** - TUI resolver (optional)

**Command Structure Pattern:**

```go
// internal/commands/<command>.go
func New<Command>Cmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:     "<command>",
        Aliases: []string{"<alias>"},
        Short:   "Short description",
        Long:    "Long description",
    }

    cmd.AddCommand(
        new<Command>ListCmd(),
        new<Command>CreateCmd(),
        // ... other subcommands
    )

    return cmd
}

func new<Command>ListCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "list",
        Short: "List <resources>",
        RunE: func(cmd *cobra.Command, args []string) error {
            app := appctx.FromContext(cmd.Context())
            if app == nil {
                return fmt.Errorf("app not initialized")
            }

            // Fetch data using SDK
            data, err := app.SDK.List("table_name")
            if err != nil {
                return err
            }

            // Return output with breadcrumbs
            return app.OK(data,
                output.WithSummary(fmt.Sprintf("%d items", len(data))),
                output.WithBreadcrumbs(
                    output.Breadcrumb{
                        Action:      "create",
                        Cmd:         "jsn <command> create",
                        Description: "Create new item",
                    },
                ),
            )
        },
    }

    return cmd
}
```

**Test Pattern:**

```go
// internal/commands/<command>_test.go
type mock<Command>Transport struct {
    capturedPath   string
    capturedQuery  string
    capturedBody   []byte
    responseBody   string
    responseStatus int
}

func (m *mock<Command>Transport) RoundTrip(req *http.Request) (*http.Response, error) {
    m.capturedPath = req.URL.Path
    m.capturedQuery = req.URL.RawQuery
    
    if req.Body != nil {
        body, _ := io.ReadAll(req.Body)
        m.capturedBody = body
        req.Body.Close()
    }
    
    return &http.Response{
        StatusCode: m.responseStatus,
        Body:       io.NopCloser(strings.NewReader(m.responseBody)),
        Header:     http.Header{"Content-Type": []string{"application/json"}},
    }, nil
}

func Test<Command>Cmd(t *testing.T) {
    cmd := New<Command>Cmd()
    assert.NotNil(t, cmd)
    assert.Contains(t, cmd.Use, "<command>")
    assert.Equal(t, []string{"<alias>"}, cmd.Aliases)
}

func Test<Command>ListIntegration(t *testing.T) {
    transport := &mock<Command>Transport{
        responseStatus: 200,
        responseBody:   `{"result": [{"sys_id": "123", "name": "Test"}]}`,
    }
    
    app, _ := setupTestAppWithTransport(t, transport)
    cmd := New<Command>Cmd()
    err := executeCommand(cmd, app)
    
    assert.NoError(t, err)
    assert.Contains(t, transport.capturedPath, "/api/now/table/<table>")
}
```

### Branch Strategy

```bash
# In jsn-v1.0 directory
git checkout -b v1.0-rewrite

# As you complete phases:
git add .
git commit -m "Phase 1: Foundation - base structure from basecamp-cli"

# When ready to merge back:
git checkout main
git merge v1.0-rewrite
```

### Keeping Original Code Safe

The original code in `/home/jace/git/CLIs/jsn` remains untouched and functional while you work on the rewrite. This means:

1. You can still build and run the original CLI
2. You can reference working code while writing new code
3. No risk of breaking existing functionality
4. Easy comparison between old and new approaches

## Next Steps

1. **Setup worktrees** (5 minutes)
   ```bash
   git worktree add ../jsn-v1.0 v1.0-rewrite
   git clone https://github.com/basecamp/basecamp-cli.git ../basecamp-cli
   ```

2. **Phase 1: Foundation** (Week 1)
   - In `jsn-v1.0` directory
   - Copy basecamp-cli structure
   - Create internal/appctx, internal/output, internal/sdk
   - Set up test infrastructure

3. **Phase 2: Work Commands** (Week 2)
   - Build incidents, changes, requests, tasks
   - Each with tests

4. **Phase 3: Dev Commands** (Week 3)
   - Build dev command group
   - Add scriptincludes, flows, updatesets

5. **Phase 4: Testing & Polish** (Week 4)
   - Comprehensive tests
   - Documentation

6. **Merge** (When ready)
   - Merge v1.0-rewrite back to main
   - Remove old code
   - Archive original branch

---

**Note**: This is a complete rewrite. Do not try to migrate old code - start fresh and copy patterns from basecamp-cli. Refer to the original code in the `jsn` worktree when needed, but write everything fresh in `jsn-v1.0`.
