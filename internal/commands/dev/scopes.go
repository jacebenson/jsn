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

// formatRecordForDisplay formats a record for display, extracting display values
func formatRecordForDisplay(record map[string]any, columns []string) map[string]string {
	result := make(map[string]string)

	// Always include sys_id for hyperlinks
	if sysID, ok := record["sys_id"]; ok && sysID != nil {
		result["sys_id"] = fmt.Sprintf("%v", sysID)
	}

	for _, col := range columns {
		if val, ok := record[col]; ok && val != nil {
			switch v := val.(type) {
			case string:
				result[col] = v
			case map[string]any:
				// Handle display value objects from sysparm_display_value=true
				if display, ok := v["display_value"].(string); ok {
					result[col] = display
				} else if value, ok := v["value"].(string); ok {
					result[col] = value
				} else {
					result[col] = fmt.Sprintf("%v", v)
				}
			default:
				result[col] = fmt.Sprintf("%v", v)
			}
		} else {
			result[col] = ""
		}
	}
	return result
}

// scopeDefaultColumns are the default columns to show for scopes
var scopeDefaultColumns = []string{"name", "scope", "short_description", "active"}

// NewScopesCmd creates the scopes command.
func NewScopesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scopes [search]",
		Short: "List ServiceNow application scopes",
		Args:  cobra.ArbitraryArgs,
		Long: `List and search ServiceNow application scopes from the sys_scope table.

Examples:
  # List all scopes
  jsn dev scopes

  # Search for scopes by name
  jsn dev scopes "global"

  # List with custom columns
  jsn dev scopes list --columns "name,scope,sys_id"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			query := ""
			if len(args) > 0 {
				search := args[0]
				query = fmt.Sprintf("nameLIKE%s^ORscopeLIKE%s", search, search)
			}

			return listScopes(ctx, app, query, nil)
		},
	}

	cmd.AddCommand(
		newScopesListCmd(),
		newScopesGetCmd(),
	)

	return cmd
}

func newScopesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List application scopes",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return listScopes(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newScopesGetCmd() *cobra.Command {
	var (
		columns string
	)

	cmd := &cobra.Command{
		Use:   "get [scope-name-or-sys-id]",
		Short: "Get a scope by name or sys_id",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return getScope(ctx, app, identifier, cols)
		},
	}

	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")

	return cmd
}

func listScopes(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to list scopes: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_scope",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d scope(s)", len(records))),
	)
}

func getScope(ctx context.Context, app *appctx.App, identifier string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Try to find by name or scope field first, then by sys_id
	query := fmt.Sprintf("name=%s^ORscope=%s^ORsys_id=%s", identifier, identifier, identifier)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to get scope: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("scope not found: %s", identifier)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Scope: %s", identifier)),
	)
}
