// Package dev provides developer utility commands.
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

// logDefaultColumns are the default columns to show for system logs
var logDefaultColumns = []string{"level", "message", "source", "created"}

// NewLogsCmd creates the logs command.
func NewLogsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Query ServiceNow system logs",
		Args:  cobra.NoArgs,
		Long: `Query and filter ServiceNow system logs from the syslog table.

Examples:
  # Show this help
  jsn dev logs

  # List recent logs
  jsn dev logs list

  # List by log level
  jsn dev logs list --level error

  # List by source
  jsn dev logs list --source "Script Include"

  # List with combined filters
  jsn dev logs list --level error --source "Business Rule"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newLogsListCmd(),
		newLogsShowCmd(),
	)

	return cmd
}

func newLogsListCmd() *cobra.Command {
	var (
		query   string
		level   string
		source  string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List system logs",
		Long:  "List system logs from the syslog table with optional filtering.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Build query from flags if no explicit query provided
			if query == "" {
				query = buildLogQuery(level, source)
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = logDefaultColumns
			}

			return listLogs(ctx, app, query, cols, limit)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVar(&level, "level", "", "Filter by log level (error, warn, info, debug)")
	cmd.Flags().StringVar(&source, "source", "", "Filter by log source")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of logs to return")

	return cmd
}

func newLogsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [sys_id]",
		Short: "Show a specific log entry",
		Long:  "Display detailed information about a specific system log entry by its sys_id.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			return getLogBySysID(ctx, app, args[0])
		},
	}
}

func buildLogQuery(level, source string) string {
	var parts []string

	if level != "" {
		// Map common level names to syslog level values
		levelValue := level
		switch strings.ToLower(level) {
		case "error":
			levelValue = "0" // Error
		case "warn", "warning":
			levelValue = "1" // Warning
		case "info", "information":
			levelValue = "2" // Information
		case "debug":
			levelValue = "3" // Debug
		}
		parts = append(parts, fmt.Sprintf("level=%s", levelValue))
	}

	if source != "" {
		parts = append(parts, fmt.Sprintf("sourceLIKE%s", source))
	}

	// Order by created descending (most recent first)
	if len(parts) > 0 {
		return strings.Join(parts, "^") + "^ORDERBYDESCcreated"
	}
	return "ORDERBYDESCcreated"
}

func listLogs(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = logDefaultColumns
	}

	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listLogsInteractive(ctx, app, query, 20)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
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

	records, err := app.SDK.List(ctx, "syslog", params)
	if err != nil {
		return fmt.Errorf("failed to list logs: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "syslog",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d log entry(s)", len(records))),
	)
}

// listLogsInteractive shows an interactive picker for system logs with pagination
func listLogsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for syslog
	fetcher := tui.NewListFetcher("syslog").
		WithColumns("level", "message", "source", "created").
		WithBaseQuery(baseQuery).
		WithOrderBy("ORDERBYDESCcreated").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			level := getStringField(record, "level")
			message := getStringField(record, "message")
			source := getStringField(record, "source")
			created := getStringField(record, "created")
			sysID := getStringField(record, "sys_id")

			// Format level icon
			icon := "◌"
			color := "#A0A0A0"
			switch level {
			case "0", "Error":
				icon = "✗"
				color = "#FF0000"
			case "1", "Warning":
				icon = "⚠"
				color = "#FFA500"
			case "2", "Information":
				icon = "ℹ"
				color = "#00AAFF"
			case "3", "Debug":
				icon = "🐛"
				color = "#888888"
			}

			// Format title: [ICON] [SOURCE] MESSAGE
			title := fmt.Sprintf("%s [%s] %s | %s", icon, source, truncateString(message, 40), created)
			_ = color // Color would need lipgloss styling in a real implementation

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

	// If user selected a log entry, show its details
	if selected != nil {
		return getLogBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getLogBySysID retrieves a log entry by its sys_id
func getLogBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "syslog", params)
	if err != nil {
		return fmt.Errorf("failed to find log entry: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("log entry not found: %s", sysID)
	}

	return app.OK(wrapRecordWithContext(records[0], "syslog", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Log Entry: %s", sysID)),
	)
}
