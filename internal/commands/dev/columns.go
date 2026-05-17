// Package dev provides development-related commands.
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

// columnDefaultColumns are the default columns for columns
var columnDefaultColumns = []string{"element", "column_label", "internal_type", "mandatory", "max_length", "active"}

// NewColumnsCmd creates the columns command.
func NewColumnsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "columns",
		Aliases: []string{"column", "col"},
		Short:   "Manage column definitions",
		Args:    cobra.NoArgs,
		Long: `Manage column definitions in the system dictionary.

Columns (fields) are defined in sys_dictionary and define the structure
of tables in ServiceNow.

Examples:
  # List columns for a table
  jsn dev columns list --table incident

  # Show a specific column
  jsn dev columns show short_description

  # Show by sys_id
  jsn dev columns show abc123def456abc123def456abc12345

  # Create a new column
  jsn dev columns create --table incident --element my_field --type string --label "My Field"

  # Update a column
  jsn dev columns update short_description --label "Updated Label"

  # Delete a column
  jsn dev columns delete my_field --table incident`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newColumnsListCmd(),
		newColumnsShowCmd(),
		newColumnsCreateCmd(),
		newColumnsUpdateCmd(),
		newColumnsDeleteCmd(),
	)

	return cmd
}

func newColumnsListCmd() *cobra.Command {
	var (
		query   string
		table   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List columns",
		Long: `List columns for a table with optional filtering.

The --table flag is required to specify which table's columns to list.

Examples:
  # List columns for the incident table
  jsn dev columns list --table incident

  # List with custom query
  jsn dev columns list --table incident --query "internal_type=reference"

  # List all columns (across all tables)
  jsn dev columns list

  # Show specific columns
  jsn dev columns list --table incident --columns "element,column_label,internal_type,max_length"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Build base query from table flag
			baseQuery := query
			if table != "" {
				if baseQuery != "" {
					baseQuery = "name=" + table + "^" + baseQuery
				} else {
					baseQuery = "name=" + table
				}
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = columnDefaultColumns
			}

			return listColumns(ctx, app, baseQuery, cols, limit)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "Encoded query string for filtering columns")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name to list columns for")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of records to return")

	return cmd
}

func newColumnsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [element|sys_id]",
		Short: "Show column details",
		Long: `Display detailed information about a column.

The show command displays the column definition including type,
label, constraints, and metadata.

Examples:
  # Show by element name (requires --table to identify which table)
  jsn dev columns show short_description --table incident

  # Show by sys_id (table not required)
  jsn dev columns show abc123def456abc123def456abc12345`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showColumn(ctx, app, args[0])
		},
	}
}

func newColumnsCreateCmd() *cobra.Command {
	var (
		table          string
		element        string
		columnType     string
		label          string
		mandatory      bool
		maxLength      int
		referenceTable string
		defaultValue   string
		active         bool
		scope          string
		data           string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new column",
		Long: `Create a new column (field) in a ServiceNow table.

Required flags:
  --table    The table to add the column to
  --element  The field name (API name)
  --type     The internal type (string, integer, reference, etc.)
  --label    The display label

Examples:
  # Create a simple string field
  jsn dev columns create --table incident --element my_field --type string --label "My Field"

  # Create a mandatory integer field
  jsn dev columns create --table incident --element priority_score --type integer --label "Priority Score" --mandatory

  # Create a reference field
  jsn dev columns create --table incident --element parent_incident --type reference --label "Parent" --reference-table incident

  # Create with max length
  jsn dev columns create --table incident --element short_desc --type string --label "Short Description" --max-length 80

  # Create using JSON data
  jsn dev columns create --data '{"name":"incident","element":"my_field","internal_type":"string","column_label":"My Field"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Build record data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			if table != "" {
				recordData["name"] = table
			}
			if element != "" {
				recordData["element"] = element
			}
			if columnType != "" {
				recordData["internal_type"] = columnType
			}
			if label != "" {
				recordData["column_label"] = label
			}
			recordData["mandatory"] = mandatory
			if maxLength > 0 {
				recordData["max_length"] = maxLength
			}
			if referenceTable != "" {
				recordData["reference"] = referenceTable
			}
			if defaultValue != "" {
				recordData["default_value"] = defaultValue
			}
			recordData["active"] = active

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("--table is required (use --table or include 'name' in --data)")
			}
			if recordData["element"] == nil || recordData["element"] == "" {
				return fmt.Errorf("--element is required (use --element or include 'element' in --data)")
			}
			if recordData["internal_type"] == nil || recordData["internal_type"] == "" {
				return fmt.Errorf("--type is required (use --type or include 'internal_type' in --data)")
			}
			if recordData["column_label"] == nil || recordData["column_label"] == "" {
				return fmt.Errorf("--label is required (use --label or include 'column_label' in --data)")
			}

			// Validate element name
			elementName := recordData["element"].(string)
			if err := validateElementName(elementName); err != nil {
				return err
			}

			// For reference type, reference-table is required
			if recordData["internal_type"] == "reference" {
				if recordData["reference"] == nil || recordData["reference"] == "" {
					return fmt.Errorf("--reference-table is required for reference type columns")
				}
			}

			// Handle scope if specified
			if scope != "" {
				recordData["sys_scope"] = scope
				// Validate the user is in the correct scope
				currentScope, err := getCurrentScope(ctx, app)
				if err == nil && currentScope != scope && currentScope != "global" {
					return fmt.Errorf("specified scope '%s' does not match current scope '%s'. Switch scope first: jsn dev scopes set %s",
						scope, currentScope, scope)
				}
			}

			// Create the record
			record, err := app.SDK.Create(ctx, "sys_dictionary", recordData)
			if err != nil {
				return fmt.Errorf("failed to create column: %w", err)
			}

			createdElement := getStringField(record, "element")
			createdTable := getStringField(record, "name")

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created column '%s' on table '%s'", createdElement, createdTable)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev columns show %s", createdElement),
						Description: "View the new column",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev columns update %s --label '...'", createdElement),
						Description: "Update this column",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev columns create --table <table> --element <name> --type <type> --label <label>",
						Description: "Create another column",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         fmt.Sprintf("jsn dev columns list --table %s", createdTable),
						Description: "Back to all columns for this table",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name to add the column to (required)")
	cmd.Flags().StringVarP(&element, "element", "e", "", "Field name/element (required)")
	cmd.Flags().StringVar(&columnType, "type", "", "Internal type: string, integer, reference, boolean, decimal, date, datetime, etc. (required)")
	cmd.Flags().StringVarP(&label, "label", "l", "", "Display label (required)")
	cmd.Flags().BoolVar(&mandatory, "mandatory", false, "Make the field mandatory")
	cmd.Flags().IntVar(&maxLength, "max-length", 0, "Maximum length (for string types)")
	cmd.Flags().StringVar(&referenceTable, "reference-table", "", "Target table for reference fields (required when type=reference)")
	cmd.Flags().StringVar(&defaultValue, "default-value", "", "Default value for the field")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status (default: true)")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (defaults to current user scope)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func newColumnsUpdateCmd() *cobra.Command {
	var (
		label        string
		mandatory    bool
		mandatorySet bool
		maxLength    int
		active       bool
		activeSet    bool
		data         string
		table        string
	)

	cmd := &cobra.Command{
		Use:   "update [element|sys_id]",
		Short: "Update a column",
		Long: `Update an existing column's properties.

Note: ServiceNow has restrictions on column updates. You can update:
  - label (column_label)
  - mandatory flag
  - max_length (only if no data exists in the field)
  - active status

You CANNOT update:
  - element name (would break references)
  - internal_type (requires migration)
  - table (would move the column)

Examples:
  # Update label
  jsn dev columns update short_description --label "Updated Description"

  # Make field mandatory
  jsn dev columns update my_field --table incident --mandatory

  # Update using JSON data
  jsn dev columns update my_field --data '{"column_label":"New Label","active":false}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findColumnByElementOrSysID(ctx, app, identifier, table)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			elementName := getStringField(record, "element")
			tableName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for updates
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					elementName, recordScope, currentScope, recordScope)
			}

			// Parse JSON data if provided
			var recordData map[string]any
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			} else {
				recordData = make(map[string]any)
			}

			// Merge flag values (flags take precedence over data)
			if label != "" {
				recordData["column_label"] = label
			}
			if mandatorySet {
				recordData["mandatory"] = mandatory
			}
			if maxLength > 0 {
				recordData["max_length"] = maxLength
			}
			if activeSet {
				recordData["active"] = active
			}

			// Validate we have something to update
			if len(recordData) == 0 {
				return fmt.Errorf("no updates provided (use --label, --mandatory, --max-length, --active, or --data)")
			}

			// Update the record
			updated, err := app.SDK.Update(ctx, "sys_dictionary", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update column: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated column '%s' on table '%s'", elementName, tableName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev columns show %s", elementName),
						Description: "View the updated column",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev columns update %s --label '...'", elementName),
						Description: "Update again",
					},
					output.Breadcrumb{
						Action:      "delete",
						Cmd:         fmt.Sprintf("jsn dev columns delete %s", elementName),
						Description: "Delete this column",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         fmt.Sprintf("jsn dev columns list --table %s", tableName),
						Description: "Back to all columns for this table",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&label, "label", "l", "", "New display label")
	cmd.Flags().BoolVar(&mandatory, "mandatory", false, "Set mandatory status")
	cmd.Flags().IntVar(&maxLength, "max-length", 0, "Maximum length (for string types)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status")
	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name (required when using element name instead of sys_id)")

	// These are needed to track if the flags were explicitly set (vs just default values)
	cmd.Flags().BoolVar(&mandatorySet, "mandatory-set", false, "Internal flag to track if mandatory was set")
	cmd.Flags().BoolVar(&activeSet, "active-set", false, "Internal flag to track if active was set")
	_ = cmd.Flags().MarkHidden("mandatory-set")
	_ = cmd.Flags().MarkHidden("active-set")

	// Use Changed tracking
	cmd.PreRunE = func(cmd *cobra.Command, args []string) error {
		if cmd.Flags().Changed("mandatory") {
			mandatorySet = true
		}
		if cmd.Flags().Changed("active") {
			activeSet = true
		}
		return nil
	}

	return cmd
}

func newColumnsDeleteCmd() *cobra.Command {
	var (
		force bool
		table string
	)

	cmd := &cobra.Command{
		Use:   "delete [element|sys_id]",
		Short: "Delete a column",
		Long: `Delete a column from a table.

WARNING: This is a destructive operation. Deleting a column will
remove all data stored in that field across all records in the table.

Scope validation is performed - you can only delete columns in your current scope.
This operation requires confirmation unless --force is used.

Examples:
  # Delete with confirmation prompt
  jsn dev columns delete my_field --table incident

  # Delete without confirmation
  jsn dev columns delete my_field --table incident --force

  # Delete by sys_id (table not required)
  jsn dev columns delete abc123def456abc123def456abc12345 --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findColumnByElementOrSysID(ctx, app, identifier, table)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			elementName := getStringField(record, "element")
			tableName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for deletes
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					elementName, recordScope, currentScope, recordScope)
			}

			// Confirmation prompt (if TTY and not --force)
			if !force && output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) {
				fmt.Fprintf(os.Stdout, "Delete column '%s' from table '%s'? This will remove all data in this field. (y/N): ", elementName, tableName)
				reader := bufio.NewReader(os.Stdin)
				response, err := reader.ReadString('\n')
				if err != nil {
					return fmt.Errorf("failed to read confirmation: %w", err)
				}
				response = strings.TrimSpace(strings.ToLower(response))
				if response != "y" && response != "yes" {
					return fmt.Errorf("deletion cancelled")
				}
			}

			// Delete the record
			if err := app.SDK.Delete(ctx, "sys_dictionary", sysID); err != nil {
				return fmt.Errorf("failed to delete column: %w", err)
			}

			return app.OK(map[string]any{
				"element": elementName,
				"table":   tableName,
				"sys_id":  sysID,
				"deleted": true,
			},
				output.WithSummary(fmt.Sprintf("Deleted column '%s' from table '%s'", elementName, tableName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "create",
						Cmd:         fmt.Sprintf("jsn dev columns create --table %s --element <name> --type <type> --label <label>", tableName),
						Description: "Create a new column on this table",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         fmt.Sprintf("jsn dev columns list --table %s", tableName),
						Description: "Back to all columns for this table",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name (required when using element name instead of sys_id)")

	return cmd
}

func listColumns(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = columnDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listColumnsInteractive(ctx, app, query, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_display_value", "all")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Default ordering: element name
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYelement")
	} else {
		params.Set("sysparm_query", "ORDERBYelement")
	}

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return fmt.Errorf("failed to list columns: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn dev columns create --table <table> --element <name> --type <type> --label <label>",
			Description: "Create a new column",
		},
		{
			Action:      "show",
			Cmd:         "jsn dev columns show <element>",
			Description: "Show column details",
		},
		{
			Action:      "list-tables",
			Cmd:         "jsn dev tables list",
			Description: "List all tables",
		},
	}

	return app.OK(map[string]any{
		"table":   "sys_dictionary",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d column(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listColumnsInteractive shows an interactive picker for columns with pagination
func listColumnsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_dictionary").
		WithColumns("element", "column_label", "internal_type", "mandatory", "max_length").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			element := getStringField(record, "element")
			label := getStringField(record, "column_label")
			fieldType := getStringField(record, "internal_type")
			sysID := getStringField(record, "sys_id")

			title := fmt.Sprintf("%s | %s (%s)", element, label, fieldType)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		return showColumnBySysID(ctx, app, selected.ID)
	}

	return nil
}

func showColumn(ctx context.Context, app *appctx.App, identifier string) error {
	record, err := findColumnByElementOrSysID(ctx, app, identifier, "")
	if err != nil {
		return err
	}

	return displayColumnRecord(ctx, app, record)
}

func showColumnBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	record, err := findColumnBySysID(ctx, app, sysID)
	if err != nil {
		return err
	}

	return displayColumnRecord(ctx, app, record)
}

func displayColumnRecord(ctx context.Context, app *appctx.App, record map[string]any) error {
	element := getStringField(record, "element")
	table := getStringField(record, "name")
	label := getStringField(record, "column_label")
	fieldType := getStringField(record, "internal_type")
	recordScope := getStringField(record, "sys_scope")

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_dictionary",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev columns update %s --label '...'", element),
			Description: "Update this column",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev columns delete %s --table %s", element, table),
			Description: "Delete this column",
		},
		{
			Action:      "list",
			Cmd:         fmt.Sprintf("jsn dev columns list --table %s", table),
			Description: "Back to all columns for this table",
		},
		{
			Action:      "show-table",
			Cmd:         fmt.Sprintf("jsn dev tables show %s", table),
			Description: "Show table details",
		},
	}

	// Add scope warning breadcrumb if scope mismatch detected
	validator := NewScopeValidator(app)
	if currentScope, err := validator.GetCurrentScope(ctx); err == nil && currentScope != "global" && currentScope != recordScope {
		breadcrumbs = append([]output.Breadcrumb{
			{
				Action:      "scope-warning",
				Cmd:         fmt.Sprintf("jsn dev scopes set %s", recordScope),
				Description: fmt.Sprintf("⚠ Switch scope to '%s' to modify this record", recordScope),
			},
		}, breadcrumbs...)
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Column: %s on %s (%s - %s)", element, table, label, fieldType)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

func findColumnByElementOrSysID(ctx context.Context, app *appctx.App, identifier string, tableHint string) (map[string]any, error) {
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(identifier) == 32 && isHexString(identifier) {
		return findColumnBySysID(ctx, app, identifier)
	}

	// Otherwise, treat as element name - requires table context
	params := url.Values{}
	query := "element=" + identifier
	if tableHint != "" {
		query = "name=" + tableHint + "^" + query
	}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find column: %w", err)
	}

	if len(records) == 0 {
		if tableHint == "" {
			return nil, fmt.Errorf("column not found: %s (hint: use --table to specify which table, or use sys_id)", identifier)
		}
		return nil, fmt.Errorf("column not found: %s on table %s", identifier, tableHint)
	}

	return records[0], nil
}

func findColumnBySysID(ctx context.Context, app *appctx.App, sysID string) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_dictionary", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find column: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("column not found: %s", sysID)
	}

	return records[0], nil
}

// validateElementName validates that an element name follows ServiceNow conventions
func validateElementName(name string) error {
	if name == "" {
		return fmt.Errorf("element name cannot be empty")
	}

	// Element names should be lowercase with underscores
	// They should not contain spaces or special characters
	if strings.Contains(name, " ") {
		return fmt.Errorf("element name cannot contain spaces (use underscores)")
	}

	// Check for valid characters (alphanumeric, underscore)
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return fmt.Errorf("element name can only contain lowercase letters, numbers, and underscores")
		}
	}

	return nil
}
