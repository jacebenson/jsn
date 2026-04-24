// Package dev provides development-related commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
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
