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

// ruleDefaultColumns are the default columns for business rules
var ruleDefaultColumns = []string{"name", "collection", "active", "order", "sys_scope"}

// NewRulesCmd creates the rules command.
func NewRulesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "rules",
		Aliases: []string{"rule", "br"},
		Short:   "Manage business rules",
		Args:    cobra.NoArgs,
		Long: `Manage business rules.

Business rules run when database operations occur.

Examples:
  # Show this help
  jsn dev rules

  # List business rules
  jsn dev rules list

  # Show a business rule
  jsn dev rules show "My Rule"

  # List with a filter
  jsn dev rules list --query "collection=incident"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newRulesListCmd(),
		newRulesShowCmd(),
		newRulesCreateCmd(),
		newRulesUpdateCmd(),
		newRulesDeleteCmd(),
	)

	return cmd
}

func newRulesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List business rules",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = ruleDefaultColumns
			}

			return listRules(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newRulesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show business rule details",
		Long: `Show detailed information about a business rule.

Key fields displayed:
  - name, collection (table), order
  - when (before/after), action flags
  - script content
  - scope and timestamps`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			name := args[0]
			record, err := findRule(ctx, app, name)
			if err != nil {
				return err
			}

			// Build breadcrumbs for related actions
			breadcrumbs := []output.Breadcrumb{
				{
					Action:      "update",
					Cmd:         fmt.Sprintf("jsn dev rules update %s --data '{...}'", name),
					Description: "Update this rule",
				},
				{
					Action:      "delete",
					Cmd:         fmt.Sprintf("jsn dev rules delete %s", name),
					Description: "Delete this rule",
				},
				{
					Action:      "list",
					Cmd:         "jsn dev rules list",
					Description: "List all rules",
				},
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Business rule: %s", getStringField(record, "name"))),
				output.WithBreadcrumbs(breadcrumbs...),
			)
		},
	}

	return cmd
}

func newRulesCreateCmd() *cobra.Command {
	var (
		name         string
		collection   string
		when         string
		script       string
		order        int
		active       bool
		insert       bool
		update       bool
		delete       bool
		query        bool
		businessRule bool
		data         string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new business rule",
		Long: `Create a new business rule in ServiceNow.

Required flags:
  --name, --collection, --when, --script

Action flags determine when the rule runs:
  --insert, --update, --delete, --query

Examples:
  jsn dev rules create --name "My Rule" --collection incident --when before --script "gs.info('Hello');"
  jsn dev rules create --name "On Insert" --collection task --when after --insert --script "current.update();"`,
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
			if collection != "" {
				recordData["collection"] = collection
			}
			if when != "" {
				recordData["when"] = when
			}
			if script != "" {
				recordData["script"] = script
			}
			recordData["order"] = order
			recordData["active"] = active
			recordData["action_insert"] = insert
			recordData["action_update"] = update
			recordData["action_delete"] = delete
			recordData["action_query"] = query
			recordData["business_rule"] = businessRule

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("--name is required")
			}
			if recordData["collection"] == nil || recordData["collection"] == "" {
				return fmt.Errorf("--collection (table name) is required")
			}
			if recordData["when"] == nil || recordData["when"] == "" {
				return fmt.Errorf("--when is required (before, after, async, etc.)")
			}
			if recordData["script"] == nil || recordData["script"] == "" {
				return fmt.Errorf("--script is required")
			}

			// Ensure at least one action is enabled
			if !insert && !update && !delete && !query && !businessRule {
				// Default to running on insert and update if no actions specified
				recordData["action_insert"] = true
				recordData["action_update"] = true
			}

			record, err := app.SDK.Create(ctx, "sys_script", recordData)
			if err != nil {
				return fmt.Errorf("failed to create business rule: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created business rule: %s", getStringField(record, "name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev rules show %s", getStringField(record, "sys_id")),
						Description: "View the new rule",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev rules update %s --data '{...}'", getStringField(record, "sys_id")),
						Description: "Update the rule",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev rules list",
						Description: "List all rules",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Rule name (required)")
	cmd.Flags().StringVarP(&collection, "collection", "t", "", "Table name/collection (required)")
	cmd.Flags().StringVarP(&when, "when", "w", "", "When to run: before, after, async (required)")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Script content (required)")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Execution order (lower = first)")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set rule as active")
	cmd.Flags().BoolVar(&insert, "insert", false, "Run on insert")
	cmd.Flags().BoolVar(&update, "update", false, "Run on update")
	cmd.Flags().BoolVar(&delete, "delete", false, "Run on delete")
	cmd.Flags().BoolVar(&query, "query", false, "Run on query")
	cmd.Flags().BoolVar(&businessRule, "business-rule", false, "Is business rule")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newRulesUpdateCmd() *cobra.Command {
	var (
		data   string
		script string
		active bool
		order  int
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update a business rule",
		Long: `Update an existing business rule.

