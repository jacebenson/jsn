// Package commands provides CLI commands.
package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// RecordsFlags holds the flags for the records command.
type recordsFlags struct {
	table   string
	query   string
	columns string
	limit   int
}

// tableDefaultColumns defines default columns to show for common tables
var tableDefaultColumns = map[string][]string{
	"incident":       {"number", "short_description", "priority", "state", "assigned_to"},
	"change_request": {"number", "short_description", "risk", "state", "assigned_to"},
	"change_task":    {"number", "short_description", "state", "assigned_to"},
	"problem":        {"number", "short_description", "priority", "state", "assigned_to"},
	"sc_request":     {"number", "short_description", "request_state", "requested_for"},
	"sc_req_item":    {"number", "short_description", "stage", "assigned_to"},
	"sc_task":        {"number", "short_description", "state", "assigned_to"},
	"sys_user":       {"user_name", "name", "email", "active"},
	"sys_user_group": {"name", "manager", "email"},
	"cmdb_ci":        {"name", "operational_status", "ip_address"},
	"cmdb_ci_server": {"name", "operational_status", "ip_address"},
	"kb_knowledge":   {"number", "short_description", "workflow_state", "author"},
}

// getDefaultColumns returns default columns for a table
func getDefaultColumns(table string) []string {
	if cols, ok := tableDefaultColumns[table]; ok {
		return cols
	}
	// Generic fallback - common fields most tables have
	return []string{"sys_id"}
}

// FormatRecordForDisplay formats a record for display, extracting display values
func FormatRecordForDisplay(record map[string]any, columns []string) map[string]string {
	result := make(map[string]string)

	// Helper to extract string value from various types
	extractValue := func(val any) string {
		if val == nil {
			return ""
		}
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects from sysparm_display_value=true
			if display, ok := v["display_value"].(string); ok && display != "" {
				return display
			}
			if value, ok := v["value"].(string); ok {
				return value
			}
			return fmt.Sprintf("%v", v)
		default:
			return fmt.Sprintf("%v", v)
		}
	}

	// Always include sys_id for hyperlinks
	if sysID, ok := record["sys_id"]; ok && sysID != nil {
		result["sys_id"] = extractValue(sysID)
	}

	for _, col := range columns {
		if val, ok := record[col]; ok && val != nil {
			result[col] = extractValue(val)
		} else {
			result[col] = ""
		}
	}
	return result
}

// NewRecordsCmd creates the records command group.
// This is the generic Table API fallback - works with any ServiceNow table.
func NewRecordsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "records",
		Short: "Query and manage records in any table",
		Long: `Query and manage records in any ServiceNow table.

This is the generic Table API fallback that works with any table.
Specific commands like "incidents", "changes", etc. are aliases to this.

When no columns are specified, reasonable defaults are shown based on the table type.

Examples:
  # List all incidents (shows number, short_description, priority, state by default)
  jsn records list --table incident

  # Query with encoded query
  jsn records list --table incident --query "priority=1^active=true"

  # Show specific columns
  jsn records list --table incident --columns "number,short_description,priority,state"

  # Get a single record by sys_id
  jsn records get --table incident --sys-id abc123

  # Create a record
  jsn records create --table incident --data '{"short_description": "Test incident"}'

  # Update a record
  jsn records update --table incident --sys-id abc123 --data '{"priority": "1"}'

  # Delete a record
  jsn records delete --table incident --sys-id abc123`,
	}

	cmd.AddCommand(
		newRecordsListCmd(),
		newRecordsGetCmd(),
		newRecordsCreateCmd(),
		newRecordsUpdateCmd(),
		newRecordsDeleteCmd(),
	)

	return cmd
}

