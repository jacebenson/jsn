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

// changeDefaultColumns are the default columns to show for changes
var changeDefaultColumns = []string{"number", "short_description", "risk", "state", "assigned_to"}

// NewChangesCmd creates the changes command group.
func NewChangesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "changes",
		Aliases: []string{"change", "chg"},
		Short:   "Manage change requests",
		Long: `Manage change requests in ServiceNow.

Examples:
  # Show this help
  jsn changes

  # List change requests
  jsn changes list

  # Show a change request
  jsn changes show CHG0010001

  # List with a filter
  jsn changes list --query "risk=high"

  # Create a new change request
  jsn changes create --description "Deploy new feature" --risk medium

  # Update a change request
  jsn changes update CHG0010001 --data '{"state": "3"}'

  # Delete a change request
  jsn changes delete CHG0010001`,
	}

	cmd.AddCommand(
		newChangesListCmd(),
		newChangesShowCmd(),
		newChangesCreateCmd(),
		newChangesUpdateCmd(),
		newChangesDeleteCmd(),
	)

	return cmd
}

func newChangesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
		offset  int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List change requests",
		Long: `List change requests with optional filtering and pagination.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn chg list --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    jsn chg list --query "risk=high"                      # High risk only
    jsn chg list --query "state=-5"                       # Pending approval
    jsn chg list --query "start_date>javascript:gs.daysAgo(30)"  # Last 30 days`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = changeDefaultColumns
			}

			return listChanges(ctx, app, query, cols, limit, offset)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string (e.g., 'risk=high')")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")
	cmd.Flags().IntVarP(&offset, "offset", "o", 0, "Offset for pagination (number of records to skip)")

	return cmd
}

func newChangesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [number]",
		Short: "Show a specific change request",
		Long: `Display detailed information about a change request.

Examples:
  # Show change request by number
  jsn changes show CHG0010001`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return getChangeByNumber(ctx, app, args[0])
		},
	}
}

