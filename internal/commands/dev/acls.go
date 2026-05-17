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

// aclDefaultColumns are the default columns for ACLs
var aclDefaultColumns = []string{"name", "operation", "type", "active", "sys_scope"}

// NewACLsCmd creates the acls command.
func NewACLsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "acls",
		Aliases: []string{"acl"},
		Short:   "Manage access controls",
		Args:    cobra.NoArgs,
		Long: `Manage access controls (ACLs).

ACLs control read, write, create, and delete permissions.

Examples:
  # Show this help
  jsn dev acls

  # List ACLs
  jsn dev acls list

  # Show an ACL
  jsn dev acls show incident.read

  # List with a filter
  jsn dev acls list --query "operation=read"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newACLsListCmd(),
		newACLsShowCmd(),
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

			// Interactive picker when in TTY and auto format
			if output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) && app.Output.GetFormat() == output.FormatAuto {
				return listACLsInteractive(ctx, app, query, 20)
			}

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

func newACLsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show ACL details",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			return getACLByName(ctx, app, args[0])
		},
	}
}

func listACLs(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = aclDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listACLsInteractive(ctx, app, query, 20)
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

// listACLsInteractive shows an interactive picker for ACLs with pagination
func listACLsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_security_acl").
		WithColumns("name", "operation", "type", "active").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			operation := getStringField(record, "operation")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, name, operation)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		return getACLByName(ctx, app, selected.ID)
	}

	return nil
}

func getACLByName(ctx context.Context, app *appctx.App, name string) error {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(name) == 32 && isHexString(name) {
		query = "sys_id=" + name
	} else {
		query = "name=" + name
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_security_acl", params)
	if err != nil {
		return fmt.Errorf("failed to find ACL: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("ACL not found: %s", name)
	}

	aclRecord := records[0]
	aclSysID := getSysID(aclRecord)

	// Fetch related ACL roles - role field references sys_user_role
	roleParams := url.Values{}
	roleParams.Set("sysparm_query", "sys_security_acl="+aclSysID)
	roleParams.Set("sysparm_display_value", "all")
	roleParams.Set("sysparm_fields", "sys_id,role,sys_user_role,read,write,create,delete,active")
	roleParams.Set("sysparm_limit", "100")

	roleRecords, err := app.SDK.List(ctx, "sys_security_acl_role", roleParams)
	if err != nil {
		// Don't fail if we can't fetch roles, just show the ACL
		roleRecords = []map[string]any{}
	}

	// Enrich ACL record with related roles
	enriched := wrapRecordWithContext(aclRecord, "sys_security_acl", app.Config.GetEffectiveInstance())
	enriched["_related_roles"] = roleRecords

	return app.OK(enriched,
		output.WithSummary(fmt.Sprintf("ACL: %s", name)),
	)
}
