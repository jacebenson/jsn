// Package dev provides developer utility commands.
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

// tableDefaultColumns are the default columns to show for tables
var tableDefaultColumns = []string{"name", "label", "super_class", "create_access_controls"}

// dictionaryDefaultColumns are the default columns for dictionary entries
var dictionaryDefaultColumns = []string{"element", "column_label", "internal_type", "mandatory", "max_length"}

// NewTablesCmd creates the tables command.
func NewTablesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tables [search]",
		Short: "List ServiceNow table definitions",
		Args:  cobra.ArbitraryArgs,
		Long: `List and query ServiceNow table definitions from the sys_db_object table.

Examples:
  # List all tables
  jsn dev tables

  # Search for tables by name
  jsn dev tables "incident"

  # Show table columns
  jsn dev tables columns --table incident`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			query := ""
			if len(args) > 0 {
				search := args[0]
				query = fmt.Sprintf("nameLIKE%s^ORlabelLIKE%s", search, search)
			}

			return listTables(ctx, app, query, nil)
		},
	}

	cmd.AddCommand(
		newTablesListCmd(),
		newTablesGetCmd(),
		newTablesColumnsCmd(),
	)

	return cmd
}

func newTablesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List table definitions",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = tableDefaultColumns
			}

			return listTables(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newTablesGetCmd() *cobra.Command {
	var (
		columns string
	)

	cmd := &cobra.Command{
		Use:   "get [table-name]",
		Short: "Get a table by name",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			tableName := args[0]

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = tableDefaultColumns
			}

			return getTable(ctx, app, tableName, cols)
		},
	}

	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")

	return cmd
}

func newTablesColumnsCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "columns",
		Short: "Show columns for a table",
		Long:  "List columns/fields for a specific table from sys_dictionary.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			tableName, _ := cmd.Flags().GetString("table")
			if tableName == "" {
				return fmt.Errorf("--table is required")
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = dictionaryDefaultColumns
			}

			return listTableColumns(ctx, app, tableName, query, cols)
		},
	}

	cmd.Flags().String("table", "", "Table name (required)")
	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string for filtering columns")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of columns to return")

	_ = cmd.MarkFlagRequired("table")

	return cmd
}

func listTables(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = tableDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_db_object", params)
	if err != nil {
		return fmt.Errorf("failed to list tables: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_db_object",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d table(s)", len(records))),
	)
}

func getTable(ctx context.Context, app *appctx.App, tableName string, columns []string) error {
	if len(columns) == 0 {
		columns = tableDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Try to find by name field
	query := fmt.Sprintf("name=%s", tableName)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_db_object", params)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("table not found: %s", tableName)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Table: %s", tableName)),
	)
}

func listTableColumns(ctx context.Context, app *appctx.App, tableName string, query string, columns []string) error {
	if len(columns) == 0 {
		columns = dictionaryDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_limit", "50")
	params.Set("sysparm_display_value", "all")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Query for columns of this table
	baseQuery := fmt.Sprintf("name=%s^elementISNOTEMPTY", tableName)
	if query != "" {
		baseQuery = baseQuery + "^" + query
	}
	params.Set("sysparm_query", baseQuery)

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return fmt.Errorf("failed to list table columns: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":     "sys_dictionary",
		"for_table": tableName,
		"count":     len(records),
		"columns":   columns,
		"records":   displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d column(s) for table %s", len(records), tableName)),
	)
}