Use --data for full control or convenience flags for common fields:
  --script, --active, --order

Examples:
  jsn dev rules update "My Rule" --data '{"active": false}'
  jsn dev rules update abc123 --script "gs.info('Updated');"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			name := args[0]

			// Find the rule
			record, err := findRule(ctx, app, name)
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
			if cmd.Flags().Changed("order") {
				recordData["order"] = order
			}

			if len(recordData) == 0 {
				return fmt.Errorf("no updates specified (use --data, --script, --active, or --order)")
			}

			updated, err := app.SDK.Update(ctx, "sys_script", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update business rule: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated business rule: %s", getStringField(updated, "name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev rules show %s", name),
						Description: "View the updated rule",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev rules list",
						Description: "List all rules",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().StringVarP(&script, "script", "s", "", "Update script content")
	cmd.Flags().BoolVarP(&active, "active", "a", true, "Set active status")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Update execution order")

	return cmd
}

func newRulesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a business rule",
		Long:  `Delete a business rule by name or sys_id.`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			name := args[0]

			// Find the rule
			record, err := findRule(ctx, app, name)
			if err != nil {
				return err
			}

			sysID := getStringField(record, "sys_id")
			ruleName := getStringField(record, "name")
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
				fmt.Printf("Delete business rule '%s'? [y/N]: ", ruleName)
				var response string
				_, _ = fmt.Scanln(&response)
				if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
					return fmt.Errorf("delete cancelled")
				}
			}

			if err := app.SDK.Delete(ctx, "sys_script", sysID); err != nil {
				return fmt.Errorf("failed to delete business rule: %w", err)
			}

			return app.OK(map[string]string{
				"name":    ruleName,
				"sys_id":  sysID,
				"message": "Business rule deleted",
			},
				output.WithSummary(fmt.Sprintf("Deleted business rule: %s", ruleName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev rules list",
						Description: "List all rules",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev rules create --name ...",
						Description: "Create a new rule",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")

	return cmd
}

func listRules(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = ruleDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listRulesInteractive(ctx, app, query, 20)
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

	records, err := app.SDK.List(ctx, "sys_script", params)
	if err != nil {
		return fmt.Errorf("failed to list business rules: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_script",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d business rule(s)", len(records))),
	)
}

// listRulesInteractive shows an interactive picker for business rules with pagination
func listRulesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_script").
		WithColumns("name", "collection", "active", "order").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			collection := getStringField(record, "collection")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := IconActive
			if active != "true" {
				statusIcon = IconInactive
			}

			title := fmt.Sprintf("%s %s | %s", statusIcon, name, collection)

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
		return getRuleByName(ctx, app, selected.ID)
	}

	return nil
}

func getRuleByName(ctx context.Context, app *appctx.App, name string) error {
	record, err := findRule(ctx, app, name)
	if err != nil {
		return err
	}

	// Build breadcrumbs for related actions
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev rules update %s --data '{...}'", name),
			Description: "Update this rule",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev rules delete %s", name),
			Description: "Delete this rule",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev rules list",
			Description: "List all rules",
		},
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Business rule: %s", getStringField(record, "name"))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findRule finds a business rule by name or sys_id
func findRule(ctx context.Context, app *appctx.App, name string) (map[string]any, error) {
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

	records, err := app.SDK.List(ctx, "sys_script", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find business rule: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("business rule not found: %s", name)
	}

	return records[0], nil
}
