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

// clientScriptDefaultColumns are the default columns for client scripts
var clientScriptDefaultColumns = []string{"name", "table", "active", "type", "sys_scope"}

// NewClientScriptsCmd creates the clientscripts command.
func NewClientScriptsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "clientscripts [name]",
		Aliases: []string{"clientscript", "cs"},
		Short:   "Manage client scripts",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage client scripts.

Client scripts run in the browser on forms and lists.

Examples:
  jsn dev clientscripts              # List all
  jsn dev clientscripts MyScript     # Get specific
  jsn dev clientscripts list -q "table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listClientScripts(ctx, app, "", nil)
			}

			return getClientScriptByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newClientScriptsListCmd(),
	)

	return cmd
}

func newClientScriptsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List client scripts",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = clientScriptDefaultColumns
			}

			return listClientScripts(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listClientScripts(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = clientScriptDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listClientScriptsInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_script_client", params)
	if err != nil {
		return fmt.Errorf("failed to list client scripts: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_script_client",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d client script(s)", len(records))),
	)
}

// listClientScriptsInteractive shows an interactive picker for client scripts with pagination
func listClientScriptsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_script_client").
		WithColumns("name", "table", "active", "type").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			table := getStringField(record, "table")
			active := getStringField(record, "active")
			scriptType := getStringField(record, "type")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s | %s | %s", statusIcon, name, table, scriptType)

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
		return getClientScriptByName(ctx, app, selected.ID)
	}

	return nil
}

func getClientScriptByName(ctx context.Context, app *appctx.App, name string) error {
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

	records, err := app.SDK.List(ctx, "sys_script_client", params)
	if err != nil {
		return fmt.Errorf("failed to find client script: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("client script not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Client script: %s", name)),
	)
}
