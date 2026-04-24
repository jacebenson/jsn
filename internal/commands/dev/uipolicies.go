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

// uiPolicyDefaultColumns are the default columns for UI policies
var uiPolicyDefaultColumns = []string{"short_description", "table", "active", "order", "sys_scope"}

// NewUIPoliciesCmd creates the uipolicies command.
func NewUIPoliciesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uipolicies [name]",
		Aliases: []string{"uipolicy", "up"},
		Short:   "Manage UI policies",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage UI policies.

UI policies dynamically change form behavior.

Examples:
  jsn dev uipolicies              # List all
  jsn dev uipolicies "My Policy"  # Get specific
  jsn dev uipolicies list -q "table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listUIPolicies(ctx, app, "", nil)
			}

			return getUIPolicyByDescription(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newUIPoliciesListCmd(),
	)

	return cmd
}

func newUIPoliciesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI policies",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = uiPolicyDefaultColumns
			}

			return listUIPolicies(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listUIPolicies(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = uiPolicyDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_ui_policy", params)
	if err != nil {
		return fmt.Errorf("failed to list UI policies: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_ui_policy",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d UI policy(s)", len(records))),
	)
}

func getUIPolicyByDescription(ctx context.Context, app *appctx.App, description string) error {
	params := url.Values{}
	params.Set("sysparm_query", "short_description="+description)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_ui_policy", params)
	if err != nil {
		return fmt.Errorf("failed to find UI policy: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("UI policy not found: %s", description)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("UI policy: %s", description)),
	)
}
