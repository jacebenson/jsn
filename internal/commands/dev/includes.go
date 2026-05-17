// Package dev provides development-related commands.
package dev

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// includeDefaultColumns are the default columns for script includes
var includeDefaultColumns = []string{"name", "api_name", "active", "sys_scope"}

// NewIncludesCmd creates the includes command.
func NewIncludesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "includes",
		Aliases: []string{"include", "si"},
		Short:   "Manage script includes",
		Args:    cobra.NoArgs,
		Long: `Manage script includes.

Script includes are server-side JavaScript classes and functions.

Examples:
  # List all script includes
  jsn dev includes list

  # Show a specific script include by name
  jsn dev includes show MyScript

  # Show by sys_id
  jsn dev includes show abc123def456

  # Create a new script include
  jsn dev includes create --name "MyScript" --script "function MyScript() {}"

  # Update an existing script include
  jsn dev includes update MyScript --script "function MyScript() { /* updated */ }"

  # Delete a script include
  jsn dev includes delete MyScript`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newIncludesListCmd(),
		newIncludesShowCmd(),
		newIncludesCreateCmd(),
		newIncludesUpdateCmd(),
		newIncludesDeleteCmd(),
	)

	return cmd
}

func newIncludesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List script includes",
		Long: `List script includes with optional filtering and column selection.

Examples:
  # List all active script includes
  jsn dev includes list --query "active=true"

  # List in a specific scope
  jsn dev includes list --query "sys_scope.scope=x_my_app"

  # Show specific columns
  jsn dev includes list --columns "name,api_name,sys_scope,sys_updated_on"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = includeDefaultColumns
			}

			return listIncludes(ctx, app, query, cols, limit)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newIncludesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show a script include by name or sys_id",
		Long: `Display detailed information about a script include.

The show command displays the full script content along with metadata
including API name, scope, active status, and timestamps.

Examples:
  # Show by name
  jsn dev includes show MyScriptInclude

  # Show by sys_id
  jsn dev includes show abc123def456`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showInclude(ctx, app, args[0])
		},
	}
}

func newIncludesCreateCmd() *cobra.Command {
	var (
		name    string
		apiName string
		script  string
		active  bool
		scope   string
		data    string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new script include",
		Long: `Create a new script include in ServiceNow.

You can provide data via flags or --data for more fields.
If using --data, flag values will be merged (flags take precedence).

