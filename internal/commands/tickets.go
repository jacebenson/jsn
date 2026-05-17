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

// TicketDefaultColumns are the default columns to show for tickets
var TicketDefaultColumns = []string{"number", "short_description"}

// NewTicketsCmd creates the tickets command group.
// This is a convenience wrapper around the generic records command for the ticket table.
func NewTicketsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "tickets",
		Aliases: []string{"ticket", "tickets"},
		Short:   "Tickets",
		Long: `Manage tickets in ServiceNow.

This command provides convenient access to the ticket table with sensible defaults.
For more advanced queries, use the generic 'records' command.

Examples:
  # Show this help
  jsn tickets

  # List tickets
  jsn tickets list

  # Show a ticket
  jsn tickets show \${NUMBER_PREFIX}0010001

  # List with a filter
  jsn tickets list --query "active=true"

  # Create a new ticket
  jsn tickets create --data '{"short_description": "..."}'

  # Update a ticket
  jsn tickets update \${NUMBER_PREFIX}0010001 --data '{"state": "..."}'

  # Delete a ticket
  jsn tickets delete \${NUMBER_PREFIX}0010001`,
	}

	cmd.AddCommand(
		newTicketsListCmd(),
		newTicketsShowCmd(),
		newTicketsCreateCmd(),
		newTicketsUpdateCmd(),
		newTicketsDeleteCmd(),
	)

	return cmd
}

