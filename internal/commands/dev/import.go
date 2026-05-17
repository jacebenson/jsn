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

// importDefaultColumns are the default columns for import sets
var importDefaultColumns = []string{"sys_import_set", "sys_import_row", "sys_target_table", "sys_target_sys_id"}

// NewImportCmd creates the import command.
func NewImportCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "import",
		Aliases: []string{"imports", "imp"},
		Short:   "Manage import sets",
		Args:    cobra.NoArgs,
		Long: `Manage import sets.

Import sets bring data into ServiceNow from external sources.

Examples:
  # Show this help
  jsn dev import

  # List import set rows
  jsn dev import list

  # Show an import set row
  jsn dev import show SET0010001

  # List with a filter
  jsn dev import list --query "sys_target_table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newImportListCmd(),
		newImportShowCmd(),
	)

	return cmd
}

func newImportShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [set|sys_id]",
		Short: "Show import set row details",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			if len(identifier) == 32 && isHexString(identifier) {
				return getImportSetRowBySysID(ctx, app, identifier)
			}

			return getImportSetByNumber(ctx, app, identifier)
		},
	}

	return cmd
}

func newImportListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List import sets",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = importDefaultColumns
			}

			return listImportSets(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listImportSets(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = importDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listImportSetsInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_import_set_row", params)
	if err != nil {
		return fmt.Errorf("failed to list import sets: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_import_set_row",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d import row(s)", len(records))),
	)
}

// listImportSetsInteractive shows an interactive picker for import set rows with pagination
func listImportSetsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for import set rows
	fetcher := tui.NewListFetcher("sys_import_set_row").
		WithColumns("sys_import_set", "sys_import_row", "sys_target_table", "sys_target_sys_id").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			importSet := getStringField(record, "sys_import_set")
			row := getStringField(record, "sys_import_row")
			targetTable := getStringField(record, "sys_target_table")
			targetSysID := getStringField(record, "sys_target_sys_id")
			sysID := getStringField(record, "sys_id")

			// Format title: SET | ROW → TARGET_TABLE
			title := fmt.Sprintf("%-15s | Row %-6s → %s", importSet, row, targetTable)
			if targetSysID != "" {
				title += fmt.Sprintf(" (%s)", truncateString(targetSysID, 8))
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

	// If user selected a row, show its details
	if selected != nil {
		return getImportSetRowBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getImportSetRowBySysID retrieves an import set row by its sys_id
func getImportSetRowBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_import_set_row", params)
	if err != nil {
		return fmt.Errorf("failed to find import set row: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("import set row not found: %s", sysID)
	}

	return app.OK(wrapRecordWithContext(records[0], "sys_import_set_row", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Import Set Row: %s", getStringField(records[0], "sys_import_set"))),
	)
}

func getImportSetByNumber(ctx context.Context, app *appctx.App, number string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_import_set="+number)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_import_set_row", params)
	if err != nil {
		return fmt.Errorf("failed to find import set: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("import set not found: %s", number)
	}

	return app.OK(wrapRecordWithContext(records[0], "sys_import_set_row", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Import set: %s", number)),
	)
}
