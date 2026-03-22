# JSN CLI Command Implementation Guide

This guide documents how commands are implemented in the JSN CLI. Use it as a reference when creating new commands or modifying existing ones.

## Table of Contents

- [Overview](#overview)
- [File Structure](#file-structure)
- [Command Architecture](#command-architecture)
- [Creating a New Command](#creating-a-new-command)
- [Patterns and Utilities](#patterns-and-utilities)
- [Output Formatting](#output-formatting)
- [Conventions](#conventions)
- [Examples](#examples)

---

## Overview

JSN is built with [Cobra](https://github.com/spf13/cobra), a Go CLI framework. Commands are modular, each in their own file under `internal/commands/`.

Key principles:
- Commands are registered in `internal/cli/root.go`
- All commands receive an app context with Config, Auth, SDK, and Output
- Support multiple output formats: styled (TTY), JSON, Markdown, quiet
- Interactive mode when running in a terminal

---

## File Structure

```
jsn/
├── cmd/jsn/main.go              # Entry point
├── internal/
│   ├── cli/
│   │   └── root.go              # Root command, global flags, registration
│   ├── commands/                 # Command implementations
│   │   ├── commands.go          # Command catalog metadata
│   │   ├── query.go             # Shared query helpers
│   │   ├── tables.go            # Example: command with subcommands
│   │   ├── records.go           # Example: CRUD operations
│   │   ├── auth.go              # Example: auth command group
│   │   └── version.go           # Example: simple command
│   ├── appctx/context.go        # Application context
│   ├── auth/                    # Authentication
│   ├── config/                  # Configuration
│   ├── output/output.go         # Output formatting
│   ├── sdk/client.go            # ServiceNow API client
│   └── tui/picker.go            # Interactive picker
```

---

## Command Architecture

### 1. Entry Point (`cmd/jsn/main.go`)

```go
package main

import (
    "fmt"
    "os"
    "github.com/jacebenson/jsn/internal/cli"
)

func main() {
    if err := cli.Execute(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}
```

### 2. Root Command (`internal/cli/root.go`)

The root command:
- Defines global flags (`--json`, `--md`, `--quiet`, `--profile`, etc.)
- Initializes app context in `PersistentPreRunE`
- Registers all subcommands

### 3. App Context

Commands access shared dependencies through the app context:

```go
appCtx := appctx.FromContext(cmd.Context())

// Available fields:
appCtx.Config  // Configuration
appCtx.Auth    // Authentication manager
appCtx.Output  // Output writer
appCtx.SDK     // ServiceNow API client
appCtx.Flags   // Global flag values
```

---

## Creating a New Command

### Step 1: Create the Command File

Create `internal/commands/mycommand.go`:

```go
package commands

import (
    "fmt"
    
    "github.com/jacebenson/jsn/internal/appctx"
    "github.com/jacebenson/jsn/internal/output"
    "github.com/jacebenson/jsn/internal/sdk"
    "github.com/spf13/cobra"
)

// NewMyCommandCmd creates the mycommand command.
// Exported (uppercase) because it's registered in root.go
func NewMyCommandCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "mycommand",
        Short: "One-line description",
        Long: `Detailed description with examples.

Examples:
  jsn mycommand --flag value
  jsn mycommand arg1 arg2`,
        RunE: func(cmd *cobra.Command, args []string) error {
            return runMyCommand(cmd, args)
        },
    }

    // Add command-specific flags here
    cmd.Flags().StringP("name", "n", "", "Name to use")
    cmd.Flags().Bool("verbose", false, "Verbose output")

    return cmd
}

func runMyCommand(cmd *cobra.Command, args []string) error {
    // 1. Get app context
    appCtx := appctx.FromContext(cmd.Context())
    if appCtx == nil {
        return fmt.Errorf("app not initialized")
    }

    // 2. Check authentication if needed
    if appCtx.SDK == nil {
        return output.ErrAuth("no instance configured. Run: jsn setup")
    }

    // 3. Get flag values
    name, _ := cmd.Flags().GetString("name")

    // 4. Get typed dependencies
    outputWriter := appCtx.Output.(*output.Writer)
    sdkClient := appCtx.SDK.(*sdk.Client)

    // 5. Implement your logic
    result, err := sdkClient.DoSomething(cmd.Context(), name)
    if err != nil {
        return fmt.Errorf("failed to do something: %w", err)
    }

    // 6. Output the result
    return outputWriter.OK(result, output.WithSummary("Success"))
}
```

### Step 2: Register the Command

In `internal/cli/root.go`, add to the appropriate section:

```go
// ─── My Category ────────────────────────────────────────────────────────
root.AddCommand(commands.NewMyCommandCmd())
```

### Step 3: Add to Command Catalog (Optional)

In `internal/commands/commands.go`, add metadata:

```go
{
    Name:        "mycommand",
    Category:    "Category Name",
    Summary:     "Short description",
    Description: "Longer description of what it does",
    Examples: []string{
        "jsn mycommand --flag value",
    },
},
```

---

## Command with Subcommands

For commands that have subcommands (like `jsn tables list`, `jsn tables show`):

```go
package commands

// Parent command - exported
func NewThingsCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "things",
        Short: "Manage things",
        Long:  "List and inspect things.",
    }

    // Register subcommands
    cmd.AddCommand(
        newThingsListCmd(),
        newThingsShowCmd(),
        newThingsCreateCmd(),
    )

    return cmd
}

// Subcommand - unexported (lowercase)
func newThingsListCmd() *cobra.Command {
    var flags thingsListFlags

    cmd := &cobra.Command{
        Use:   "list",
        Short: "List things",
        RunE: func(cmd *cobra.Command, args []string) error {
            return runThingsList(cmd, flags)
        },
    }

    cmd.Flags().IntVarP(&flags.limit, "limit", "n", 100, "Max results")
    cmd.Flags().StringVar(&flags.search, "search", "", "Search term")

    return cmd
}

// Flags struct for organization
type thingsListFlags struct {
    limit  int
    search string
}

func runThingsList(cmd *cobra.Command, flags thingsListFlags) error {
    // Implementation
}
```

---

## Patterns and Utilities

### Error Handling

Use typed error functions for consistent formatting:

```go
output.ErrUsage("table name is required")        // Usage error
output.ErrAuth("no instance configured")         // Authentication error
output.ErrNotFound("profile 'foo' not found")   // Not found error
output.ErrAPI(500, "server error")              // API error with status
output.ErrNetwork(err)                          // Network error
```

### Interactive Mode Detection

```go
isTerminal := output.IsTTY(cmd.OutOrStdout())
explicitFormat := cmd.Flags().Changed("json") || cmd.Flags().Changed("md")
useInteractive := isTerminal && !appCtx.NoInteractive() && !explicitFormat

if useInteractive {
    // Use interactive picker
} else {
    // Direct output
}
```

### Interactive Picker

```go
import "github.com/jacebenson/jsn/internal/tui"

fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
    items, err := sdkClient.ListItems(ctx, offset, limit)
    if err != nil {
        return nil, err
    }

    var pickerItems []tui.PickerItem
    for _, item := range items {
        pickerItems = append(pickerItems, tui.PickerItem{
            ID:          item.SysID,
            Title:       item.Name,
            Description: item.Description,
        })
    }

    return &tui.PageResult{
        Items:   pickerItems,
        HasMore: len(items) >= limit,
    }, nil
}

selected, err := tui.PickWithPagination("Select an item:", fetcher,
    tui.WithMaxVisible(15),
)
if err != nil {
    return err
}
if selected == nil {
    return fmt.Errorf("selection cancelled")
}
```

### Query Building

Use the shared helper in `query.go`:

```go
// Simple search wrapping
query := wrapSimpleQuery(searchTerm, "tablename")

// Check if already encoded query
if isEncodedQuery(query) {
    // Use as-is
}
```

---

## Output Formatting

### Format Detection

```go
outputWriter := appCtx.Output.(*output.Writer)
format := outputWriter.GetFormat()
isTerminal := output.IsTTY(cmd.OutOrStdout())

switch {
case format == output.FormatStyled || (format == output.FormatAuto && isTerminal):
    return printStyledOutput(cmd, data)
case format == output.FormatMarkdown:
    return printMarkdownOutput(cmd, data)
default:
    // JSON or quiet
    return outputWriter.OK(data)
}
```

### JSON Output with Envelope

```go
return outputWriter.OK(data,
    output.WithSummary(fmt.Sprintf("%d items found", len(data))),
    output.WithNotice("Some items may be filtered"),
    output.WithBreadcrumbs(
        output.Breadcrumb{
            Action:      "show",
            Cmd:         "jsn things show <id>",
            Description: "View item details",
        },
        output.Breadcrumb{
            Action:      "delete",
            Cmd:         "jsn things delete <id>",
            Description: "Delete item",
        },
    ),
)
```

### Styled Output with lipgloss

```go
import "github.com/charmbracelet/lipgloss"

func printStyledOutput(cmd *cobra.Command, data []Item) error {
    headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
    mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
    valueStyle := lipgloss.NewStyle()

    fmt.Fprintln(cmd.OutOrStdout())
    fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Items"))
    fmt.Fprintln(cmd.OutOrStdout())

    for _, item := range data {
        fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n",
            valueStyle.Render(item.Name),
            mutedStyle.Render(item.Description),
        )
    }

    // Hints section
    fmt.Fprintln(cmd.OutOrStdout())
    fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
    fmt.Fprintf(cmd.OutOrStdout(), "  jsn things show <name>  %s\n",
        mutedStyle.Render("View details"))

    return nil
}
```

### Markdown Output

```go
func printMarkdownOutput(cmd *cobra.Command, data []Item) error {
    fmt.Fprintln(cmd.OutOrStdout(), "# Items")
    fmt.Fprintln(cmd.OutOrStdout())
    fmt.Fprintln(cmd.OutOrStdout(), "| Name | Description |")
    fmt.Fprintln(cmd.OutOrStdout(), "|------|-------------|")
    
    for _, item := range data {
        fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s |\n", 
            item.Name, item.Description)
    }
    
    return nil
}
```

---

## Conventions

### Naming

| Type | Convention | Example |
|------|------------|---------|
| Parent command constructor | Exported, `NewXxxCmd` | `NewTablesCmd()` |
| Subcommand constructor | Unexported, `newXxxYyyCmd` | `newTablesListCmd()` |
| Implementation function | `runXxxYyy` | `runTablesList()` |
| Styled output helper | `printStyledXxx` | `printStyledTablesList()` |
| Flags struct | `xxxYyyFlags` | `tablesListFlags` |

### Reserved Short Flags

These are used globally or have established meanings:

| Flag | Long Form | Usage |
|------|-----------|-------|
| `-p` | `--profile` | Profile to use (global) |
| `-q` | `--quiet` | Quiet output (global) |
| `-n` | `--limit` | Number of items |
| `-t` | `--table` | Table name |
| `-f` | `--field` | Field name |
| `-s` | `--scope` | Application scope |

### Error Handling

1. Return `error` from `RunE`, never call `os.Exit()`
2. Use typed errors from `output` package
3. Wrap errors with context: `fmt.Errorf("failed to X: %w", err)`

### Output

1. Use styled output in terminals, JSON when piped
2. Always include breadcrumbs/hints for next actions
3. Include summary in output envelope
4. Add instance URLs when available

---

## Examples

### Simple Command

See: `internal/commands/version.go`

### Command with Subcommands

See: `internal/commands/tables.go`, `internal/commands/auth.go`

### CRUD Operations

See: `internal/commands/records.go`

### Interactive Wizard

See: `internal/commands/setup.go`

### Code Generation

See: `internal/commands/generate.go`

---

## Checklist for New Commands

- [ ] Create file in `internal/commands/`
- [ ] Export constructor function (`NewXxxCmd`)
- [ ] Add `Use`, `Short`, `Long` with examples
- [ ] Implement `RunE` with proper error handling
- [ ] Get app context and check for nil
- [ ] Check SDK availability if calling API
- [ ] Support multiple output formats (styled, JSON, markdown)
- [ ] Add breadcrumbs to JSON output
- [ ] Register in `internal/cli/root.go`
- [ ] Add to command catalog in `commands.go` (optional)
- [ ] Consider interactive mode for list operations
- [ ] Update `skills/servicenow/SKILL.md` with new command documentation
