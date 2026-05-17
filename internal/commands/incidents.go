// Package commands provides CLI commands.
package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// incidentDefaultColumns are the default columns to show for incidents
var incidentDefaultColumns = []string{"number", "short_description", "priority", "state", "assigned_to"}

// NewIncidentsCmd creates the incidents command group.
// This is a convenience wrapper around the generic records command for the incident table.
func NewIncidentsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "incidents",
		Aliases: []string{"incident", "inc"},
		Short:   "Manage IT incidents",
		Long: `Manage IT incidents in ServiceNow.

This command provides convenient access to the incident table with sensible defaults.
For more advanced queries, use the generic 'records' command.

Examples:
  # Show this help
  jsn incidents

  # List incidents
  jsn incidents list

  # Show an incident
  jsn incidents show INC0010001

  # List with a filter
  jsn incidents list --query "priority=1^active=true"

  # Create a new incident
  jsn incidents create --description "Server down" --priority 1

  # Update an incident
  jsn incidents update INC0010001 --data '{"state": "6"}'

  # Delete an incident
  jsn incidents delete INC0010001`,
	}

	cmd.AddCommand(
		newIncidentsListCmd(),
		newIncidentsShowCmd(),
		newIncidentsCreateCmd(),
		newIncidentsUpdateCmd(),
		newIncidentsDeleteCmd(),
	)

	return cmd
}

func newIncidentsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
		offset  int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List incidents",
		Long: `List incidents with optional filtering and column selection.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn inc list --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    jsn inc list --query "priority=1"                    # Critical only
    jsn inc list --query "active=true^assigned_to="      # Unassigned
    jsn inc list --query "opened_at>javascript:gs.daysAgo(7)"  # Last 7 days`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Parse columns
			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = incidentDefaultColumns
			}

			return listIncidents(ctx, app, query, cols, limit, offset)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string (e.g., 'priority=1^active=true')")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")
	cmd.Flags().IntVarP(&offset, "offset", "o", 0, "Offset for pagination (number of records to skip)")

	return cmd
}

func newIncidentsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [number]",
		Short: "Show a specific incident",
		Long: `Display detailed information about an incident.

Examples:
  # Show incident by number
  jsn incidents show INC0010001`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return getIncidentByNumber(ctx, app, args[0])
		},
	}
}