Examples:
  # Create with inline script
  jsn dev includes create --name "MyScript" --script "function MyScript() {}"

  # Create with API name
  jsn dev includes create --name "MyScript" --api-name "x_my_app.MyScript" --script "..."

  # Create in specific scope
  jsn dev includes create --name "MyScript" --scope "x_my_app" --script "..."

  # Create using JSON data
  jsn dev includes create --data '{"name":"MyScript","script":"function MyScript() {}"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Build record data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			if name != "" {
				recordData["name"] = name
			}
			if apiName != "" {
				recordData["api_name"] = apiName
			}
			if script != "" {
				recordData["script"] = script
			}
			recordData["active"] = active

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("name is required (use --name or --data)")
			}
			if recordData["script"] == nil || recordData["script"] == "" {
				return fmt.Errorf("script is required (use --script or --data)")
			}

			// Construct api_name if not provided
			if recordData["api_name"] == nil || recordData["api_name"] == "" {
				// Get current scope to construct API name
				currentScope, err := getCurrentScope(ctx, app)
				if err != nil {
					currentScope = "global"
				}
				if scope != "" {
					currentScope = scope
				}
				recordData["api_name"] = fmt.Sprintf("%s.%s", currentScope, recordData["name"])
			}

			// Handle scope if specified
			if scope != "" {
				// Validate the user is in the correct scope
				currentScope, err := getCurrentScope(ctx, app)
				if err == nil && currentScope != scope && currentScope != "global" {
					return fmt.Errorf("specified scope '%s' does not match current scope '%s'. Switch scope first: jsn dev scopes set %s",
						scope, currentScope, scope)
				}
			}

			// Create the record
			record, err := app.SDK.Create(ctx, "sys_script_include", recordData)
			if err != nil {
				return fmt.Errorf("failed to create script include: %w", err)
			}

			createdName := getStringField(record, "name")

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created script include '%s'", createdName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev includes show %s", createdName),
						Description: "View the new script include",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev includes update %s --script '...'", createdName),
						Description: "Update this script include",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev includes create --name '...' --script '...'",
						Description: "Create another script include",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev includes list",
						Description: "Back to all script includes",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Script include name (required)")
	cmd.Flags().StringVarP(&apiName, "api-name", "a", "", "API name (defaults to scope.Name)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Script content (required)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status (default: true)")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (defaults to current user scope)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func newIncludesUpdateCmd() *cobra.Command {
	var (
		data   string
		script string
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update a script include",
		Long: `Update an existing script include by name or sys_id.

Scope validation is performed - you can only update records in your current scope.

Examples:
  # Update script content
  jsn dev includes update MyScript --script "function MyScript() { /* updated code */ }"

  # Update using JSON data
  jsn dev includes update MyScript --data '{"active":false}'

  # Update multiple fields
  jsn dev includes update MyScript --script "..." --data '{"active":true}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findIncludeByNameOrSysID(ctx, app, identifier)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for updates
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					recordName, recordScope, currentScope, recordScope)
			}

			// Parse JSON data if provided
			var recordData map[string]any
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			} else {
				recordData = make(map[string]any)
			}

			// Merge script flag (takes precedence over data)
			if script != "" {
				recordData["script"] = script
			}

			// Validate we have something to update
			if len(recordData) == 0 {
				return fmt.Errorf("no updates provided (use --data or --script)")
			}

			// Update the record
			updated, err := app.SDK.Update(ctx, "sys_script_include", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update script include: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated script include '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev includes show %s", recordName),
						Description: "View the updated script include",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev includes update %s --data '{...}'", recordName),
						Description: "Update again",
					},
					output.Breadcrumb{
						Action:      "delete",
						Cmd:         fmt.Sprintf("jsn dev includes delete %s", recordName),
						Description: "Delete this script include",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev includes list",
						Description: "Back to all script includes",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required if no --script)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "New script content (convenience flag)")

	return cmd
}

func newIncludesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a script include",
		Long: `Delete a script include by name or sys_id.

Scope validation is performed - you can only delete records in your current scope.
This operation requires confirmation unless --force is used.

Examples:
  # Delete with confirmation prompt
  jsn dev includes delete MyScript

  # Delete without confirmation
  jsn dev includes delete MyScript --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findIncludeByNameOrSysID(ctx, app, identifier)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for deletes
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					recordName, recordScope, currentScope, recordScope)
			}

			// Confirmation prompt (if TTY and not --force)
			if !force && output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) {
				fmt.Fprintf(os.Stdout, "Delete script include '%s'? (y/N): ", recordName)
				reader := bufio.NewReader(os.Stdin)
				response, err := reader.ReadString('\n')
				if err != nil {
					return fmt.Errorf("failed to read confirmation: %w", err)
				}
				response = strings.TrimSpace(strings.ToLower(response))
				if response != "y" && response != "yes" {
					return fmt.Errorf("deletion cancelled")
				}
			}

			// Delete the record
			if err := app.SDK.Delete(ctx, "sys_script_include", sysID); err != nil {
				return fmt.Errorf("failed to delete script include: %w", err)
			}

			return app.OK(map[string]any{
				"name":    recordName,
				"sys_id":  sysID,
				"deleted": true,
			},
				output.WithSummary(fmt.Sprintf("Deleted script include '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev includes create --name '...' --script '...'",
						Description: "Create a new script include",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev includes list",
						Description: "Back to all script includes",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

func listIncludes(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = includeDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listIncludesInteractive(ctx, app, query, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_display_value", "all")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Default ordering: most recently updated first
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "sys_script_include", params)
	if err != nil {
		return fmt.Errorf("failed to list script includes: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn dev includes create --name '...' --script '...'",
			Description: "Create a new script include",
		},
		{
			Action:      "filter",
			Cmd:         "jsn dev includes list --query \"active=true^sys_scope.scope=global\"",
			Description: "Filter: active global script includes",
		},
	}

	return app.OK(map[string]any{
		"table":   "sys_script_include",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d script include(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listIncludesInteractive shows an interactive picker for script includes with pagination
func listIncludesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_script_include").
		WithColumns("name", "api_name", "active").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			apiName := getStringField(record, "api_name")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := IconActive
			if active != "true" {
				statusIcon = IconInactive
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, name, apiName)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		return showInclude(ctx, app, selected.ID)
	}

	return nil
}

// showInclude displays a single script include with full details
func showInclude(ctx context.Context, app *appctx.App, identifier string) error {
	record, err := findIncludeByNameOrSysID(ctx, app, identifier)
	if err != nil {
		return err
	}

	name := getStringField(record, "name")
	apiName := getStringField(record, "api_name")
	recordScope := getStringField(record, "sys_scope")

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_script_include",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev includes update %s --script '...'", name),
			Description: "Update this script include",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev includes delete %s", name),
			Description: "Delete this script include",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev includes list",
			Description: "Back to all script includes",
		},
	}

	// Add scope warning breadcrumb if scope mismatch detected
	validator := NewScopeValidator(app)
	if currentScope, err := validator.GetCurrentScope(ctx); err == nil && currentScope != "global" && currentScope != recordScope {
		breadcrumbs = append([]output.Breadcrumb{
			{
				Action:      "scope-warning",
				Cmd:         fmt.Sprintf("jsn dev scopes set %s", recordScope),
				Description: fmt.Sprintf("⚠ Switch scope to '%s' to modify this record", recordScope),
			},
		}, breadcrumbs...)
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Script include: %s (%s)", name, apiName)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findIncludeByNameOrSysID finds a script include by name or sys_id
func findIncludeByNameOrSysID(ctx context.Context, app *appctx.App, identifier string) (map[string]any, error) {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(identifier) == 32 && isHexString(identifier) {
		query = "sys_id=" + identifier
	} else {
		query = "name=" + identifier
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_script_include", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find script include: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("script include not found: %s", identifier)
	}

	return records[0], nil
}

// getCurrentScope retrieves the current application scope for the user
func getCurrentScope(ctx context.Context, app *appctx.App) (string, error) {
	// Get current user to find their scope preference
	currentUser, err := app.SDK.GetCurrentUser(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get current user: %w", err)
	}

	// Get the current application scope for the user
	application, err := app.SDK.GetCurrentApplication(ctx, currentUser.SysID)
	if err != nil {
		return "", fmt.Errorf("failed to get current application: %w", err)
	}

	return application.Scope, nil
}
