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

// propertyDefaultColumns are the default columns for properties
var propertyDefaultColumns = []string{"name", "value", "description", "sys_scope"}

// NewPropertiesCmd creates the properties command.
func NewPropertiesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "properties",
		Aliases: []string{"property", "prop"},
		Short:   "Manage system properties",
		Args:    cobra.NoArgs,
		Long: `Manage system properties.

Properties store instance-wide configuration values.

Examples:
  # Show this help
  jsn dev properties

  # List properties
  jsn dev properties list

  # Show a property
  jsn dev properties show glide.foo.bar

  # List with a filter
  jsn dev properties list --query "nameLIKEglide"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newPropertiesListCmd(),
		newPropertiesShowCmd(),
	)

	return cmd
}

func newPropertiesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show property details",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			return getPropertyByName(ctx, app, args[0])
		},
	}

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

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listPropertiesInteractive(ctx, app, query, 20)
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

// listPropertiesInteractive shows an interactive picker for properties with pagination
func listPropertiesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for properties
	fetcher := tui.NewListFetcher("sys_properties").
		WithColumns("name", "value", "description", "sys_scope").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			value := getStringField(record, "value")
			desc := getStringField(record, "description")
			scope := getStringField(record, "sys_scope")
			sysID := getStringField(record, "sys_id")

			// Format title: NAME = VALUE | SCOPE
			title := fmt.Sprintf("%-40s = %-20s | %s", name, truncateString(value, 20), scope)
			if desc != "" {
				title = fmt.Sprintf("%-40s = %-20s | %s | %s", name, truncateString(value, 20), truncateString(desc, 20), scope)
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	// Show the interactive picker
	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	// If user selected a property, show its details
	if selected != nil {
		// Extract name from title (format: NAME = ...)
		parts := strings.SplitN(selected.Title, " =", 2)
		if len(parts) >= 1 {
			name := strings.TrimSpace(parts[0])
			return getPropertyByName(ctx, app, name)
		}
		// Fallback: try to get by sys_id
		return getPropertyBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getPropertyBySysID retrieves a property by its sys_id
func getPropertyBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_properties", params)
	if err != nil {
		return fmt.Errorf("failed to find property: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("property not found: %s", sysID)
	}

	return app.OK(wrapRecordWithContext(records[0], "sys_properties", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Property: %s", getStringField(records[0], "name"))),
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

	return app.OK(wrapRecordWithContext(records[0], "sys_properties", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Property: %s", name)),
	)
}
