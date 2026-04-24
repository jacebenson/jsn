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
)

// taskDefaultColumns are the default columns to show for tasks
var taskDefaultColumns = []string{"number", "short_description", "state", "assigned_to"}

// NewTasksCmd creates the tasks command group.
func NewTasksCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "tasks [number]",
		Aliases: []string{"task", "sctask"},
		Short:   "Manage service catalog tasks",
		Long: `Manage service catalog tasks (SCTASK) in ServiceNow.

Examples:
  # List all tasks
  jsn tasks

  # Show a specific task by number
  jsn tasks SCTASK0010001

  # List with filter
  jsn tasks list --query "state=1"`,
		Run: func(cmd *cobra.Command, args []string) {
			// If no args, show help (like basecamp)
			// If arg provided, treat as task number to show
			if len(args) == 0 {
				_ = cmd.Help()
				return
			}

			// With args, run the show logic
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			if err := getTaskByNumber(ctx, app, args[0]); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
		},
	}

	cmd.AddCommand(
		newTasksListCmd(),
	)

	return cmd
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
