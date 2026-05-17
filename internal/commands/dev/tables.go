// Package dev provides developer utility commands.
package dev

import (
	"bufio"
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

// tableDefaultColumns are the default columns to show for tables
var tableDefaultColumns = []string{"name", "label", "super_class", "create_access_controls"}

// tableDetailColumns are the columns to fetch for table details (show command)
var tableDetailColumns = []string{"name", "label", "super_class", "create_access_controls", "sys_scope", "sys_created_on", "sys_updated_on", "sys_created_by", "sys_updated_by", "is_extendable"}

// NewTablesCmd creates the tables command.
func NewTablesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "tables",
		Aliases: []string{"table"},
		Short:   "Manage ServiceNow table definitions",
		Args:    cobra.NoArgs,
		Long: `Manage ServiceNow table definitions from the sys_db_object table.

Examples:
  # Show this help
  jsn dev tables

  # List all tables
  jsn dev tables list

  # Show specific table details
  jsn dev tables show incident

  # List with filter
  jsn dev tables list --query "super_class=task"

  # Create a new table
  jsn dev tables create --name u_my_table --label "My Table" --extends task

  # Update a table label
  jsn dev tables update u_my_table --label "Updated Label"

  # Delete a table
  jsn dev tables delete u_my_table`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newTablesListCmd(),
		newTablesShowCmd(),
		newTablesCreateCmd(),
		newTablesUpdateCmd(),
		newTablesDeleteCmd(),
		// REMOVED: newTablesColumnsCmd() - columns is now a separate top-level command
	)

	return cmd
}

func newTablesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List table definitions",
		Long: `List table definitions with optional filtering and column selection.

Examples:
  # List all tables
  jsn dev tables list

  # Filter by parent table
  jsn dev tables list --query "super_class=task"

  # Show specific columns
  jsn dev tables list --columns "name,label,sys_scope"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = tableDefaultColumns
			}

			return listTables(ctx, app, query, cols, limit)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newTablesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [table-name]",
		Short: "Show table details",
		Long: `Display detailed information about a table.

Examples:
  # Show table details
  jsn dev tables show incident`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return getTableByName(ctx, app, args[0])
		},
	}
}

func newTablesCreateCmd() *cobra.Command {
	var (
		name         string
		label        string
		extends      string
		createACLs   bool
		scope        string
		data         string
		isExtendable bool
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new table",
		Long: `Create a new table in ServiceNow.

Note: Creating tables requires careful attention to naming conventions and scopes.
Custom tables should use the "u_" or "x_" prefix.

Examples:
  # Create a basic table
  jsn dev tables create --name u_my_table --label "My Custom Table"

  # Create table extending task
  jsn dev tables create --name u_requests --label "Custom Requests" --extends task

  # Create table in specific scope with data
  jsn dev tables create --name x_myapp_data --label "App Data" --scope x_myapp --data '{"is_extendable":true}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Validate required fields
			if name == "" {
				return fmt.Errorf("--name is required")
			}
			if label == "" {
				return fmt.Errorf("--label is required")
			}

			// Build record data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			recordData["name"] = name
			recordData["label"] = label

			// Handle super_class (extends)
			if extends != "" && extends != "global" {
				// Need to find the super_class sys_id
				superClassID, err := findTableSysID(ctx, app, extends)
				if err != nil {
					return fmt.Errorf("failed to find parent table '%s': %w", extends, err)
				}
				recordData["super_class"] = superClassID
			}

			// Handle scope if specified
			if scope != "" {
				recordData["sys_scope"] = scope
			}

			// Handle create_access_controls
			if cmd.Flags().Changed("create-acls") {
				recordData["create_access_controls"] = createACLs
			} else {
				recordData["create_access_controls"] = true // default
			}

			// Handle is_extendable
			if cmd.Flags().Changed("extendable") {
				recordData["is_extendable"] = isExtendable
			}

			// Validate scope compatibility
			if scope != "" {
				validator := NewScopeValidator(app)
				currentScope, err := validator.GetCurrentScope(ctx)
				if err == nil && currentScope != scope {
					fmt.Fprintf(os.Stderr, "Warning: Creating table in scope '%s' but current scope is '%s'\n", scope, currentScope)
				}
			}

			// Create the table
			record, err := app.SDK.Create(ctx, "sys_db_object", recordData)
			if err != nil {
				return fmt.Errorf("failed to create table: %w", err)
			}

			tableName := getStringField(record, "name")

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created table %s", tableName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn dev tables show %s", tableName),
						Description: "View the new table",
					},
					output.Breadcrumb{
						Action:      "columns",
						Cmd:         fmt.Sprintf("jsn dev columns list --query \"name=%s\"", tableName),
						Description: "View table columns",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Table name (required, use u_ or x_ prefix for custom tables)")
	cmd.Flags().StringVar(&label, "label", "", "Display label (required)")
	cmd.Flags().StringVar(&extends, "extends", "global", "Parent table to extend")
	cmd.Flags().BoolVar(&createACLs, "create-acls", true, "Create basic ACLs")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (default: current scope)")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")
	cmd.Flags().BoolVar(&isExtendable, "extendable", false, "Allow other tables to extend this table")

	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("label")

	return cmd
}

