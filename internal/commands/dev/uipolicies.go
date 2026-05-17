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

// uiPolicyDefaultColumns are the default columns for UI policies
var uiPolicyDefaultColumns = []string{"short_description", "table", "active", "order", "sys_scope"}

// NewUIPoliciesCmd creates the uipolicies command.
func NewUIPoliciesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uipolicies",
		Aliases: []string{"uipolicy", "up"},
		Short:   "Manage UI policies",
		Args:    cobra.NoArgs,
		Long: `Manage UI policies.

UI policies dynamically change form behavior.

Examples:
  # Show this help
  jsn dev uipolicies

  # List UI policies
  jsn dev uipolicies list

  # Show a UI policy
  jsn dev uipolicies show "My Policy"

  # List with a filter
  jsn dev uipolicies list --query "table=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newUIPoliciesListCmd(),
		newUIPoliciesShowCmd(),
		newUIPoliciesCreateCmd(),
		newUIPoliciesUpdateCmd(),
		newUIPoliciesDeleteCmd(),
	)

	return cmd
}

func newUIPoliciesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI policies",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = uiPolicyDefaultColumns
			}

			return listUIPolicies(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newUIPoliciesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [description|sys_id]",
		Short: "Show UI policy details",
		Long: `Show detailed information about a UI policy.

Key fields displayed:
  - short_description, table, order
  - active status, condition
  - script execution flags
  - scope and timestamps`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			description := args[0]
			record, err := findUIPolicy(ctx, app, description)
			if err != nil {
				return err
			}

			// Build breadcrumbs for related actions
			breadcrumbs := []output.Breadcrumb{
				{
					Action:      "update",
					Cmd:         fmt.Sprintf("jsn dev uipolicies update %s --data '{...}'", description),
					Description: "Update this policy",
				},
				{
					Action:      "delete",
					Cmd:         fmt.Sprintf("jsn dev uipolicies delete %s", description),
					Description: "Delete this policy",
				},
				{
					Action:      "list",
					Cmd:         "jsn dev uipolicies list",
					Description: "List all policies",
				},
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("UI policy: %s", getStringField(record, "short_description"))),
				output.WithBreadcrumbs(breadcrumbs...),
			)
		},
	}

	return cmd
}

func newUIPoliciesCreateCmd() *cobra.Command {
	var (
		description string
		table       string
		condition   string
		order       int
		active      bool
		runScripts  bool
		scope       string
		data        string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new UI policy",
		Long: `Create a new UI policy in ServiceNow.

Required flags:
  --description, --table

Examples:
  jsn dev uipolicies create --description "Hide field" --table incident --condition "state==1" --run-scripts
  jsn dev uipolicies create --description "Field policy" --table task --order 200 --active`,
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
			if description != "" {
				recordData["short_description"] = description
			}
			if table != "" {
				recordData["table"] = table
			}
			if condition != "" {
				recordData["condition"] = condition
			}
			recordData["order"] = order
			recordData["active"] = active
			recordData["run_scripts"] = runScripts
			if scope != "" {
				recordData["sys_scope"] = scope
			}

			// Validate required fields
			if recordData["short_description"] == nil || recordData["short_description"] == "" {
				return fmt.Errorf("--description is required")
			}
			if recordData["table"] == nil || recordData["table"] == "" {
				return fmt.Errorf("--table is required")
			}

			record, err := app.SDK.Create(ctx, "sys_ui_policy", recordData)
			if err != nil {
				return fmt.Errorf("failed to create UI policy: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created UI policy: %s", getStringField(record, "short_description"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev uipolicies show %s", getStringField(record, "sys_id")),
						Description: "View the new policy",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev uipolicies update %s --data '{...}'", getStringField(record, "sys_id")),
						Description: "Update the policy",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uipolicies list",
						Description: "List all policies",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&description, "description", "d", "", "Policy description (required)")
	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name (required)")
	cmd.Flags().StringVarP(&condition, "condition", "c", "", "Condition script")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Execution order (lower = first)")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set policy as active")
	cmd.Flags().BoolVar(&runScripts, "run-scripts", false, "Run UI scripts when policy applies")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newUIPoliciesUpdateCmd() *cobra.Command {
	var (
		data      string
		condition string
		active    bool
		order     int
	)

	cmd := &cobra.Command{
		Use:   "update [description|sys_id]",
		Short: "Update a UI policy",
		Long: `Update an existing UI policy.

