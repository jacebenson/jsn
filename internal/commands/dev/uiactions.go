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

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listUIActionsInteractive(ctx, app, query, 20)
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

// listUIActionsInteractive shows an interactive picker for UI actions with pagination
func listUIActionsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_ui_action").
		WithColumns("name", "table", "active", "order").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			table := getStringField(record, "table")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, name, table)

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
		return getUIActionByName(ctx, app, selected.ID)
	}

	return nil
}

func getUIActionByName(ctx context.Context, app *appctx.App, name string) error {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(name) == 32 && isHexString(name) {
		query = "sys_id=" + name
	} else {
		query = "name=" + name
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
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
