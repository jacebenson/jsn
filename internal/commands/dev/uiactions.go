// Package dev provides development-related commands.
package dev

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

// uiActionDefaultColumns are the default columns for UI actions
var uiActionDefaultColumns = []string{"name", "table", "active", "order", "sys_scope"}

// NewUIActionsCmd creates the uiactions command.
func NewUIActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uiactions",
		Aliases: []string{"uiaction", "ua"},
		Short:   "Manage UI actions",
		Args:    cobra.NoArgs,
		Long: `Manage UI actions.

UI actions are buttons, links, and context menu items.

Examples:
  # Show this help
  jsn dev uiactions

  # List UI actions
  jsn dev uiactions list

  # Show a UI action
  jsn dev uiactions show MyAction

  # List with a filter
  jsn dev uiactions list --query "table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newUIActionsListCmd(),
		newUIActionsShowCmd(),
		newUIActionsCreateCmd(),
		newUIActionsUpdateCmd(),
		newUIActionsDeleteCmd(),
	)

	return cmd
}

func newUIActionsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI actions",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Interactive picker when in TTY and auto format
			if output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) && app.Output.GetFormat() == output.FormatAuto {
				return listUIActionsInteractive(ctx, app, query, 20)
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = uiActionDefaultColumns
			}

			return listUIActions(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newUIActionsShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show UI action details",
		Long: `Show detailed information about a UI action.

Key fields displayed:
  - name, table, order, active
  - condition and script content
  - client_script for client-side actions
  - scope and timestamps`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			name := args[0]
			record, err := findUIAction(ctx, app, name)
			if err != nil {
				return err
			}

			// Build breadcrumbs for related actions
			breadcrumbs := []output.Breadcrumb{
				{
					Action:      "update",
					Cmd:         fmt.Sprintf("jsn dev uiactions update %s --data '{...}'", name),
					Description: "Update this action",
				},
				{
					Action:      "delete",
					Cmd:         fmt.Sprintf("jsn dev uiactions delete %s", name),
					Description: "Delete this action",
				},
				{
					Action:      "list",
					Cmd:         "jsn dev uiactions list",
					Description: "List all actions",
				},
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("UI action: %s", getStringField(record, "name"))),
				output.WithBreadcrumbs(breadcrumbs...),
			)
		},
	}

	return cmd
}

func newUIActionsCreateCmd() *cobra.Command {
	var (
		name         string
		table        string
		script       string
		clientScript string
		condition    string
		order        int
		active       bool
		showInsert   bool
		showUpdate   bool
		showDelete   bool
		scope        string
		data         string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new UI action",
		Long: `Create a new UI action in ServiceNow.

Required flags:
  --name, --table, --script

Examples:
  jsn dev uiactions create --name "My Action" --table incident --script "gs.info('Hello');"
  jsn dev uiactions create --name "Quick Close" --table incident --script "current.state = 6;" --show-update`,
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
				recordData["table"] = table
			}
			if script != "" {
				recordData["script"] = script
			}
			if clientScript != "" {
				recordData["client_script"] = clientScript
			}
			if condition != "" {
				recordData["condition"] = condition
			}
			if scope != "" {
				recordData["sys_scope.scope"] = scope
			}
			recordData["order"] = order
			recordData["active"] = active
			recordData["show_insert"] = showInsert
			recordData["show_update"] = showUpdate
			recordData["show_delete"] = showDelete

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("--name is required")
			}
			if recordData["table"] == nil || recordData["table"] == "" {
				return fmt.Errorf("--table (table name) is required")
			}
			if recordData["script"] == nil || recordData["script"] == "" {
				return fmt.Errorf("--script is required")
			}

			record, err := app.SDK.Create(ctx, "sys_ui_action", recordData)
			if err != nil {
				return fmt.Errorf("failed to create UI action: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created UI action: %s", getStringField(record, "name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev uiactions show %s", getStringField(record, "sys_id")),
						Description: "View the new action",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev uiactions update %s --data '{...}'", getStringField(record, "sys_id")),
						Description: "Update the action",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uiactions list",
						Description: "List all actions",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Action name (required)")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name (required)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Server-side script (required)")
	cmd.Flags().StringVarP(&clientScript, "client-script", "c", "", "Client-side script")
	cmd.Flags().StringVar(&condition, "condition", "", "Condition script")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Execution order (lower = first)")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set action as active")
	cmd.Flags().BoolVar(&showInsert, "show-insert", false, "Show on insert")
	cmd.Flags().BoolVar(&showUpdate, "show-update", false, "Show on update")
	cmd.Flags().BoolVar(&showDelete, "show-delete", false, "Show on delete")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newUIActionsUpdateCmd() *cobra.Command {
	var (
		data   string
		script string
		active bool
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update a UI action",
		Long: `Update an existing UI action.

