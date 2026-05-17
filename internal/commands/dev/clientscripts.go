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

// clientScriptDefaultColumns are the default columns for client scripts
var clientScriptDefaultColumns = []string{"name", "table", "active", "type", "sys_scope"}

// NewClientScriptsCmd creates the clientscripts command.
func NewClientScriptsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "clientscripts",
		Aliases: []string{"clientscript", "cs"},
		Short:   "Manage client scripts",
		Args:    cobra.NoArgs,
		Long: `Manage client scripts.

Client scripts run in the browser on forms and lists.

Examples:
  # List all client scripts
  jsn dev clientscripts list

  # Show a specific client script
  jsn dev clientscripts show MyScript

  # Create a new client script
  jsn dev clientscripts create --name "MyScript" --table incident --script "function onLoad() { ... }"

  # Update a client script
  jsn dev clientscripts update MyScript --script "function onLoad() { /* updated */ }"

  # Delete a client script
  jsn dev clientscripts delete MyScript`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newClientScriptsListCmd(),
		newClientScriptsShowCmd(),
		newClientScriptsCreateCmd(),
		newClientScriptsUpdateCmd(),
		newClientScriptsDeleteCmd(),
	)

	return cmd
}

func newClientScriptsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List client scripts",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = clientScriptDefaultColumns
			}

			return listClientScripts(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newClientScriptsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show client script details",
		Long: `Display detailed information about a client script.

The show command displays the full script content along with metadata
including table, type, field (for onChange), scope, and timestamps.

Examples:
  # Show by name
  jsn dev clientscripts show MyClientScript

  # Show by sys_id
  jsn dev clientscripts show abc123def456`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showClientScript(ctx, app, args[0])
		},
	}
}

