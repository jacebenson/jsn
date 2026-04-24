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

// aclDefaultColumns are the default columns for ACLs
var aclDefaultColumns = []string{"name", "operation", "type", "active", "sys_scope"}

// NewACLsCmd creates the acls command.
func NewACLsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "acls [name]",
		Aliases: []string{"acl"},
		Short:   "Manage access controls",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage access controls (ACLs).

ACLs control read, write, create, and delete permissions.

Examples:
  jsn dev acls                  # List all
  jsn dev acls incident.read    # Get specific
  jsn dev acls list -q "operation=read"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listACLs(ctx, app, "", nil)
			}

			return getACLByName(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newACLsListCmd(),
	)

	return cmd
}

func newACLsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List ACLs",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = aclDefaultColumns
			}

			return listACLs(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listACLs(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = aclDefaultColumns
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

	records, err := app.SDK.List(ctx, "sys_security_acl", params)
	if err != nil {
		return fmt.Errorf("failed to list ACLs: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_security_acl",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d ACL(s)", len(records))),
	)
}

func getACLByName(ctx context.Context, app *appctx.App, name string) error {
	params := url.Values{}
	params.Set("sysparm_query", "name="+name)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_security_acl", params)
	if err != nil {
		return fmt.Errorf("failed to find ACL: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("ACL not found: %s", name)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("ACL: %s", name)),
	)
}