func newIncidentsCreateCmd() *cobra.Command {
	var (
		shortDesc string
		priority  string
		data      string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new incident",
		Long: `Create a new incident in ServiceNow.

You can provide data via flags or --data for more fields.
If using --data, flag values will be merged (flags take precedence).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			// Build record data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			if shortDesc != "" {
				recordData["short_description"] = shortDesc
			}
			if priority != "" {
				recordData["priority"] = priority
			}

			// Validate required fields
			if recordData["short_description"] == nil || recordData["short_description"] == "" {
				return fmt.Errorf("short_description is required (use --description or --data)")
			}

			record, err := app.SDK.Create(cmd.Context(), "incident", recordData)
			if err != nil {
				return fmt.Errorf("failed to create incident: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created incident %s", getStringField(record, "number"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn incidents show %s", getStringField(record, "number")),
						Description: "View the new incident",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&shortDesc, "description", "d", "", "Short description (required if not in --data)")
	cmd.Flags().StringVarP(&priority, "priority", "", "", "Priority (1-5, where 1 is critical)")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newIncidentsUpdateCmd() *cobra.Command {
	var data string

	cmd := &cobra.Command{
		Use:   "update [number]",
		Short: "Update an incident",
		Long:  "Update an existing incident by its number.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			number := args[0]

			if data == "" {
				return fmt.Errorf("--data is required")
			}

			// Parse JSON data
			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			// Find incident by number
			record, err := findIncidentByNumber(cmd.Context(), app, number)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")

			updated, err := app.SDK.Update(cmd.Context(), "incident", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update incident: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated incident %s", number)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn incidents show %s", number),
						Description: "View the updated incident",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required)")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newIncidentsDeleteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "delete [number]",
		Short: "Delete an incident",
		Long:  "Delete an incident by its number.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			number := args[0]

			// Find incident by number
			record, err := findIncidentByNumber(cmd.Context(), app, number)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")

			if err := app.SDK.Delete(cmd.Context(), "incident", sysID); err != nil {
				return fmt.Errorf("failed to delete incident: %w", err)
			}

			return app.OK(map[string]string{
				"number":  number,
				"message": "Incident deleted",
			}, output.WithSummary(fmt.Sprintf("Deleted incident %s", number)))
		},
	}

	return cmd
}

// listIncidents lists incidents with optional filtering
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listIncidents(ctx context.Context, app *appctx.App, query string, columns []string, limit, offset int) error {
	if len(columns) == 0 {
		columns = incidentDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listIncidentsInteractive(ctx, app, query, limit)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
	params.Set("sysparm_display_value", "all")
	// Always include sys_id for hyperlinks
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Default ordering: most recently updated first
	// Append ORDERBYDESC to any existing query
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "incident", params)
	if err != nil {
		return fmt.Errorf("failed to list incidents: %w", err)
	}

	// Format for display
	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn incidents create --description \"...\"",
			Description: "Create a new incident",
		},
		{
			Action:      "filter",
			Cmd:         "jsn incidents list --query \"priority=1\"",
			Description: "Filter: critical incidents only",
		},
	}

	// Add pagination breadcrumbs if applicable
	if len(records) == limit {
		// There's likely a next page
		nextOffset := offset + limit
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "next",
			Cmd:         fmt.Sprintf("jsn incidents list --limit %d --offset %d%s", limit, nextOffset, buildQuerySuffix(query)),
			Description: fmt.Sprintf("Next page (offset %d)", nextOffset),
		})
	}

	if offset > 0 {
		// There's a previous page
		prevOffset := offset - limit
		if prevOffset < 0 {
			prevOffset = 0
		}
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "prev",
			Cmd:         fmt.Sprintf("jsn inc list --limit %d --offset %d%s", limit, prevOffset, buildQuerySuffix(query)),
			Description: "Previous page",
		})
	}

	return app.OK(map[string]any{
		"table":   "incident",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"pagination": map[string]any{
			"limit":  limit,
			"offset": offset,
		},
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d incident(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listIncidentsInteractive shows an interactive picker for incidents with pagination
func listIncidentsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for incidents
	fetcher := tui.NewListFetcher("incident").
		WithColumns("number", "short_description", "priority", "state", "assigned_to").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			number := getStringField(record, "number")
			desc := getStringField(record, "short_description")
			priority := getStringField(record, "priority")
			state := getStringField(record, "state")
			assigned := getStringField(record, "assigned_to")
			sysID := getStringField(record, "sys_id")

			// Format title: ICON NUMBER DESC | STATE → ASSIGNED
			priorityIcon := getPriorityIcon(priority)
			stateStr := formatIncidentState(state)

			title := fmt.Sprintf("%s %s  %s  | %s", priorityIcon, number, truncateString(desc, 30), stateStr)
			if assigned != "" && assigned != "null" {
				title += fmt.Sprintf(" → %s", assigned)
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

	// If user selected an incident, show its details
	if selected != nil {
		// Find the incident number from the title
		// Title format: ICON NUMBER DESC | STATE...
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return getIncidentByNumber(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getIncidentBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getPriorityIcon returns an icon for the priority level.
func getPriorityIcon(priority string) string {
	switch priority {
	case "1", "Critical":
		return "🔴"
	case "2", "High":
		return "🟠"
	case "3", "Moderate":
		return "🟡"
	case "4", "Low":
		return "🟢"
	default:
		return "⚪"
	}
}

// formatIncidentState formats the incident state for display.
func formatIncidentState(state string) string {
	stateMap := map[string]string{
		"1": "New",
		"2": "In Progress",
		"3": "On Hold",
		"6": "Resolved",
		"7": "Closed",
		"8": "Canceled",
	}
	if mapped, ok := stateMap[state]; ok {
		return mapped
	}
	return state
}

// truncateString truncates a string to max length with ellipsis.
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

// getIncidentBySysID retrieves an incident by its sys_id.
func getIncidentBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(incidentDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "incident", params)
	if err != nil {
		return fmt.Errorf("failed to get incident: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("incident not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Incident %s", getStringField(records[0], "number"))),
	)
}

// buildQuerySuffix returns query flag string if query is set
func buildQuerySuffix(query string) string {
	if query != "" {
		return fmt.Sprintf(" --query \"%s\"", query)
	}
	return ""
}

// getIncidentByNumber retrieves an incident by its number
func getIncidentByNumber(ctx context.Context, app *appctx.App, number string) error {
	record, err := findIncidentByNumber(ctx, app, number)
	if err != nil {
		return err
	}

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "incident",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Incident %s", number)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "update",
				Cmd:         fmt.Sprintf("jsn incidents update %s --data '{...}'", number),
				Description: "Update this incident",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn incidents list",
				Description: "Back to all incidents",
			},
		),
	)
}

// findIncidentByNumber finds an incident by number and returns the record
func findIncidentByNumber(ctx context.Context, app *appctx.App, number string) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_query", "number="+number)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "incident", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find incident: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("incident not found: %s", number)
	}

	return records[0], nil
}

// getStringField safely extracts a string field from a record
func getStringField(record map[string]any, field string) string {
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
