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

// propertyDefaultColumns are the default columns for properties
var propertyDefaultColumns = []string{"name", "value", "description", "sys_scope"}

// NewPropertiesCmd creates the properties command.
func NewPropertiesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "properties [name]",
		Aliases: []string{"property", "prop"},
		Short:   "Manage system properties",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage system properties.

Properties store instance-wide configuration values.

Examples:
  jsn dev properties                  # List all
  jsn dev properties glide.foo.bar    # Get specific
  jsn dev properties list -q "nameLIKEglide"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listProperties(ctx, app, "", nil)
			}

			return getPropertyByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newPropertiesListCmd(),
	)

	return cmd
}

func newPropertiesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List properties",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = propertyDefaultColumns
			}

			return listProperties(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listProperties(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = propertyDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_properties", params)
	if err != nil {
		return fmt.Errorf("failed to list properties: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_properties",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d property(s)", len(records))),
	)
}

func getPropertyByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_properties", params)
	if err != nil {
		return fmt.Errorf("failed to find property: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("property not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Property: %s", name)),
	)
}