Use --data for full control or convenience flags for common fields:
  --script, --active

Examples:
  jsn dev uiactions update "My Action" --data '{"active": false}'
  jsn dev uiactions update abc123 --script "gs.info('Updated');"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			name := args[0]

			// Find the action
			record, err := findUIAction(ctx, app, name)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			recordScope := getStringField(record, "sys_scope.scope")
			if recordScope == "" {
				recordScope = getStringField(record, "sys_scope")
			}

			// Scope validation
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				return err
			}

			// Build update data
			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			// Apply convenience flags (override --data)
			if cmd.Flags().Changed("script") {
				recordData["script"] = script
			}
			if cmd.Flags().Changed("active") {
				recordData["active"] = active
			}

			if len(recordData) == 0 {
				return fmt.Errorf("no updates specified (use --data, --script, or --active)")
			}

			updated, err := app.SDK.Update(ctx, "sys_ui_action", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update UI action: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated UI action: %s", getStringField(updated, "name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev uiactions show %s", name),
						Description: "View the updated action",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uiactions list",
						Description: "List all actions",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Update server script content")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set active status")

	return cmd
}

func newUIActionsDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a UI action",
		Long:  `Delete a UI action by name or sys_id.`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			name := args[0]

			// Find the action
			record, err := findUIAction(ctx, app, name)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			actionName := getStringField(record, "name")
			recordScope := getStringField(record, "sys_scope.scope")
			if recordScope == "" {
				recordScope = getStringField(record, "sys_scope")
			}

			// Scope validation
			validator := NewScopeValidator(app)
			if err := validator.CheckScope(ctx, recordScope); err != nil {
				return err
			}

			// Confirmation
			if !force {
				fmt.Printf("Delete UI action '%s'? [y/N]: ", actionName)
				var response string
				_, _ = fmt.Scanln(&response)
				if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
					return fmt.Errorf("delete cancelled")
				}
			}

			if err := app.SDK.Delete(ctx, "sys_ui_action", sysID); err != nil {
				return fmt.Errorf("failed to delete UI action: %w", err)
			}

			return app.OK(map[string]string{
				"name":    actionName,
				"sys_id":  sysID,
				"message": "UI action deleted",
			},
				output.WithSummary(fmt.Sprintf("Deleted UI action: %s", actionName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uiactions list",
						Description: "List all actions",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev uiactions create --name ...",
						Description: "Create a new action",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")

	return cmd
}

func listUIActions(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = uiActionDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listUIActionsInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_ui_action", params)
	if err != nil {
		return fmt.Errorf("failed to list UI actions: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_ui_action",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d UI action(s)", len(records))),
	)
}

// listUIActionsInteractive shows an interactive picker for UI actions with pagination
func listUIActionsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_ui_action").
		WithColumns("name", "table", "active", "order").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			table := getStringField(record, "table")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := IconActive
			if active != "true" {
				statusIcon = IconInactive
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, name, table)

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
		return getUIActionByName(ctx, app, selected.ID)
	}

	return nil
}

func getUIActionByName(ctx context.Context, app *appctx.App, name string) error {
	record, err := findUIAction(ctx, app, name)
	if err != nil {
		return err
	}

	// Build breadcrumbs for related actions
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev uiactions update %s --data '{...}'", name),
			Description: "Update this action",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev uiactions delete %s", name),
			Description: "Delete this action",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev uiactions list",
			Description: "List all actions",
		},
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("UI action: %s", getStringField(record, "name"))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findUIAction finds a UI action by name or sys_id
func findUIAction(ctx context.Context, app *appctx.App, name string) (map[string]any, error) {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(name) == 32 && isHexString(name) {
		query = "sys_id=" + name
	} else {
		query = "name=" + name
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_ui_action", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find UI action: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("UI action not found: %s", name)
	}

	return records[0], nil
}
