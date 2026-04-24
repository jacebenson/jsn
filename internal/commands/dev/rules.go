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

// ruleDefaultColumns are the default columns for business rules
var ruleDefaultColumns = []string{"name", "collection", "active", "order", "sys_scope"}

// NewRulesCmd creates the rules command.
func NewRulesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rules [name]",
		Aliases: []string{"rule", "br"},
		Short:   "Manage business rules",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage business rules.

Business rules run when database operations occur.

Examples:
  jsn dev rules                 # List all
  jsn dev rules "My Rule"       # Get specific
  jsn dev rules list -q "collection=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listRules(ctx, app, "", nil)
			}

			return getRuleByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newRulesListCmd(),
	)

	return cmd
}

func newRulesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List business rules",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = ruleDefaultColumns
			}

			return listRules(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listRules(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = ruleDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_script", params)
	if err != nil {
		return fmt.Errorf("failed to list business rules: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_script",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d business rule(s)", len(records))),
	)
}

func getRuleByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_script", params)
	if err != nil {
		return fmt.Errorf("failed to find business rule: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("business rule not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Business rule: %s", name)),
	)
}