func newClientScriptsCreateCmd() *cobra.Command {
	var (
		name   string
		table  string
		script string
		csType string
		active bool
		field  string
		scope  string
		data   string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new client script",
		Long: `Create a new client script in ServiceNow.

You can provide data via flags or --data for more fields.
If using --data, flag values will be merged (flags take precedence).

Types: onLoad, onChange, onSubmit, onCellEdit

Examples:
  # Create onLoad script
  jsn dev clientscripts create --name "OnLoad Script" --table incident --type onLoad --script "function onLoad() { ... }"

  # Create onChange script with field
  jsn dev clientscripts create --name "Field Change" --table incident --type onChange --field priority --script "function onChange() { ... }"

  # Create in specific scope
  jsn dev clientscripts create --name "My Script" --table task --script "..." --scope "x_myapp"

  # Create using JSON data
  jsn dev clientscripts create --data '{"name":"MyScript","table":"incident","type":"onLoad","script":"function onLoad() {}"}'`,
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
			if name != "" {
				recordData["name"] = name
			}
			if table != "" {
				recordData["table_name"] = table
			}
			if script != "" {
				recordData["script"] = script
			}
			if csType != "" {
				recordData["type"] = csType
			}
			if field != "" {
				recordData["field"] = field
			}
			recordData["active"] = active

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("name is required (use --name or --data)")
			}
			if recordData["table_name"] == nil || recordData["table_name"] == "" {
				return fmt.Errorf("table is required (use --table or --data)")
			}
			if recordData["script"] == nil || recordData["script"] == "" {
				return fmt.Errorf("script is required (use --script or --data)")
			}

			// Validate type if provided
			if csType != "" {
				validTypes := map[string]bool{"onLoad": true, "onChange": true, "onSubmit": true, "onCellEdit": true}
				if !validTypes[csType] {
					return fmt.Errorf("invalid type '%s'; must be one of: onLoad, onChange, onSubmit, onCellEdit", csType)
				}
				// Field is required for onChange and onCellEdit
				if (csType == "onChange" || csType == "onCellEdit") && field == "" && recordData["field"] == nil {
					return fmt.Errorf("field is required for type '%s' (use --field or --data)", csType)
				}
			}

			// Handle scope if specified
			if scope != "" {
				// Validate the user is in the correct scope
				currentScope, err := getCurrentScope(ctx, app)
				if err == nil && currentScope != scope && currentScope != "global" {
					return fmt.Errorf("specified scope '%s' does not match current scope '%s'. Switch scope first: jsn dev scopes set %s",
						scope, currentScope, scope)
				}
			}

			// Create the record
			record, err := app.SDK.Create(ctx, "sys_script_client", recordData)
			if err != nil {
				return fmt.Errorf("failed to create client script: %w", err)
			}

			createdName := getStringField(record, "name")

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created client script '%s'", createdName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev clientscripts show %s", createdName),
						Description: "View the new client script",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev clientscripts update %s --script '...'", createdName),
						Description: "Update this client script",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev clientscripts create --name '...' --script '...'",
						Description: "Create another client script",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev clientscripts list",
						Description: "Back to all client scripts",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Client script name (required)")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name (required)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Script content (required)")
	cmd.Flags().StringVar(&csType, "type", "onLoad", "Script type: onLoad, onChange, onSubmit, onCellEdit (default: onLoad)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status (default: true)")
	cmd.Flags().StringVar(&field, "field", "", "Field name (required for onChange/onCellEdit)")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (defaults to current user scope)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func newClientScriptsUpdateCmd() *cobra.Command {
	var (
		data   string
		script string
		active bool
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update a client script",
		Long: `Update an existing client script by name or sys_id.

Scope validation is performed - you can only update records in your current scope.

Examples:
  # Update script content
  jsn dev clientscripts update MyScript --script "function onLoad() { /* updated code */ }"

  # Update active status
  jsn dev clientscripts update MyScript --active false

  # Update using JSON data
  jsn dev clientscripts update MyScript --data '{"active":false}'

  # Update multiple fields
  jsn dev clientscripts update MyScript --script "..." --data '{"active":true}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findClientScriptByNameOrSysID(ctx, app, identifier)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for updates
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					recordName, recordScope, currentScope, recordScope)
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

			// Merge script flag (takes precedence over data)
			if script != "" {
				recordData["script"] = script
			}

			// Merge active flag if changed
			if cmd.Flags().Changed("active") {
				recordData["active"] = active
			}

			// Validate we have something to update
			if len(recordData) == 0 {
				return fmt.Errorf("no updates provided (use --data, --script, or --active)")
			}

			// Update the record
			updated, err := app.SDK.Update(ctx, "sys_script_client", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update client script: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated client script '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev clientscripts show %s", recordName),
						Description: "View the updated client script",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev clientscripts update %s --data '{...}'", recordName),
						Description: "Update again",
					},
					output.Breadcrumb{
						Action:      "delete",
						Cmd:         fmt.Sprintf("jsn dev clientscripts delete %s", recordName),
						Description: "Delete this client script",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev clientscripts list",
						Description: "Back to all client scripts",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required if no --script/--active)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "New script content (convenience flag)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status")

	return cmd
}

func newClientScriptsDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a client script",
		Long: `Delete a client script by name or sys_id.

Scope validation is performed - you can only delete records in your current scope.
This operation requires confirmation unless --force is used.

Examples:
  # Delete with confirmation prompt
  jsn dev clientscripts delete MyScript

  # Delete without confirmation
  jsn dev clientscripts delete MyScript --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findClientScriptByNameOrSysID(ctx, app, identifier)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope")

			// Scope validation - critical for deletes
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				currentScope, _ := validator.GetCurrentScope(ctx)
				return fmt.Errorf("record '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					recordName, recordScope, currentScope, recordScope)
			}

			// Confirmation prompt (if TTY and not --force)
			if !force && output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) {
				fmt.Fprintf(os.Stdout, "Delete client script '%s'? (y/N): ", recordName)
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
			if err := app.SDK.Delete(ctx, "sys_script_client", sysID); err != nil {
				return fmt.Errorf("failed to delete client script: %w", err)
			}

			return app.OK(map[string]any{
				"name":    recordName,
				"sys_id":  sysID,
				"deleted": true,
			},
				output.WithSummary(fmt.Sprintf("Deleted client script '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev clientscripts create --name '...' --script '...'",
						Description: "Create a new client script",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev clientscripts list",
						Description: "Back to all client scripts",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

func listClientScripts(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = clientScriptDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listClientScriptsInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_script_client", params)
	if err != nil {
		return fmt.Errorf("failed to list client scripts: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_script_client",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d client script(s)", len(records))),
	)
}

// listClientScriptsInteractive shows an interactive picker for client scripts with pagination
func listClientScriptsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_script_client").
		WithColumns("name", "table", "active", "type").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			table := getStringField(record, "table")
			active := getStringField(record, "active")
			scriptType := getStringField(record, "type")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s | %s | %s", statusIcon, name, table, scriptType)

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
		return getClientScriptByName(ctx, app, selected.ID)
	}

	return nil
}

func getClientScriptByName(ctx context.Context, app *appctx.App, name string) error {
	record, err := findClientScriptByNameOrSysID(ctx, app, name)
	if err != nil {
		return err
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Client script: %s", name)),
	)
}

// showClientScript displays a single client script with full details
func showClientScript(ctx context.Context, app *appctx.App, identifier string) error {
	record, err := findClientScriptByNameOrSysID(ctx, app, identifier)
	if err != nil {
		return err
	}

	name := getStringField(record, "name")
	table := getStringField(record, "table")
	scriptType := getStringField(record, "type")
	recordScope := getStringField(record, "sys_scope")

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_script_client",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev clientscripts update %s --script '...'", name),
			Description: "Update this client script",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev clientscripts delete %s", name),
			Description: "Delete this client script",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev clientscripts list",
			Description: "Back to all client scripts",
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
		output.WithSummary(fmt.Sprintf("Client script: %s | %s | %s", name, table, scriptType)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findClientScriptByNameOrSysID finds a client script by name or sys_id
func findClientScriptByNameOrSysID(ctx context.Context, app *appctx.App, identifier string) (map[string]any, error) {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(identifier) == 32 && isHexString(identifier) {
		query = "sys_id=" + identifier
	} else {
		query = "name=" + identifier
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_script_client", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find client script: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("client script not found: %s", identifier)
	}

	return records[0], nil
}
