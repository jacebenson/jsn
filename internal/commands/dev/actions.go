// Package dev provides development-related commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// actionDefaultColumns are the default columns for actions
var actionDefaultColumns = []string{"name", "active", "sys_scope", "sys_updated_on"}

// NewActionsCmd creates the actions command.
func NewActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "actions",
		Aliases: []string{"action"},
		Short:   "Manage action definitions",
		Args:    cobra.NoArgs,
		Long: `Manage action definitions.

Actions are reusable components in Flow Designer.

Read operations (list, show) use the Table API on sys_cb_action.
Create/update/delete operations require the Flow Designer GraphQL API
which is not yet implemented.

Examples:
  # Show this help
  jsn dev actions

  # List actions
  jsn dev actions list

  # Show an action
  jsn dev actions show MyAction

  # List with a filter
  jsn dev actions list --query "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newActionsListCmd(),
		newActionsShowCmd(),
		newActionsCreateCmd(),
		newActionsUpdateCmd(),
		newActionsDeleteCmd(),
	)

	return cmd
}

func newActionsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List actions",
		Long: `List Flow Designer actions with optional filtering and column selection.

Examples:
  # List all actions
  jsn dev actions list

  # List only active actions
  jsn dev actions list --query "active=true"

  # List in a specific scope
  jsn dev actions list --query "sys_scope.scope=x_my_app"

  # Show specific columns
  jsn dev actions list --columns "name,active,sys_scope,sys_updated_on"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Interactive picker when in TTY and auto format
			if output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) && app.Output.GetFormat() == output.FormatAuto {
				return listActionsInteractive(ctx, app, query, limit)
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = actionDefaultColumns
			}

			return listActions(ctx, app, query, cols, limit)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newActionsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show action details",
		Long: `Show details for a specific action by name or sys_id.

Uses the Table API on sys_cb_action to retrieve action metadata.
For full action definitions, the Flow Designer GraphQL API would be required.

Examples:
  jsn dev actions show "My Action"
  jsn dev actions show abc123def456abc123def456abc12345`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showAction(ctx, app, args[0])
		},
	}
}

