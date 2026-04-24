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

// actionDefaultColumns are the default columns for actions
var actionDefaultColumns = []string{"name", "active", "sys_scope", "sys_updated_on"}

// NewActionsCmd creates the actions command.
func NewActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "actions [name]",
		Aliases: []string{"action"},
		Short:   "Manage action definitions",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage action definitions.

Actions are reusable components in Flow Designer.

Examples:
  jsn dev actions              # List all
  jsn dev actions MyAction     # Get specific
  jsn dev actions list -q "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listActions(ctx, app, "", nil)
			}

			return getActionByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newActionsListCmd(),
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
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = actionDefaultColumns
			}

			return listActions(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listActions(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = actionDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_cb_action", params)
	if err != nil {
		return fmt.Errorf("failed to list actions: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
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
	)
}

func getActionByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_cb_action", params)
	if err != nil {
		return fmt.Errorf("failed to find action: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("action not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Action: %s", name)),
	)
}