func newTablesUpdateCmd() *cobra.Command {
	var (
		label string
		data  string
	)

	cmd := &cobra.Command{
		Use:   "update [table-name]",
		Short: "Update a table",
		Long: `Update an existing table.

Note: Some fields cannot be updated after table creation:
  - name: Would break references
  - super_class: Would break inheritance chain
  - sys_scope: Scope cannot be changed

Examples:
  # Update table label
  jsn dev tables update u_my_table --label "New Label"

  # Update using raw data
  jsn dev tables update u_my_table --data '{"label":"New Label","is_extendable":true}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			tableName := args[0]

			// Find the table
			record, err := findTableByName(ctx, app, tableName)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordScope := getStringField(record, "sys_scope")

			// Validate scope
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				return fmt.Errorf("scope validation failed: %w", err)
			}

			// Build update data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			if label != "" {
				recordData["label"] = label
			}

			// Validate: cannot update certain fields
			protectedFields := []string{"name", "super_class", "sys_scope"}
			for _, field := range protectedFields {
				if _, ok := recordData[field]; ok {
					return fmt.Errorf("cannot update field '%s': this would break references or inheritance", field)
				}
			}

			if len(recordData) == 0 {
				return fmt.Errorf("no fields to update (use --label or --data)")
			}

			// Update the table
			updated, err := app.SDK.Update(ctx, "sys_db_object", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update table: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated table %s", tableName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn dev tables show %s", tableName),
						Description: "View the updated table",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&label, "label", "", "New display label")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for updates")

	return cmd
}

func newTablesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [table-name]",
		Short: "Delete a table",
		Long: `Delete a table and all its data.

WARNING: This is a destructive operation that will:
  - Delete the table definition
  - Delete all records in the table
  - Delete all columns (sys_dictionary entries)
  - This action CANNOT be undone!

Examples:
  # Delete with confirmation
  jsn dev tables delete u_my_table

  # Delete without confirmation
  jsn dev tables delete u_my_table --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			tableName := args[0]

			// Find the table
			record, err := findTableByName(ctx, app, tableName)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordScope := getStringField(record, "sys_scope")

			// Validate scope
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				return fmt.Errorf("scope validation failed: %w", err)
			}

			// Check if this is a system table (additional safety)
			if !strings.HasPrefix(tableName, "u_") && !strings.HasPrefix(tableName, "x_") {
				return fmt.Errorf("refusing to delete system table '%s': only custom tables (u_* or x_*) can be deleted", tableName)
			}

			// Get column count for warning
			columnCount, err := getTableColumnCount(ctx, app, tableName)
			if err != nil {
				columnCount = 0 // Don't fail if we can't get count
			}

			// Confirmation prompt
			if !force {
				fmt.Fprintf(os.Stderr, "\n⚠️  WARNING: About to delete table '%s'\n", tableName)
				fmt.Fprintf(os.Stderr, "   - This will delete the table and all %d column(s)\n", columnCount)
				fmt.Fprintf(os.Stderr, "   - Any data in this table will be LOST\n")
				fmt.Fprintf(os.Stderr, "   - This action CANNOT be undone!\n\n")
				fmt.Fprintf(os.Stderr, "Delete table '%s'? [y/N]: ", tableName)

				reader := bufio.NewReader(os.Stdin)
				response, _ := reader.ReadString('\n')
				response = strings.TrimSpace(strings.ToLower(response))

				if response != "y" && response != "yes" {
					fmt.Fprintln(os.Stderr, "Cancelled.")
					return nil
				}
			}

			// Delete the table
			if err := app.SDK.Delete(ctx, "sys_db_object", sysID); err != nil {
				return fmt.Errorf("failed to delete table: %w", err)
			}

			return app.OK(map[string]string{
				"name":    tableName,
				"message": "Table deleted",
			},
				output.WithSummary(fmt.Sprintf("Deleted table %s", tableName)),
			)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

// findTableByName finds a table by name and returns the record
func findTableByName(ctx context.Context, app *appctx.App, tableName string) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_query", "name="+tableName)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_db_object", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find table: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("table not found: %s", tableName)
	}

	return records[0], nil
}

// findTableSysID finds a table's sys_id by name
func findTableSysID(ctx context.Context, app *appctx.App, tableName string) (string, error) {
	record, err := findTableByName(ctx, app, tableName)
	if err != nil {
		return "", err
	}
	return getStringField(record, "sys_id"), nil
}