func newRecordsListCmd() *cobra.Command {
	var (
		flags  recordsFlags
		offset int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List records from a table",
		Long: `List records from any ServiceNow table with optional filtering and pagination.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn records list --table incident --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    jsn records list --table incident --query "priority=1"                    # Critical only
    jsn records list --table incident --query "active=true^assigned_to="      # Unassigned
    jsn records list --table incident --query "opened_at>javascript:gs.daysAgo(7)"  # Last 7 days`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			if flags.table == "" {
				return fmt.Errorf("--table is required")
			}

			// Determine columns to display
			var columns []string
			if flags.columns != "" {
				columns = strings.Split(flags.columns, ",")
			} else {
				columns = getDefaultColumns(flags.table)
			}

			// Build query parameters
			params := url.Values{}
			params.Set("sysparm_limit", fmt.Sprintf("%d", flags.limit))
			params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
			// Request display values for reference fields ("all" gives us both display and value)
			params.Set("sysparm_display_value", "all")
			// Request specific fields - always include sys_id for hyperlinks
			fetchColumns := append([]string{"sys_id"}, columns...)
			params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
			if flags.query != "" {
				params.Set("sysparm_query", flags.query)
			}

			// Fetch records
			records, err := app.SDK.List(cmd.Context(), flags.table, params)
			if err != nil {
				return fmt.Errorf("failed to list records: %w", err)
			}

			// Format records for display
			var displayRecords []map[string]string
			for _, record := range records {
				displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
			}

			// Build breadcrumbs
			breadcrumbs := []output.Breadcrumb{
				{
					Action:      "create",
					Cmd:         fmt.Sprintf("jsn records create --table %s --data '{...}'", flags.table),
					Description: "Create a new record",
				},
				{
					Action:      "filter",
					Cmd:         fmt.Sprintf("jsn records list --table %s --query \"priority=1\"", flags.table),
					Description: "Filter: priority 1 only",
				},
				{
					Action:      "columns",
					Cmd:         fmt.Sprintf("jsn dev columns --table %s", flags.table),
					Description: "View available columns for this table",
				},
			}

			// Add pagination breadcrumbs if applicable
			if len(records) == flags.limit {
				nextOffset := offset + flags.limit
				breadcrumbs = append(breadcrumbs, output.Breadcrumb{
					Action:      "next",
					Cmd:         fmt.Sprintf("jsn records list --table %s --limit %d --offset %d%s", flags.table, flags.limit, nextOffset, buildQuerySuffix(flags.query)),
					Description: fmt.Sprintf("Next page (offset %d)", nextOffset),
				})
			}

			if offset > 0 {
				prevOffset := offset - flags.limit
				if prevOffset < 0 {
					prevOffset = 0
				}
				breadcrumbs = append(breadcrumbs, output.Breadcrumb{
					Action:      "prev",
					Cmd:         fmt.Sprintf("jsn records list --table %s --limit %d --offset %d%s", flags.table, flags.limit, prevOffset, buildQuerySuffix(flags.query)),
					Description: "Previous page",
				})
			}

			return app.OK(map[string]any{
				"table":   flags.table,
				"count":   len(records),
				"columns": columns,
				"records": displayRecords,
				"pagination": map[string]any{
					"limit":  flags.limit,
					"offset": offset,
				},
				"context": map[string]any{
					"instance_url": app.Config.GetEffectiveInstance(),
				},
			},
				output.WithSummary(fmt.Sprintf("%d record(s) from %s", len(records), flags.table)),
				output.WithBreadcrumbs(breadcrumbs...),
			)
		},
	}

	cmd.Flags().StringVar(&flags.table, "table", "", "Table name (required)")
	cmd.Flags().StringVar(&flags.query, "query", "", "Encoded query string")
	cmd.Flags().StringVar(&flags.columns, "columns", "", "Comma-separated list of columns to display (defaults to table-specific columns)")
	cmd.Flags().IntVar(&flags.limit, "limit", 20, "Maximum number of records to return")
	cmd.Flags().IntVar(&offset, "offset", 0, "Offset for pagination (number of records to skip)")

	_ = cmd.MarkFlagRequired("table")

	return cmd
}

func newRecordsGetCmd() *cobra.Command {
	var (
		table   string
		sysID   string
		columns string
	)

	cmd := &cobra.Command{
		Use:   "get",
		Short: "Get a single record by sys_id",
		Long:  "Retrieve a single record from any table by its sys_id.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			if table == "" {
				return fmt.Errorf("--table is required")
			}
			if sysID == "" {
				return fmt.Errorf("--sys-id is required")
			}

			// Build query with display values
			params := url.Values{}
			params.Set("sysparm_display_value", "true")
			if columns != "" {
				params.Set("sysparm_fields", columns)
			}

			// For single record, we need to query by sys_id
			params.Set("sysparm_query", "sys_id="+sysID)
			records, err := app.SDK.List(cmd.Context(), table, params)
			if err != nil {
				return fmt.Errorf("failed to get record: %w", err)
			}
			if len(records) == 0 {
				return fmt.Errorf("record not found: %s", sysID)
			}

			return app.OK(records[0], output.WithSummary(fmt.Sprintf("Record from %s", table)))
		},
	}

	cmd.Flags().StringVar(&table, "table", "", "Table name (required)")
	cmd.Flags().StringVar(&sysID, "sys-id", "", "Record sys_id (required)")
	cmd.Flags().StringVar(&columns, "columns", "", "Comma-separated list of columns to return")

	_ = cmd.MarkFlagRequired("table")
	_ = cmd.MarkFlagRequired("sys-id")

	return cmd
}