func newTicketsListCmd() *cobra.Command {
	var (
		query  string
		limit  int
		offset int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List tickets",
		Long: `List tickets with optional filtering.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn tickets list --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    jsn tickets list --query "active=true"
    jsn tickets list --query "state=2^priority=1"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listTickets(ctx, app, query, offset)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "q", "", "Encoded query string (e.g., 'active=true')")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")
	cmd.Flags().IntVarP(&offset, "offset", "o", 0, "Offset for pagination (number of records to skip)")

	return cmd
}

func newTicketsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [number]",
		Short: "Show ticket details",
		Long:  "Retrieve and display detailed information about a specific ticket.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return getTicketByNumber(ctx, app, args[0])
		},
	}
}

func newTicketsCreateCmd() *cobra.Command {
	var dataStr string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new ticket",
		Long: `Create a new ticket in ServiceNow.

Examples:
  # Create a ticket
  jsn tickets create --data '{"short_description": "New ticket"}'
  
  # Create with specific fields
  jsn tickets create --data '{"short_description": "Issue", "priority": "2"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var data map[string]any
			if err := json.Unmarshal([]byte(dataStr), &data); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			record, err := app.SDK.Create(ctx, "ticket", data)
			if err != nil {
				return fmt.Errorf("failed to create ticket: %w", err)
			}

			return app.OK(record,
				output.WithSummary("Ticket created successfully"),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn tickets show %s", record["number"]),
						Description: "View the new ticket",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn tickets list",
						Description: "Back to list",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&dataStr, "data", "d", "", "JSON data for the new record (required)")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newTicketsUpdateCmd() *cobra.Command {
	var dataStr string

	cmd := &cobra.Command{
		Use:   "update [number]",
		Short: "Update a ticket",
		Long: `Update an existing ticket in ServiceNow.

Example:
  jsn tickets update \${NUMBER_PREFIX}0010001 --data '{"state": "6"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			number := args[0]

			var data map[string]any
			if err := json.Unmarshal([]byte(dataStr), &data); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			// Find the record first
			params := url.Values{}
			params.Set("sysparm_query", "number="+number)
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_fields", "sys_id")

			records, err := app.SDK.List(ctx, "ticket", params)
			if err != nil {
				return fmt.Errorf("failed to find ticket: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("ticket not found: %s", number)
			}

			sysID := getStringTicket(records[0], "sys_id")

			record, err := app.SDK.Update(ctx, "ticket", sysID, data)
			if err != nil {
				return fmt.Errorf("failed to update ticket: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Ticket %s updated", number)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn tickets show %s", number),
						Description: "View updated ticket",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn tickets list",
						Description: "Back to list",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&dataStr, "data", "d", "", "JSON data for updates (required)")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newTicketsDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete [number]",
		Short: "Delete a ticket",
		Long:  "Permanently delete a ticket from ServiceNow.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			number := args[0]

			// Find the record first
			params := url.Values{}
			params.Set("sysparm_query", "number="+number)
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_fields", "sys_id")

			records, err := app.SDK.List(ctx, "ticket", params)
			if err != nil {
				return fmt.Errorf("failed to find ticket: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("ticket not found: %s", number)
			}

			sysID := getStringTicket(records[0], "sys_id")

			if err := app.SDK.Delete(ctx, "ticket", sysID); err != nil {
				return fmt.Errorf("failed to delete ticket: %w", err)
			}

			return app.OK(map[string]any{
				"deleted": true,
				"number":  number,
				"sys_id":  sysID,
				"table":   "ticket",
			},
				output.WithSummary(fmt.Sprintf("Ticket %s deleted", number)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn tickets list",
						Description: "Back to list",
					},
				),
			)
		},
	}
}

// listTickets lists tickets with the given query and offset
func listTickets(ctx context.Context, app *appctx.App, query string, offset int) error {
	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listTicketsInteractive(ctx, app, query)
	}

	params := url.Values{}
	params.Set("sysparm_limit", "20")
	params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(TicketDefaultColumns, ","))

	// Default sort by sys_updated_on descending
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "ticket", params)
	if err != nil {
		return fmt.Errorf("failed to list tickets: %w", err)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn tickets show <number>",
			Description: "Show ticket details",
		},
		{
			Action:      "create",
			Cmd:         "jsn tickets create --data '{...}'",
			Description: "Create a new ticket",
		},
	}

	// Add pagination breadcrumbs if applicable
	if len(records) == 20 {
		nextOffset := offset + 20
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "next",
			Cmd:         fmt.Sprintf("jsn tickets list --offset %d%s", nextOffset, buildTicketQuerySuffix(query)),
			Description: fmt.Sprintf("Next page (offset %d)", nextOffset),
		})
	}

	if offset > 0 {
		prevOffset := offset - 20
		if prevOffset < 0 {
			prevOffset = 0
		}
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "prev",
			Cmd:         fmt.Sprintf("jsn tickets list --offset %d%s", prevOffset, buildTicketQuerySuffix(query)),
			Description: "Previous page",
		})
	}

	return app.OK(map[string]any{
		"table":   "ticket",
		"count":   len(records),
		"columns": TicketDefaultColumns,
		"records": records,
		"pagination": map[string]any{
			"limit":  20,
			"offset": offset,
		},
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d ticket(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// getTicketByNumber retrieves a ticket by its number field
func getTicketByNumber(ctx context.Context, app *appctx.App, number string) error {
	params := url.Values{}
	params.Set("sysparm_query", "number="+number)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")

	records, err := app.SDK.List(ctx, "ticket", params)
	if err != nil {
		return fmt.Errorf("failed to get ticket: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("ticket not found: %s", number)
	}

	record := records[0]

	// Add context and formatted data
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "ticket",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Ticket %s", number)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "update",
				Cmd:         fmt.Sprintf("jsn tickets update %s --data '{...}'", number),
				Description: "Update this ticket",
			},
			output.Breadcrumb{
				Action:      "delete",
				Cmd:         fmt.Sprintf("jsn tickets delete %s", number),
				Description: "Delete this ticket",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn tickets list",
				Description: "Back to all tickets",
			},
		),
	)
}

// buildTicketQuerySuffix returns query flag string if query is set
func buildTicketQuerySuffix(query string) string {
	if query != "" {
		return fmt.Sprintf(" --query \"%s\"", query)
	}
	return ""
}

// getStringTicket extracts a string field from a record
func getStringTicket(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects
			if value, ok := v["value"].(string); ok {
				return value
			}
			if display, ok := v["display_value"].(string); ok {
				return display
			}
		}
	}
	return ""
}

// listTicketsInteractive shows an interactive picker for tickets
func listTicketsInteractive(ctx context.Context, app *appctx.App, baseQuery string) error {
	// Create a reusable list fetcher configured for tickets
	fetcher := tui.NewListFetcher("ticket").
		WithColumns("number", "short_description", "state").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			number := getStringTicket(record, "number")
			desc := getStringTicket(record, "short_description")
			state := getStringTicket(record, "state")
			sysID := getStringTicket(record, "sys_id")

			// Format title: ICON NUMBER DESC | STATE
			stateIcon := getTicketStateIcon(state)
			stateStr := formatTicketState(state)

			title := fmt.Sprintf("%s %s  %s  | %s", stateIcon, number, truncateString(desc, 30), stateStr)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	// Show the interactive picker
	selected, err := tui.ListInteractive(ctx, app, fetcher, 20)
	if err != nil {
		return err
	}

	// If user selected a ticket, show its details
	if selected != nil {
		// Find the ticket number from the title
		// Title format: ICON NUMBER DESC | STATE...
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return getTicketByNumber(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getTicketBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getTicketStateIcon returns an icon for the ticket state
func getTicketStateIcon(state string) string {
	switch state {
	case "1": // New
		return "🆕"
	case "2": // In Progress
		return "🔄"
	case "3": // On Hold
		return "⏸️"
	case "6": // Resolved
		return "✅"
	case "7": // Closed
		return "🔒"
	case "8": // Canceled
		return "❌"
	default:
		return "⚪"
	}
}

// formatTicketState formats the ticket state for display
func formatTicketState(state string) string {
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

// getTicketBySysID retrieves a ticket by its sys_id
func getTicketBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(TicketDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "ticket", params)
	if err != nil {
		return fmt.Errorf("failed to get ticket: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("ticket not found: %s", sysID)
	}

	record := records[0]
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "ticket",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Ticket %s", getStringTicket(records[0], "number"))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn tickets list",
				Description: "Back to all tickets",
			},
		),
	)
}
