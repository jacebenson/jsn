// Package commands provides CLI commands.
package commands

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
)

// requestDefaultColumns are the default columns to show for requests
var requestDefaultColumns = []string{"number", "short_description", "request_state", "requested_for"}

// NewRequestsCmd creates the requests command group.
func NewRequestsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "requests",
		Aliases: []string{"request", "req", "ritm"},
		Short:   "Manage service catalog requests",
		Long: `Manage service catalog requests (RITM) in ServiceNow.

Examples:
  # Show this help
  jsn requests

  # List requests
  jsn requests list

  # Show a request
  jsn requests show RITM0010001

  # List with a filter
  jsn requests list --query "request_state=1"`,
	}

	cmd.AddCommand(
		newRequestsListCmd(),
		newRequestsShowCmd(),
	)

	return cmd
}

func newRequestsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [number]",
		Short: "Show a specific request by number",
		Long: `Display detailed information about a service catalog request by its number.

Examples:
  # Show request by number
  jsn requests show RITM0010001`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			number := args[0]

			return getRequestByNumber(ctx, app, number)
		},
	}
}

func newRequestsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
		offset  int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List service catalog requests",
		Long: `List service catalog requests with optional filtering and pagination.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn req list --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    jsn req list --query "stage=request"              # Request stage only
    jsn req list --query "requested_for=jsmith"       # For specific user
    jsn req list --query "cat_item=12345"            # Specific catalog item`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = requestDefaultColumns
			}

			return listRequests(ctx, app, query, cols, limit, offset)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")
	cmd.Flags().IntVarP(&offset, "offset", "o", 0, "Offset for pagination (number of records to skip)")

	return cmd
}