func newActionsCreateCmd() *cobra.Command {
	var (
		name   string
		active bool
		scope  string
		data   string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new action (not yet implemented)",
		Long: `Action creation requires the Flow Designer GraphQL API.

The Table API does not support creating or modifying Flow Designer actions -
these operations require the Flow Designer GraphQL endpoints which are
not yet implemented in this CLI.

To create actions:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev actions list' to view your actions

Planned implementation: POST /api/sn_fnd/action/v1/actions with GraphQL mutation`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// For now, return an error explaining GraphQL requirement
			// When GraphQL support is added, implement similar to includes.go create:
			// - Parse --data JSON if provided
			// - Apply flag values (name, active, scope)
			// - Validate required fields (name)
			// - Scope validation
			// - Create via SDK
			return fmt.Errorf("action creation requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to create actions, then use 'jsn dev actions list' to view them")
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Action name (required)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status (default: true)")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (defaults to current user scope)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func newActionsUpdateCmd() *cobra.Command {
	var (
		data   string
		active bool
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update an existing action (not yet implemented)",
		Long: `Action updates require the Flow Designer GraphQL API.

The Table API does not support modifying Flow Designer actions - these operations
require the Flow Designer GraphQL endpoints for:
  - Action versioning and state management
  - Action configuration and connections
  - Input/output schema definitions

To update actions:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev actions list' to view your actions

Planned implementation: PUT /api/sn_fnd/action/v1/actions/{sys_id} with GraphQL mutation`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("action updates require Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to update actions, then use 'jsn dev actions list' to view them")
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().BoolVar(&active, "active", true, "Update active status")

	return cmd
}

func newActionsDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete an action (not yet implemented)",
		Long: `Action deletion requires the Flow Designer GraphQL API.

While the Table API could delete the sys_cb_action record directly,
this may leave orphaned action versions and related data in supporting
tables (sys_cb_action_input, sys_cb_action_output, etc.).

The Flow Designer GraphQL API provides proper cleanup.

Scope validation is performed - you can only delete records in your current scope.
This operation requires confirmation unless --force is used.

To delete actions:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev actions list' to confirm deletion

Planned implementation: DELETE /api/sn_fnd/action/v1/actions/{sys_id}`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// For now, return an error explaining GraphQL requirement
			// When implemented, should:
			// - Find the record by name or sys_id
			// - Scope validation
			// - Confirmation prompt (if TTY and not --force)
			// - Delete via SDK
			return fmt.Errorf("action deletion requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to delete actions, then use 'jsn dev actions list' to confirm")
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

func listActions(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = actionDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listActionsInteractive(ctx, app, query, 20)
	}

	params := url.Values{}
	if limit > 0 {
		params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	} else {
		params.Set("sysparm_limit", "20")
	}
	params.Set("sysparm_display_value", "all")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Default ordering: most recently updated first
	// Append ORDERBYDESC to any existing query
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "sys_cb_action", params)
	if err != nil {
		return fmt.Errorf("failed to list actions: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn dev actions create --name '...'",
			Description: "Create a new action (when GraphQL API is available)",
		},
		{
			Action:      "filter",
			Cmd:         "jsn dev actions list --query \"active=true\"",
			Description: "Show only active actions",
		},
	}

	return app.OK(map[string]any{
		"table":   "sys_cb_action",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d action(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listActionsInteractive shows an interactive picker for actions with pagination
func listActionsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for actions
	fetcher := tui.NewListFetcher("sys_cb_action").
		WithColumns("name", "active", "sys_scope", "sys_updated_on").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			active := getStringField(record, "active")
			scope := getStringField(record, "sys_scope")
			updated := getStringField(record, "sys_updated_on")
			sysID := getStringField(record, "sys_id")

			// Format active icon
			icon := "○"
			if active == "true" {
				icon = "●"
			}

			// Format title: ICON NAME | SCOPE | UPDATED
			title := fmt.Sprintf("%s %-30s | %-15s | %s", icon, name, scope, updated)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	// Show the interactive picker
	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	// If user selected an action, show its details
	if selected != nil {
		// Extract name from title (format: ICON NAME | ...)
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			name := strings.TrimSpace(parts[1])
			return showAction(ctx, app, name)
		}
		// Fallback: try to get by sys_id
		return showAction(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// showAction displays a single action with full details
func showAction(ctx context.Context, app *appctx.App, identifier string) error {
	record, err := findActionByNameOrSysID(ctx, app, identifier)
	if err != nil {
		return err
	}

	name := getStringField(record, "name")
	recordScope := getStringField(record, "sys_scope")

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_cb_action",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev actions update %s --data '{...}'", name),
			Description: "Update this action (when GraphQL API is available)",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev actions delete %s", name),
			Description: "Delete this action (when GraphQL API is available)",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev actions list",
			Description: "Back to all actions",
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
		output.WithSummary(fmt.Sprintf("Action: %s", name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findActionByNameOrSysID finds an action by name or sys_id
func findActionByNameOrSysID(ctx context.Context, app *appctx.App, identifier string) (map[string]any, error) {
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

	records, err := app.SDK.List(ctx, "sys_cb_action", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find action: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("action not found: %s", identifier)
	}

	return records[0], nil
}

// --- Stub functions for future Flow Designer API integration ---

// GetActionDefinition retrieves the full action definition including inputs and outputs
// TODO: Implement using Flow Designer API when available
func GetActionDefinition(ctx context.Context, app *appctx.App, actionSysID string) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	// This will use the dedicated Flow Designer API endpoints instead of Table API
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// CreateAction creates a new action from a definition
// TODO: Implement using Flow Designer API when available
func CreateAction(ctx context.Context, app *appctx.App, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// UpdateAction updates an existing action's definition
// TODO: Implement using Flow Designer API when available
func UpdateAction(ctx context.Context, app *appctx.App, actionSysID string, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// DeleteAction deletes an action by sys_id
// TODO: Implement using Flow Designer API when available
func DeleteAction(ctx context.Context, app *appctx.App, actionSysID string) error {
	// Placeholder for Flow Designer API integration
	return fmt.Errorf("Flow Designer API integration not yet implemented")
}
