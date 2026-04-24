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

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listActionsInteractive(ctx, app, query, 20)
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
			return getActionByName(ctx, app, name)
		}
		// Fallback: try to get by sys_id
		return getActionBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getActionBySysID retrieves an action by its sys_id
func getActionBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_cb_action", params)
	if err != nil {
		return fmt.Errorf("failed to find action: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("action not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Action: %s", getStringField(records[0], "name"))),
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
