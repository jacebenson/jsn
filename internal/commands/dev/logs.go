// Package dev provides developer utility commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// logDefaultColumns are the default columns to show for system logs
var logDefaultColumns = []string{"level", "message", "source", "created"}

// NewLogsCmd creates the logs command.
func NewLogsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Query ServiceNow system logs",
		Long: `Query and filter ServiceNow system logs from the syslog table.

Examples:
  # List recent logs
  jsn dev logs

  # Filter by log level
  jsn dev logs --level error

  # Filter by source
  jsn dev logs --source "Script Include"

  # Combine filters
  jsn dev logs --level error --source "Business Rule"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Get filter flags
			level, _ := cmd.Flags().GetString("level")
			source, _ := cmd.Flags().GetString("source")
			limit, _ := cmd.Flags().GetInt("limit")

			// Build query
			query := buildLogQuery(level, source)

			var columns []string
			if cols, _ := cmd.Flags().GetString("columns"); cols != "" {
				columns = strings.Split(cols, ",")
			} else {
				columns = logDefaultColumns
			}

			return listLogs(ctx, app, query, columns, limit)
		},
	}

	cmd.Flags().StringP("level", "l", "", "Filter by log level (error, warn, info, debug)")
	cmd.Flags().StringP("source", "s", "", "Filter by log source")
	cmd.Flags().StringP("columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntP("limit", "n", 50, "Maximum number of logs to return")

	cmd.AddCommand(
		newLogsListCmd(),
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
