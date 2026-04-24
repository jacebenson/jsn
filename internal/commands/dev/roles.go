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

// roleDefaultColumns are the default columns for roles
var roleDefaultColumns = []string{"name", "description", "elevated_privilege", "sys_scope"}

// NewRolesCmd creates the roles command.
func NewRolesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "roles [name]",
		Aliases: []string{"role"},
		Short:   "Manage roles",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage user roles.

Roles control access to application modules and functions.

Examples:
  jsn dev roles              # List all
  jsn dev roles admin        # Get specific
  jsn dev roles list -q "elevated_privilege=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listRoles(ctx, app, "", nil)
			}

			return getRoleByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newRolesListCmd(),
	)

	return cmd
}

func newRolesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List roles",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = roleDefaultColumns
			}

			return listRoles(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listRoles(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = roleDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listRolesInteractive(ctx, app, query, 20)
	}

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

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return fmt.Errorf("failed to list roles: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_user_role",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d role(s)", len(records))),
	)
}

// listRolesInteractive shows an interactive picker for roles with pagination
func listRolesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for roles
	fetcher := tui.NewListFetcher("sys_user_role").
		WithColumns("name", "description", "elevated_privilege", "sys_scope").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			desc := getStringField(record, "description")
			elevated := getStringField(record, "elevated_privilege")
			scope := getStringField(record, "sys_scope")
			sysID := getStringField(record, "sys_id")

			// Format title: NAME | SCOPE | ELEVATED
			icon := "◌"
			if elevated == "true" {
				icon = "⚡"
			}

			title := fmt.Sprintf("%s %-30s | %s", icon, name, scope)
			if desc != "" {
				title = fmt.Sprintf("%s %-30s | %s | %s", icon, name, truncateString(desc, 25), scope)
			}

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

	// If user selected a role, show its details
	if selected != nil {
		// Extract name from title (format: ICON NAME ...)
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return getRoleByName(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getRoleBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getRoleBySysID retrieves a role by its sys_id
func getRoleBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return fmt.Errorf("failed to find role: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("role not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Role: %s", getStringField(records[0], "name"))),
	)
}

func getRoleByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return fmt.Errorf("failed to find role: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("role not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Role: %s", name)),
	)
}
