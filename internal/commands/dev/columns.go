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

// columnDefaultColumns are the default columns for columns
var columnDefaultColumns = []string{"element", "column_label", "internal_type", "mandatory", "max_length"}

// NewColumnsCmd creates the columns command.
func NewColumnsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "columns [element]",
		Aliases: []string{"column", "col"},
		Short:   "Manage column definitions",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage column definitions.

Columns are defined in the system dictionary.

Examples:
  jsn dev columns                    # List all
  jsn dev columns short_description  # Get specific
  jsn dev columns list -q "name=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listColumns(ctx, app, "", nil)
			}

			return getColumnByElement(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newColumnsListCmd(),
	)

	return cmd
}

func newColumnsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List columns",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = columnDefaultColumns
			}

			return listColumns(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of records to return")

	return cmd
}

func listColumns(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = columnDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_limit", "50")
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

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return fmt.Errorf("failed to list columns: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_dictionary",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d column(s)", len(records))),
	)
}

func getColumnByElement(ctx context.Context, app *appctx.App, element string) error {
	params := url.Values{}
	params.Set("sysparm_query", "element="+element)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return fmt.Errorf("failed to find column: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("column not found: %s", element)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Column: %s", element)),
	)
}