func listRequests(ctx context.Context, app *appctx.App, query string, columns []string, limit, offset int) error {
	if len(columns) == 0 {
		columns = requestDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listRequestsInteractive(ctx, app, query, limit)
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

	records, err := app.SDK.List(ctx, "sc_req_item", params)
	if err != nil {
		return fmt.Errorf("failed to list requests: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "filter",
			Cmd:         "jsn req list --query \"stage=request\"",
			Description: "Filter: request stage only",
		},
	}

	// Add pagination breadcrumbs if applicable
	if len(records) == limit {
		nextOffset := offset + limit
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "next",
			Cmd:         fmt.Sprintf("jsn req list --limit %d --offset %d%s", limit, nextOffset, buildQuerySuffix(query)),
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
			Cmd:         fmt.Sprintf("jsn req list --limit %d --offset %d%s", limit, prevOffset, buildQuerySuffix(query)),
			Description: "Previous page",
		})
	}

	return app.OK(map[string]any{
		"table":   "sc_req_item",
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
		output.WithSummary(fmt.Sprintf("%d request(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listRequestsInteractive shows an interactive picker for requests with pagination
func listRequestsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for requests
	fetcher := tui.NewListFetcher("sc_req_item").
		WithColumns("number", "short_description", "request_state", "requested_for").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			number := getStringField(record, "number")
			desc := getStringField(record, "short_description")
			state := getStringField(record, "request_state")
			requestedFor := getStringField(record, "requested_for")
			sysID := getStringField(record, "sys_id")

			// Format title: NUMBER DESC | STATE → REQUESTED_FOR
			stateStr := formatRequestState(state)
			title := fmt.Sprintf("%s  %s  | %s", number, truncateString(desc, 35), stateStr)
			if requestedFor != "" && requestedFor != "null" {
				title += fmt.Sprintf(" → %s", requestedFor)
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

	// If user selected a request, show its details
	if selected != nil {
		// Find the request number from the title
		// Title format: NUMBER DESC | STATE...
		parts := strings.SplitN(selected.Title, " ", 2)
		if len(parts) >= 1 {
			return getRequestByNumber(ctx, app, parts[0])
		}
		// Fallback: try to get by sys_id
		return getRequestBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// formatRequestState formats the request state for display.
func formatRequestState(state string) string {
	stateMap := map[string]string{
		"1":  "Pending",
		"2":  "Approved",
		"3":  "Rejected",
		"4":  "Closed Complete",
		"5":  "Closed Incomplete",
		"6":  "Closed Skipped",
		"7":  "Closed Cancelled",
		"8":  "Work in Progress",
		"9":  "Closed",
		"10": "Pending Approval",
		"11": "Approved",
		"12": "Not Approved",
		"13": "Requested",
		"14": "In Progress",
		"15": "Closed Complete",
		"16": "Closed Incomplete",
		"17": "Closed Skipped",
		"18": "Closed Cancelled",
	}
	if mapped, ok := stateMap[state]; ok {
		return mapped
	}
	return state
}

// getRequestBySysID retrieves a request by its sys_id.
func getRequestBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(requestDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "sc_req_item", params)
	if err != nil {
		return fmt.Errorf("failed to get request: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("request not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Request %s", getStringField(records[0], "number"))),
	)
}

func getRequestByNumber(ctx context.Context, app *appctx.App, number string) error {
	// Fetch main record
	params := url.Values{}
	params.Set("sysparm_query", "number="+number)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,number,cat_item,request.requested_for,quantity,price,recurring_price,stage,state,comments,work_notes,short_description,description,opened_at,opened_by,assigned_to,approval")

	records, err := app.SDK.List(ctx, "sc_req_item", params)
	if err != nil {
		return fmt.Errorf("failed to find request: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("request not found: %s", number)
	}

	record := records[0]
	sysID := sdk.GetDisplayValue(record, "sys_id")
	instanceURL := app.Config.GetEffectiveInstance()

	// Fetch related data concurrently
	type result struct {
		attachments []map[string]any
		variables   []sdk.Variable
		err         error
	}

	resultChan := make(chan result, 1)

	go func() {
		// Fetch attachments
		attachments, _ := app.SDK.FetchAttachments(ctx, "sc_req_item", sysID)

		// Fetch variables
		variables, _ := app.SDK.FetchCatalogVariables(ctx, sysID)

		resultChan <- result{attachments, variables, nil}
	}()

	r := <-resultChan

	// Format output
	formatted := formatRequestItemDisplay(record, r.attachments, r.variables, instanceURL)

	return app.OK(map[string]any{
		"_formatted": formatted,
		"_raw": map[string]any{
			"record":      record,
			"attachments": r.attachments,
			"variables":   r.variables,
		},
		"_context": map[string]any{
			"instance_url": instanceURL,
			"table":        "sc_req_item",
		},
	},
		output.WithSummary(fmt.Sprintf("Request %s", number)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn requests list",
				Description: "Back to all requests",
			},
		),
	)
}

// formatRequestItemDisplay formats a request item for terminal display.
// This is command-specific formatting owned by the requests command.
func formatRequestItemDisplay(record map[string]any, attachments []map[string]any, variables []sdk.Variable, instanceURL string) string {
	var b strings.Builder

	number := sdk.GetDisplayValue(record, "number")
	if number == "" {
		number = "Unknown Request"
	}

	b.WriteString(fmt.Sprintf("\n%s\n\n", number))

	// Item section
	b.WriteString(tui.SectionHeader("Item"))
	b.WriteString("\n")

	itemFields := []struct {
		label string
		field string
	}{
		{"catalog item", "cat_item"},
		{"requested for", "request.requested_for"},
		{"quantity", "quantity"},
		{"price", "price"},
		{"recurring price", "recurring_price"},
	}

	for _, f := range itemFields {
		value := sdk.GetDisplayValue(record, f.field)
		if value != "" {
			b.WriteString(fmt.Sprintf("  %s: %s\n", f.label, value))
		}
	}
	b.WriteString("\n")

	// Status section
	b.WriteString(tui.SectionHeader("Status"))
	b.WriteString("\n")

	statusFields := []struct {
		label string
		field string
	}{
		{"stage", "stage"},
		{"state", "state"},
		{"approval", "approval"},
		{"assigned", "assigned_to"},
	}

	for _, f := range statusFields {
		value := sdk.GetDisplayValue(record, f.field)
		if value != "" {
			b.WriteString(fmt.Sprintf("  %s: %s\n", f.label, value))
		}
	}
	b.WriteString("\n")

	// Variables section
	if len(variables) > 0 {
		b.WriteString(tui.SectionHeader("Variables"))
		b.WriteString("\n")
		for _, v := range variables {
			b.WriteString(fmt.Sprintf("  %s: %s\n", v.Question, v.Value))
		}
		b.WriteString("\n")
	}

	// Comments/Activity section
	comments := sdk.GetDisplayValue(record, "comments")
	workNotes := sdk.GetDisplayValue(record, "work_notes")
	if comments != "" || workNotes != "" {
		b.WriteString(tui.SectionHeader("Activity"))
		b.WriteString("\n")
		if comments != "" {
			b.WriteString("  Comments:\n")
			for _, line := range strings.Split(comments, "\n") {
				if line != "" {
					b.WriteString(fmt.Sprintf("    %s\n", line))
				}
			}
		}
		if workNotes != "" {
			b.WriteString("  Work Notes:\n")
			for _, line := range strings.Split(workNotes, "\n") {
				if line != "" {
					b.WriteString(fmt.Sprintf("    %s\n", line))
				}
			}
		}
		b.WriteString("\n")
	}

	// Attachments section
	if len(attachments) > 0 {
		b.WriteString(tui.SectionHeader("Attachments"))
		b.WriteString("\n")
		for _, att := range attachments {
			fileName := sdk.GetDisplayValue(att, "file_name")
			createdOn := sdk.GetDisplayValue(att, "sys_created_on")
			createdBy := sdk.GetDisplayValue(att, "sys_created_by")
			attSysID := sdk.GetDisplayValue(att, "sys_id")

			if fileName != "" {
				// Create clickable link for attachment
				if attSysID != "" && instanceURL != "" {
					attLink := tui.FormatAttachmentLink(instanceURL, attSysID)
					fileName = output.Hyperlink(fileName, attLink)
				}

				if createdBy != "" && createdOn != "" {
					b.WriteString(fmt.Sprintf("  %s (by %s on %s)\n", fileName, createdBy, createdOn))
				} else {
					b.WriteString(fmt.Sprintf("  %s\n", fileName))
				}
			}
		}
		b.WriteString("\n")
	}

	// Link to record
	sysID := sdk.GetDisplayValue(record, "sys_id")
	if instanceURL != "" && sysID != "" {
		link := tui.FormatLink(instanceURL, "sc_req_item", sysID)
		b.WriteString(fmt.Sprintf("Link:  %s\n\n", link))
	}

	return b.String()
}