func newChangesCreateCmd() *cobra.Command {
	var (
		shortDesc string
		risk      string
		data      string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new change request",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			recordData := make(map[string]any)

			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			if shortDesc != "" {
				recordData["short_description"] = shortDesc
			}
			if risk != "" {
				recordData["risk"] = risk
			}

			if recordData["short_description"] == nil || recordData["short_description"] == "" {
				return fmt.Errorf("short_description is required (use --description or --data)")
			}

			record, err := app.SDK.Create(cmd.Context(), "change_request", recordData)
			if err != nil {
				return fmt.Errorf("failed to create change request: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created change request %s", getStringField(record, "number"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn changes show %s", getStringField(record, "number")),
						Description: "View the new change request",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&shortDesc, "description", "d", "", "Short description")
	cmd.Flags().StringVarP(&risk, "risk", "r", "", "Risk level (low, moderate, high)")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newChangesUpdateCmd() *cobra.Command {
	var data string

	cmd := &cobra.Command{
		Use:   "update [number]",
		Short: "Update a change request",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			number := args[0]

			if data == "" {
				return fmt.Errorf("--data is required")
			}

			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			record, err := findChangeByNumber(cmd.Context(), app, number)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")

			updated, err := app.SDK.Update(cmd.Context(), "change_request", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update change request: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated change request %s", number)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn changes show %s", number),
						Description: "View the updated change request",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newChangesDeleteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "delete [number]",
		Short: "Delete a change request",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			number := args[0]

			record, err := findChangeByNumber(cmd.Context(), app, number)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")

			if err := app.SDK.Delete(cmd.Context(), "change_request", sysID); err != nil {
				return fmt.Errorf("failed to delete change request: %w", err)
			}

			return app.OK(map[string]string{
				"number":  number,
				"message": "Change request deleted",
			}, output.WithSummary(fmt.Sprintf("Deleted change request %s", number)))
		},
	}

	return cmd
}

func listChanges(ctx context.Context, app *appctx.App, query string, columns []string, limit, offset int) error {
	if len(columns) == 0 {
		columns = changeDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listChangesInteractive(ctx, app, query, limit)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
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

	records, err := app.SDK.List(ctx, "change_request", params)
	if err != nil {
		return fmt.Errorf("failed to list change requests: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn changes create --description \"...\"",
			Description: "Create a new change request",
		},
		{
			Action:      "filter",
			Cmd:         "jsn chg list --query \"risk=high\"",
			Description: "Filter: high risk changes only",
		},
	}

	// Add pagination breadcrumbs if applicable
	if len(records) == limit {
		nextOffset := offset + limit
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "next",
			Cmd:         fmt.Sprintf("jsn chg list --limit %d --offset %d%s", limit, nextOffset, buildQuerySuffix(query)),
			Description: fmt.Sprintf("Next page (offset %d)", nextOffset),
		})
	}

	if offset > 0 {
		prevOffset := offset - limit
		if prevOffset < 0 {
			prevOffset = 0
		}
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "prev",
			Cmd:         fmt.Sprintf("jsn chg list --limit %d --offset %d%s", limit, prevOffset, buildQuerySuffix(query)),
			Description: "Previous page",
		})
	}

	return app.OK(map[string]any{
		"table":   "change_request",
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
		output.WithSummary(fmt.Sprintf("%d change request(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listChangesInteractive shows an interactive picker for change requests with pagination
func listChangesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for change requests
	fetcher := tui.NewListFetcher("change_request").
		WithColumns("number", "short_description", "risk", "state", "assigned_to").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			number := getStringField(record, "number")
			desc := getStringField(record, "short_description")
			risk := getStringField(record, "risk")
			state := getStringField(record, "state")
			assigned := getStringField(record, "assigned_to")
			sysID := getStringField(record, "sys_id")

			// Format title: ICON NUMBER DESC | STATE → ASSIGNED
			riskIcon := getRiskIcon(risk)
			stateStr := formatChangeState(state)

			title := fmt.Sprintf("%s %s  %s  | %s", riskIcon, number, truncateString(desc, 30), stateStr)
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

	// If user selected a change, show its details
	if selected != nil {
		// Find the change number from the title
		// Title format: ICON NUMBER DESC | STATE...
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return getChangeByNumber(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getChangeBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getRiskIcon returns an icon for the risk level.
func getRiskIcon(risk string) string {
	switch risk {
	case "1", "High":
		return "🔴"
	case "2", "Moderate":
		return "🟠"
	case "3", "Low":
		return "🟢"
	default:
		return "⚪"
	}
}

// formatChangeState formats the change state for display.
func formatChangeState(state string) string {
	stateMap := map[string]string{
		"-5": "New",
		"-4": "Assess",
		"-3": "Authorize",
		"-2": "Scheduled",
		"-1": "Implement",
		"0":  "Review",
		"3":  "Closed",
		"4":  "Canceled",
	}
	if mapped, ok := stateMap[state]; ok {
		return mapped
	}
	return state
}

// getChangeBySysID retrieves a change request by its sys_id.
func getChangeBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(changeDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "change_request", params)
	if err != nil {
		return fmt.Errorf("failed to get change request: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("change request not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Change request %s", getStringField(records[0], "number"))),
	)
}

func getChangeByNumber(ctx context.Context, app *appctx.App, number string) error {
	record, err := findChangeByNumber(ctx, app, number)
	if err != nil {
		return err
	}

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "change_request",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Change request %s", number)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "update",
				Cmd:         fmt.Sprintf("jsn changes update %s --data '{...}'", number),
				Description: "Update this change request",
			},
		),
	)
}

func findChangeByNumber(ctx context.Context, app *appctx.App, number string) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_query", "number="+number)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "change_request", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find change request: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("change request not found: %s", number)
	}

	return records[0], nil
}