// getTableColumnCount gets the number of columns for a table
func getTableColumnCount(ctx context.Context, app *appctx.App, tableName string) (int, error) {
	return app.SDK.AggregateCount(ctx, "sys_dictionary", "name="+tableName+"^elementISNOTEMPTY")
}

// getTableExtensionInfo gets extension table info if the table is extended
func getTableExtensionInfo(ctx context.Context, app *appctx.App, superClassName string) (map[string]any, error) {
	if superClassName == "" {
		return nil, nil
	}

	// Count tables that extend this one
	count, err := app.SDK.AggregateCount(ctx, "sys_db_object", "super_class.name="+superClassName)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"extended_by_count": count,
	}, nil
}

func listTables(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = tableDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listTablesInteractive(ctx, app, columns)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	if limit <= 0 {
		limit = 20
	}
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

	records, err := app.SDK.List(ctx, "sys_db_object", params)
	if err != nil {
		return fmt.Errorf("failed to list tables: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn dev tables create --name u_my_table --label \"...\"",
			Description: "Create a new table",
		},
	}

	return app.OK(map[string]any{
		"table":   "sys_db_object",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d table(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listTablesInteractive shows an interactive picker for tables
func listTablesInteractive(ctx context.Context, app *appctx.App, columns []string) error {
	fetcher := tui.NewListFetcher("sys_db_object").
		WithColumns("name", "label", "super_class", "create_access_controls", "sys_id").
		WithOrderBy("ORDERBYDESCsys_updated_on").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			label := getStringField(record, "label")
			superClass := getDisplayField(record, "super_class")
			sysID := getStringField(record, "sys_id")

			// Format: name (Label) | extends: super_class
			display := name
			if label != "" && label != name {
				display = fmt.Sprintf("%s (%s)", name, label)
			}
			if superClass != "" && superClass != "Global" {
				display = fmt.Sprintf("%s  | extends: %s", display, superClass)
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: display,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, 20)
	if err != nil {
		return err
	}

	if selected != nil {
		// Get the table name from the record
		// We need to fetch the full record to get the name
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_fields", "name")
		params.Set("sysparm_query", "sys_id="+selected.ID)

		records, err := app.SDK.List(ctx, "sys_db_object", params)
		if err == nil && len(records) > 0 {
			tableName := getStringField(records[0], "name")
			if tableName != "" {
				return getTableByName(ctx, app, tableName)
			}
		}
		// Fallback: use sys_id
		return getTableByName(ctx, app, selected.ID)
	}

	return nil
}

// getTableByName retrieves a table by name with related information
func getTableByName(ctx context.Context, app *appctx.App, tableName string) error {
	// Try to find by name field first
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", strings.Join(append([]string{"sys_id"}, tableDetailColumns...), ","))

	// Check if identifier looks like a sys_id (32 hex characters)
	if len(tableName) == 32 && isHexString(tableName) {
		params.Set("sysparm_query", "sys_id="+tableName)
	} else {
		params.Set("sysparm_query", "name="+tableName)
	}

	records, err := app.SDK.List(ctx, "sys_db_object", params)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("table not found: %s", tableName)
	}

	record := records[0]
	displayName := getStringField(record, "name")

	// Fetch related information concurrently
	var columnCount int
	var extensionInfo map[string]any

	// Use channels for concurrent fetching
	type result struct {
		count int
		info  map[string]any
		err   error
	}

	results := make(chan result, 2)

	// Fetch column count
	go func() {
		count, err := getTableColumnCount(ctx, app, displayName)
		results <- result{count: count, err: err}
	}()

	// Fetch extension info
	go func() {
		superClass := getStringField(record, "super_class")
		info, err := getTableExtensionInfo(ctx, app, displayName)
		results <- result{info: info, err: err}
		_ = superClass // Avoid unused variable if not used
	}()

	// Collect results
	for i := 0; i < 2; i++ {
		r := <-results
		if r.err == nil {
			if r.count > 0 {
				columnCount = r.count
			}
			if r.info != nil {
				extensionInfo = r.info
			}
		}
	}

	// Add related data to record
	if columnCount > 0 {
		record["_column_count"] = columnCount
	}
	if extensionInfo != nil {
		record["_extension_info"] = extensionInfo
	}

	// Add context for formatter
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_db_object",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev tables update %s --label \"...\"", displayName),
			Description: "Update this table",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev tables delete %s", displayName),
			Description: "Delete this table",
		},
		{
			Action:      "columns",
			Cmd:         fmt.Sprintf("jsn dev columns list --query \"name=%s\"", displayName),
			Description: "View columns",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev tables list",
			Description: "Back to all tables",
		},
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Table: %s", displayName)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}
