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

// includeDefaultColumns are the default columns for script includes
var includeDefaultColumns = []string{"name", "api_name", "active", "sys_scope"}

// NewIncludesCmd creates the includes command.
func NewIncludesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "includes [name]",
		Aliases: []string{"include", "si"},
		Short:   "Manage script includes",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage script includes.

Script includes are server-side JavaScript classes.

Examples:
  jsn dev includes              # List all
  jsn dev includes MyInclude    # Get specific
  jsn dev includes list -q "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listIncludes(ctx, app, "", nil)
			}

			return getIncludeByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newIncludesListCmd(),
	)

	return cmd
}

func newIncludesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List script includes",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = includeDefaultColumns
			}

			return listIncludes(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listIncludes(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = includeDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_script_include", params)
	if err != nil {
		return fmt.Errorf("failed to list script includes: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_script_include",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d script include(s)", len(records))),
	)
}

func getIncludeByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_script_include", params)
	if err != nil {
		return fmt.Errorf("failed to find script include: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("script include not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Script include: %s", name)),
	)
}