func newRecordsCreateCmd() *cobra.Command {
	var (
		table string
		data  string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new record",
		Long:  "Create a new record in any ServiceNow table.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			if table == "" {
				return fmt.Errorf("--table is required")
			}
			if data == "" {
				return fmt.Errorf("--data is required")
			}

			// Parse JSON data
			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			record, err := app.SDK.Create(cmd.Context(), table, recordData)
			if err != nil {
				return fmt.Errorf("failed to create record: %w", err)
			}

			return app.OK(record, output.WithSummary(fmt.Sprintf("Created record in %s", table)))
		},
	}

	cmd.Flags().StringVar(&table, "table", "", "Table name (required)")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for the record (required)")

	_ = cmd.MarkFlagRequired("table")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newRecordsUpdateCmd() *cobra.Command {
	var (
		table string
		sysID string
		data  string
	)

	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update an existing record",
		Long:  "Update an existing record in any ServiceNow table.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			if table == "" {
				return fmt.Errorf("--table is required")
			}
			if sysID == "" {
				return fmt.Errorf("--sys-id is required")
			}
			if data == "" {
				return fmt.Errorf("--data is required")
			}

			// Parse JSON data
			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			record, err := app.SDK.Update(cmd.Context(), table, sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update record: %w", err)
			}

			return app.OK(record, output.WithSummary(fmt.Sprintf("Updated record in %s", table)))
		},
	}

	cmd.Flags().StringVar(&table, "table", "", "Table name (required)")
	cmd.Flags().StringVar(&sysID, "sys-id", "", "Record sys_id (required)")
	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required)")

	_ = cmd.MarkFlagRequired("table")
	_ = cmd.MarkFlagRequired("sys-id")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newRecordsDeleteCmd() *cobra.Command {
	var (
		table string
		sysID string
	)

	cmd := &cobra.Command{
		Use:   "delete",
		Short: "Delete a record",
		Long:  "Delete a record from any ServiceNow table.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			if table == "" {
				return fmt.Errorf("--table is required")
			}
			if sysID == "" {
				return fmt.Errorf("--sys-id is required")
			}

			if err := app.SDK.Delete(cmd.Context(), table, sysID); err != nil {
				return fmt.Errorf("failed to delete record: %w", err)
			}

			return app.OK(map[string]string{
				"message": "Record deleted",
				"table":   table,
				"sys_id":  sysID,
			}, output.WithSummary(fmt.Sprintf("Deleted record from %s", table)))
		},
	}

	cmd.Flags().StringVar(&table, "table", "", "Table name (required)")
	cmd.Flags().StringVar(&sysID, "sys-id", "", "Record sys_id (required)")

	_ = cmd.MarkFlagRequired("table")
	_ = cmd.MarkFlagRequired("sys-id")

	return cmd
}

// ExecuteRecordsList executes a list command for a specific table.
// This is used by aliased commands like "incidents list", "changes list", etc.
func ExecuteRecordsList(ctx context.Context, app *appctx.App, table string, query string, columns []string, limit int) error {
	// Use default columns if none specified
	if len(columns) == 0 {
		columns = getDefaultColumns(table)
	}

	params := url.Values{}
	if limit > 0 {
		params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	}
	params.Set("sysparm_display_value", "true")
	params.Set("sysparm_fields", strings.Join(columns, ","))
	if query != "" {
		params.Set("sysparm_query", query)
	}

	records, err := app.SDK.List(ctx, table, params)
	if err != nil {
		return fmt.Errorf("failed to list records: %w", err)
	}

	// Format for display
	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   table,
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
	}, output.WithSummary(fmt.Sprintf("%d record(s) from %s", len(records), table)))
}
