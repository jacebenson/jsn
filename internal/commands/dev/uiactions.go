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

// uiActionDefaultColumns are the default columns for UI actions
var uiActionDefaultColumns = []string{"name", "table", "active", "order", "sys_scope"}

// NewUIActionsCmd creates the uiactions command.
func NewUIActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uiactions [name]",
		Aliases: []string{"uiaction", "ua"},
		Short:   "Manage UI actions",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage UI actions.

UI actions are buttons, links, and context menu items.

Examples:
  jsn dev uiactions              # List all
  jsn dev uiactions MyAction     # Get specific
  jsn dev uiactions list -q "table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listUIActions(ctx, app, "", nil)
			}

			return getUIActionByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newUIActionsListCmd(),
	)

	return cmd
}

func newUIActionsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI actions",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = uiActionDefaultColumns
			}

			return listUIActions(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listUIActions(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = uiActionDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_ui_action", params)
	if err != nil {
		return fmt.Errorf("failed to list UI actions: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_ui_action",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d UI action(s)", len(records))),
	)
}

func getUIActionByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_ui_action", params)
	if err != nil {
		return fmt.Errorf("failed to find UI action: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("UI action not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("UI action: %s", name)),
	)
}