Use --data for full control or convenience flags for common fields:
  --condition, --active, --order

Examples:
  jsn dev uipolicies update "My Policy" --data '{"active": false}'
  jsn dev uipolicies update abc123 --condition "state==2" --order 200`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			description := args[0]

			// Find the policy
			record, err := findUIPolicy(ctx, app, description)
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
			if cmd.Flags().Changed("condition") {
				recordData["condition"] = condition
			}
			if cmd.Flags().Changed("active") {
				recordData["active"] = active
			}
			if cmd.Flags().Changed("order") {
				recordData["order"] = order
			}

			if len(recordData) == 0 {
				return fmt.Errorf("no updates specified (use --data, --condition, --active, or --order)")
			}

			updated, err := app.SDK.Update(ctx, "sys_ui_policy", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update UI policy: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated UI policy: %s", getStringField(updated, "short_description"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev uipolicies show %s", description),
						Description: "View the updated policy",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uipolicies list",
						Description: "List all policies",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().StringVarP(&condition, "condition", "c", "", "Update condition script")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set active status")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Update execution order")

	return cmd
}

func newUIPoliciesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [description|sys_id]",
		Short: "Delete a UI policy",
		Long:  `Delete a UI policy by description or sys_id.`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			description := args[0]

			// Find the policy
			record, err := findUIPolicy(ctx, app, description)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			policyDesc := getStringField(record, "short_description")
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
				fmt.Printf("Delete UI policy '%s'? [y/N]: ", policyDesc)
				var response string
				_, _ = fmt.Scanln(&response)
				if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
					return fmt.Errorf("delete cancelled")
				}
			}

			if err := app.SDK.Delete(ctx, "sys_ui_policy", sysID); err != nil {
				return fmt.Errorf("failed to delete UI policy: %w", err)
			}

			return app.OK(map[string]string{
				"short_description": policyDesc,
				"sys_id":            sysID,
				"message":           "UI policy deleted",
			},
				output.WithSummary(fmt.Sprintf("Deleted UI policy: %s", policyDesc)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev uipolicies list",
						Description: "List all policies",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev uipolicies create --description ...",
						Description: "Create a new policy",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")

	return cmd
}

func listUIPolicies(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = uiPolicyDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listUIPoliciesInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_ui_policy", params)
	if err != nil {
		return fmt.Errorf("failed to list UI policies: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_ui_policy",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d UI policy(s)", len(records))),
	)
}

// listUIPoliciesInteractive shows an interactive picker for UI policies with pagination
func listUIPoliciesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_ui_policy").
		WithColumns("short_description", "table", "active", "order").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			desc := getStringField(record, "short_description")
			table := getStringField(record, "table")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := IconActive
			if active != "true" {
				statusIcon = IconInactive
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, desc, table)

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
		return getUIPolicyBySysID(ctx, app, selected.ID)
	}

	return nil
}

func getUIPolicyBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_ui_policy", params)
	if err != nil {
		return fmt.Errorf("failed to find UI policy: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("UI policy not found: %s", sysID)
	}

	desc := getStringField(records[0], "short_description")
	return app.OK(wrapRecordWithContext(records[0], "sys_ui_policy", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("UI policy: %s", desc)),
	)
}

// findUIPolicy finds a UI policy by short_description or sys_id
func findUIPolicy(ctx context.Context, app *appctx.App, description string) (map[string]any, error) {
	var query string
	// Check if identifier looks like a sys_id (32 hex characters)
	if len(description) == 32 && isHexString(description) {
		query = "sys_id=" + description
	} else {
		query = "short_description=" + description
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	records, err := app.SDK.List(ctx, "sys_ui_policy", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find UI policy: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("UI policy not found: %s", description)
	}

	return records[0], nil
}
