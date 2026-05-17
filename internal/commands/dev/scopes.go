// Package dev provides developer utility commands.
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

// formatRecordForDisplay formats a record for display, extracting display values
func formatRecordForDisplay(record map[string]any, columns []string) map[string]string {
	result := make(map[string]string)

	// Always include sys_id for hyperlinks
	result["sys_id"] = getSysID(record)

	for _, col := range columns {
		if val, ok := record[col]; ok && val != nil {
			switch v := val.(type) {
			case string:
				result[col] = v
			case map[string]any:
				// Handle display value objects from sysparm_display_value=true
				if display, ok := v["display_value"].(string); ok {
					result[col] = display
				} else if value, ok := v["value"].(string); ok {
					result[col] = value
				} else {
					result[col] = fmt.Sprintf("%v", v)
				}
			default:
				result[col] = fmt.Sprintf("%v", v)
			}
		} else {
			result[col] = ""
		}
	}
	return result
}

// scopeDefaultColumns are the default columns to show for scopes
var scopeDefaultColumns = []string{"name", "scope", "short_description", "active"}

// NewScopesCmd creates the scopes command.
func NewScopesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scopes",
		Short: "List ServiceNow application scopes",
		Args:  cobra.NoArgs,
		Long: `List and search ServiceNow application scopes from the sys_scope table.

Examples:
  # List all scopes (interactive picker in TTY mode)
  jsn dev scopes list

  # Search for scopes by name
  jsn dev scopes list --query "nameLIKEglobal"

  # Show a specific scope
  jsn dev scopes show "Global"

  # List with custom columns
  jsn dev scopes list --columns "name,scope,sys_id"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No args - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newScopesListCmd(),
		newScopesShowCmd(),
	)

	return cmd
}

func newScopesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List application scopes",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return listScopes(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newScopesShowCmd() *cobra.Command {
	var (
		columns string
	)

	cmd := &cobra.Command{
		Use:   "show [scope-name-or-sys-id]",
		Short: "Show a scope by name or sys_id",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return getScope(ctx, app, identifier, cols)
		},
	}

	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")

	return cmd
}

func listScopes(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listScopesInteractive(ctx, app, columns)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", "20")
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

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to list scopes: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_scope",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d scope(s)", len(records))),
	)
}

// listScopesInteractive shows an interactive picker for scopes
// When a scope is selected, it sets it as the current application scope
func listScopesInteractive(ctx context.Context, app *appctx.App, columns []string) error {
	fetcher := tui.NewListFetcher("sys_scope").
		WithColumns("name", "scope", "short_description", "active", "sys_id").
		WithOrderBy("ORDERBYDESCsys_updated_on").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringValue(record, "name")
			scopeVal := getStringValue(record, "scope")
			desc := getStringValue(record, "short_description")
			active := getBoolValue(record, "active")
			sysID := getStringValue(record, "sys_id")

			// Format: NAME (scope) | description [inactive]
			display := name
			if scopeVal != "" {
				display = fmt.Sprintf("%s (%s)", name, scopeVal)
			}
			if desc != "" {
				display = fmt.Sprintf("%s  | %s", display, desc)
			}
			if !active {
				display += " [inactive]"
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: display,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, 20)
	if err != nil {
		return err
	}

	if selected != nil {
		// Set the selected scope as current
		return setScopeAsCurrent(ctx, app, selected.ID)
	}

	return nil
}

// setScopeAsCurrent sets an application scope as the current scope for the user
func setScopeAsCurrent(ctx context.Context, app *appctx.App, identifier string) error {
	// Find the scope
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,name,scope")

	// Try to find by name or scope field first, then by sys_id
	query := fmt.Sprintf("name=%s^ORscope=%s^ORsys_id=%s", identifier, identifier, identifier)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to find scope: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("scope not found: %s", identifier)
	}

	scope := records[0]
	sysID := getStringValue(scope, "sys_id")
	name := getStringValue(scope, "name")
	scopeVal := getStringValue(scope, "scope")

	// Get current user sys_id
	currentUser, err := app.SDK.GetCurrentUser(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}
	userSysID := currentUser.SysID
	userName := currentUser.UserName

	// Set the user preference for current application
	// Use the scope value (e.g., "global", "x_my_app") for the preference
	prefValue := scopeVal
	if prefValue == "" {
		prefValue = sysID
	}

	if err := setUserPreference(ctx, app, userSysID, "apps.current_app", prefValue); err != nil {
		return fmt.Errorf("failed to set scope preference: %w", err)
	}

	return app.OK(map[string]any{
		"action":       "set_current_scope",
		"scope_sys_id": sysID,
		"scope_name":   name,
		"scope_value":  scopeVal,
		"user":         userSysID,
		"user_name":    userName,
		"status":       "success",
	},
		output.WithSummary(fmt.Sprintf("Scope '%s' set as current", name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "view",
				Cmd:         fmt.Sprintf("jsn dev scopes show %s", sysID),
				Description: "View scope details",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev scopes list",
				Description: "Back to scopes",
			},
		),
	)
}

func getScope(ctx context.Context, app *appctx.App, identifier string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Try to find by name or scope field first, then by sys_id
	query := fmt.Sprintf("name=%s^ORscope=%s^ORsys_id=%s", identifier, identifier, identifier)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to get scope: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("scope not found: %s", identifier)
	}

	return app.OK(wrapRecordWithContext(records[0], "sys_scope", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Scope: %s", identifier)),
	)
}
