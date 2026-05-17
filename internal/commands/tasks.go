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
	"github.com/jacebenson/jsn/internal/tui"
)

// taskDefaultColumns are the default columns to show for tasks
var taskDefaultColumns = []string{"number", "short_description", "state", "assigned_to"}

// NewTasksCmd creates the tasks command group.
func NewTasksCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "tasks",
		Aliases: []string{"task", "sctask"},
		Short:   "Manage service catalog tasks",
		Long: `Manage service catalog tasks (SCTASK) in ServiceNow.

Examples:
  # Show this help
  jsn tasks

  # List tasks
  jsn tasks list

  # Show a task
  jsn tasks show SCTASK0010001

  # List with a filter
  jsn tasks list --query "state=1"`,
	}

	cmd.AddCommand(
		newTasksListCmd(),
		newTasksShowCmd(),
	)

	return cmd
}

func newTasksShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [number]",
		Short: "Show a specific task by number",
		Long: `Display detailed information about a service catalog task by its number.

Examples:
  # Show task by number
  jsn tasks show SCTASK0010001`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			number := args[0]

			return getTaskByNumber(ctx, app, number)
		},
	}
}

func newTasksListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List service catalog tasks",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = taskDefaultColumns
			}

			return listTasks(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func listTasks(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = taskDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listTasksInteractive(ctx, app, query)
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

	records, err := app.SDK.List(ctx, "sc_task", params)
	if err != nil {
		return fmt.Errorf("failed to list tasks: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sc_task",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d task(s)", len(records))),
	)
}

func getTaskByNumber(ctx context.Context, app *appctx.App, number string) error {
	params := url.Values{}
	params.Set("sysparm_query", "number="+number)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sc_task", params)
	if err != nil {
		return fmt.Errorf("failed to find task: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("task not found: %s", number)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Task %s", number)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn tasks list",
				Description: "Back to all tasks",
			},
		),
	)
}

// listTasksInteractive shows an interactive picker for tasks
func listTasksInteractive(ctx context.Context, app *appctx.App, baseQuery string) error {
	// Create a reusable list fetcher configured for tasks
	fetcher := tui.NewListFetcher("sc_task").
		WithColumns("number", "short_description", "state", "assigned_to").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			number := getStringField(record, "number")
			desc := getStringField(record, "short_description")
			state := getStringField(record, "state")
			assigned := getStringField(record, "assigned_to")
			sysID := getStringField(record, "sys_id")

			// Format title: ICON NUMBER DESC | STATE → ASSIGNED
			stateIcon := getTaskStatusIcon(state)
			stateStr := formatTaskState(state)

			title := fmt.Sprintf("%s %s  %s  | %s", stateIcon, number, truncateString(desc, 30), stateStr)
			if assigned != "" && assigned != "null" {
				title += fmt.Sprintf(" → %s", assigned)
			}

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

	// If user selected a task, show its details
	if selected != nil {
		// Find the task number from the title
		// Title format: ICON NUMBER DESC | STATE...
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return getTaskByNumber(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getTaskBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getTaskStatusIcon returns an icon for the task state
func getTaskStatusIcon(state string) string {
	switch state {
	case "-5": // Pending
		return "⏳"
	case "1": // Open
		return "📋"
	case "2": // Work in Progress
		return "🔧"
	case "3": // Closed Complete
		return "✅"
	case "4": // Closed Incomplete
		return "⛔"
	case "7": // Closed Skipped
		return "⏭️"
	default:
		return "⚪"
	}
}

// formatTaskState formats the task state for display
func formatTaskState(state string) string {
	stateMap := map[string]string{
		"-5": "Pending",
		"1":  "Open",
		"2":  "Work in Progress",
		"3":  "Closed Complete",
		"4":  "Closed Incomplete",
		"7":  "Closed Skipped",
	}
	if mapped, ok := stateMap[state]; ok {
		return mapped
	}
	return state
}

// getTaskBySysID retrieves a task by its sys_id
func getTaskBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(taskDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "sc_task", params)
	if err != nil {
		return fmt.Errorf("failed to get task: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("task not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Task %s", getStringField(records[0], "number"))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn tasks list",
				Description: "Back to all tasks",
			},
		),
	)
}
