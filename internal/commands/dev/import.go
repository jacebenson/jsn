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

// importDefaultColumns are the default columns for import sets
var importDefaultColumns = []string{"sys_import_set", "sys_import_row", "sys_target_table", "sys_target_sys_id"}

// NewImportCmd creates the import command.
func NewImportCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "import [set]",
		Aliases: []string{"imports", "imp"},
		Short:   "Manage import sets",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage import sets.

Import sets bring data into ServiceNow from external sources.

Examples:
  jsn dev import                # List all
  jsn dev import SET0010001     # Get specific
  jsn dev import list -q "sys_target_table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listImportSets(ctx, app, "", nil)
			}

			return getImportSetByNumber(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newImportListCmd(),
	)

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

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Import set: %s", number)),
	)
}
