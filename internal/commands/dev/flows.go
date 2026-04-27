// Package dev provides development-related commands for ServiceNow.
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

// flowDefaultColumns are the default columns to show for flows
var flowDefaultColumns = []string{"name", "active", "description", "sys_created_by", "sys_updated_on"}

// NewFlowsCmd creates the flows command.
func NewFlowsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "flows [name|sys_id]",
		Aliases: []string{"flow"},
		Short:   "Manage Flow Designer flows",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage Flow Designer flows.

Flows automate business processes with a visual designer.

Read operations (list, show) use the Table API on sys_hub_flow.
Create/update/delete operations require the Flow Designer GraphQL API
which is not yet implemented.

Examples:
  jsn dev flows                       # List all
  jsn dev flows "My Flow"             # Show specific flow
  jsn dev flows show "My Flow"        # Explicit show command
  jsn dev flows list -q "active=true"  # List with filter`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if len(args) == 0 {
				return listFlows(ctx, app, "", nil)
			}

			return getFlow(ctx, app, args[0])
		},
	}

	cmd.AddCommand(
		newFlowsListCmd(),
		newFlowsShowCmd(),
		newFlowsCreateCmd(),
		newFlowsUpdateCmd(),
		newFlowsDeleteCmd(),
	)

	return cmd
}

func newFlowsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List flows",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = flowDefaultColumns
			}

			return listFlows(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string (e.g., 'active=true^nameLIKEApproval')")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newFlowsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show flow details",
		Long: `Show details for a specific flow by name or sys_id.

Uses the Table API on sys_hub_flow to retrieve flow metadata.
For full flow definitions (actions, connections), the Flow Designer
GraphQL API would be required.

Examples:
  jsn dev flows show "My Flow"
  jsn dev flows show abc123def456abc123def456abc12345`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return getFlow(ctx, app, args[0])
		},
	}
}

func newFlowsCreateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "create",
		Short: "Create a new flow (not yet implemented)",
		Long: `Flow creation requires the Flow Designer GraphQL API.

The Table API does not support creating or modifying flows - these
operations require the Flow Designer GraphQL endpoints which are
not yet implemented in this CLI.

To create flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to view your flows

Planned implementation: POST /api/sn_fnd/flow/v1/flows with GraphQL mutation`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow creation requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to create flows, then use 'jsn dev flows list' to view them")
		},
	}
}

func newFlowsUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update an existing flow (not yet implemented)",
		Long: `Flow updates require the Flow Designer GraphQL API.

The Table API does not support modifying flows - these operations
require the Flow Designer GraphQL endpoints for:
  - Flow versioning and state management
  - Action configuration and connections
  - Draft/published state transitions

To update flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to view your flows

Planned implementation: PUT /api/sn_fnd/flow/v1/flows/{sys_id} with GraphQL mutation`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow updates require Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to update flows, then use 'jsn dev flows list' to view them")
		},
	}
}

func newFlowsDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a flow (not yet implemented)",
		Long: `Flow deletion requires the Flow Designer GraphQL API.

While the Table API could delete the sys_hub_flow record directly,
this may leave orphaned flow versions and related data in supporting
tables (sys_hub_flow_input, sys_hub_action_instance, etc.).

The Flow Designer GraphQL API provides proper cleanup.

To delete flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to confirm deletion

Planned implementation: DELETE /api/sn_fnd/flow/v1/flows/{sys_id}`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow deletion requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to delete flows, then use 'jsn dev flows list' to confirm")
		},
	}
}

// listFlows lists flows using the Table API on sys_hub_flow
func listFlows(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = flowDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listFlowsInteractive(ctx, app, query, 20)
	}

	params := url.Values{}
	params.Set("sysparm_limit", "20")
	params.Set("sysparm_display_value", "all")
	// Always include sys_id for hyperlinks and identification
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Default ordering: most recently updated first
	// Append ORDERBYDESC to any existing query
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "sys_hub_flow", params)
	if err != nil {
		return fmt.Errorf("failed to list flows: %w", err)
	}

	// Format for display
	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatFlowForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_hub_flow",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d flow(s)", len(records))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "filter",
				Cmd:         "jsn dev flows list --query \"active=true\"",
				Description: "Show only active flows",
			},
		),
	)
}

// listFlowsInteractive shows an interactive picker for flows with pagination
func listFlowsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_hub_flow").
		WithColumns("name", "active", "description", "sys_created_by").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s", statusIcon, name)

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
		return getFlow(ctx, app, selected.ID)
	}

	return nil
}

// getFlow retrieves a flow by name or sys_id
func getFlow(ctx context.Context, app *appctx.App, identifier string) error {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(identifier) == 32 && isHexString(identifier) {
		query = "sys_id=" + identifier
	} else {
		query = "name=" + identifier
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_hub_flow", params)
	if err != nil {
		return fmt.Errorf("failed to find flow: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("flow not found: %s", identifier)
	}

	record := records[0]
	name := getFlowStringField(record, "name")

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Flow: %s", name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev flows list",
				Description: "Back to all flows",
			},
		),
	)
}

// formatFlowForDisplay formats a flow record for display
func formatFlowForDisplay(record map[string]any, columns []string) map[string]string {
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
			case bool:
				result[col] = fmt.Sprintf("%t", v)
			default:
				result[col] = fmt.Sprintf("%v", v)
			}
		} else {
			result[col] = ""
		}
	}
	return result
}

// getFlowStringField safely extracts a string field from a flow record
func getFlowStringField(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects
			if display, ok := v["display_value"].(string); ok {
				return display
			}
			if value, ok := v["value"].(string); ok {
				return value
			}
		}
		return fmt.Sprintf("%v", val)
	}
	return ""
}

// --- Stub functions for future Flow Designer API integration ---

// GetFlowDefinition retrieves the full flow definition including actions and connections
// TODO: Implement using Flow Designer API when available
func GetFlowDefinition(ctx context.Context, app *appctx.App, flowSysID string) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	// This will use the dedicated Flow Designer API endpoints instead of Table API
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// PublishFlow publishes a flow from draft to published state
// TODO: Implement using Flow Designer API when available
func PublishFlow(ctx context.Context, app *appctx.App, flowSysID string) error {
	// Placeholder for Flow Designer API integration
	return fmt.Errorf("Flow Designer API integration not yet implemented")
}

// CreateFlow creates a new flow from a definition
// TODO: Implement using Flow Designer API when available
func CreateFlow(ctx context.Context, app *appctx.App, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// UpdateFlow updates an existing flow's definition
// TODO: Implement using Flow Designer API when available
func UpdateFlow(ctx context.Context, app *appctx.App, flowSysID string, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// DeleteFlow deletes a flow by sys_id
// TODO: Implement using Flow Designer API when available
func DeleteFlow(ctx context.Context, app *appctx.App, flowSysID string) error {
	// Placeholder for Flow Designer API integration
	return fmt.Errorf("Flow Designer API integration not yet implemented")
}
