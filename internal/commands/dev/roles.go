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

// roleDefaultColumns are the default columns for roles
var roleDefaultColumns = []string{"name", "description", "elevated_privilege", "sys_scope"}

// roleShowColumns are the columns for showing a single role

// NewRolesCmd creates the roles command.
func NewRolesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "roles",
		Aliases: []string{"role"},
		Short:   "Manage roles",
		Args:    cobra.NoArgs,
		Long: `Manage user roles.

Roles control access to application modules and functions.

Examples:
  # Show this help
  jsn dev roles

  # List roles
  jsn dev roles list

  # Show a role
  jsn dev roles show admin

  # Create a role
  jsn dev roles create --name "myapp.user" --description "My App User Role"

  # Update a role
  jsn dev roles update admin --description "Updated description"

  # Delete a role
  jsn dev roles delete myapp.test --force`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newRolesListCmd(),
		newRolesShowCmd(),
		newRolesCreateCmd(),
		newRolesUpdateCmd(),
		newRolesDeleteCmd(),
	)

	return cmd
}

func newRolesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List roles",
		Long: `List roles with optional filtering and column selection.

Examples:
  # List all roles
  jsn dev roles list

  # List elevated roles only
  jsn dev roles list --query "elevated_privilege=true"

  # List roles in a specific scope
  jsn dev roles list --query "sys_scope.scope=x_my_app"

  # Show specific columns
  jsn dev roles list --columns "name,description,sys_scope,sys_updated_on"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = roleDefaultColumns
			}

			return listRoles(ctx, app, query, cols, limit)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newRolesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show a role by name or sys_id",
		Long: `Display detailed information about a role.

The show command displays role metadata including name, description,
elevated privilege status, scope, and timestamps.

Examples:
  # Show by name
  jsn dev roles show admin

  # Show by sys_id
  jsn dev roles show abc123def456`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showRole(ctx, app, args[0])
		},
	}
}

func newRolesCreateCmd() *cobra.Command {
	var (
		name        string
		description string
		elevated    bool
		scope       string
		data        string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new role",
		Long: `Create a new role in ServiceNow.

You can provide data via flags or --data for more fields.
If using --data, flag values will be merged (flags take precedence).

Examples:
  # Create with name and description
  jsn dev roles create --name "myapp.user" --description "My App User Role"

  # Create an elevated role
  jsn dev roles create --name "myapp.admin" --description "My App Admin" --elevated

  # Create in specific scope
  jsn dev roles create --name "x_myapp.user" --scope "x_myapp" --description "..."

  # Create using JSON data
  jsn dev roles create --data '{"name":"x_myapp.user","description":"My role"}'`,
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
			if description != "" {
				recordData["description"] = description
			}
			recordData["elevated_privilege"] = elevated

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("name is required (use --name or --data)")
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
			record, err := app.SDK.Create(ctx, "sys_user_role", recordData)
			if err != nil {
				return fmt.Errorf("failed to create role: %w", err)
			}

			createdName := getStringField(record, "name")

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created role '%s'", createdName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev roles show %s", createdName),
						Description: "View the new role",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev roles update %s --description '...'", createdName),
						Description: "Update this role",
					},
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev roles create --name '...' --description '...'",
						Description: "Create another role",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev roles list",
						Description: "Back to all roles",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Role name (required, e.g., 'itil', 'x_myapp.admin')")
	cmd.Flags().StringVarP(&description, "description", "d", "", "Role description")
	cmd.Flags().BoolVar(&elevated, "elevated", false, "Elevated privilege (default: false)")
	cmd.Flags().StringVar(&scope, "scope", "", "Target scope (defaults to current user scope)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func newRolesUpdateCmd() *cobra.Command {
	var (
		data        string
		description string
		elevated    bool
	)

	cmd := &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update a role",
		Long: `Update an existing role by name or sys_id.

Scope validation is performed - you can only update records in your current scope.

Examples:
  # Update role description
  jsn dev roles update admin --description "System Administrator Role"

  # Update elevated flag
  jsn dev roles update myapp.admin --elevated

  # Update using JSON data
  jsn dev roles update admin --data '{"description":"Updated desc"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findRoleByNameOrSysID(ctx, app, identifier)
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
				return fmt.Errorf("role '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
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

			// Merge flag values (flags take precedence over data)
			if description != "" {
				recordData["description"] = description
			}
			// Only set elevated if the flag was explicitly provided
			if cmd.Flags().Changed("elevated") {
				recordData["elevated_privilege"] = elevated
			}

			// Validate we have something to update
			if len(recordData) == 0 {
				return fmt.Errorf("no updates provided (use --data, --description, or --elevated)")
			}

			// Update the record
			updated, err := app.SDK.Update(ctx, "sys_user_role", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update role: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated role '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev roles show %s", recordName),
						Description: "View the updated role",
					},
					output.Breadcrumb{
						Action:      "update",
						Cmd:         fmt.Sprintf("jsn dev roles update %s --data '{...}'", recordName),
						Description: "Update again",
					},
					output.Breadcrumb{
						Action:      "delete",
						Cmd:         fmt.Sprintf("jsn dev roles delete %s", recordName),
						Description: "Delete this role",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev roles list",
						Description: "Back to all roles",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update")
	cmd.Flags().StringVarP(&description, "description", "d", "", "New description")
	cmd.Flags().BoolVar(&elevated, "elevated", false, "Set elevated privilege")

	return cmd
}

func newRolesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a role",
		Long: `Delete a role by name or sys_id.

Scope validation is performed - you can only delete records in your current scope.
This operation requires confirmation unless --force is used.

Examples:
  # Delete with confirmation prompt
  jsn dev roles delete myapp.test

  # Delete without confirmation
  jsn dev roles delete myapp.test --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Find the record
			record, err := findRoleByNameOrSysID(ctx, app, identifier)
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
				return fmt.Errorf("role '%s' is in scope '%s', but your current scope is '%s'. Switch scope first: jsn dev scopes set %s",
					recordName, recordScope, currentScope, recordScope)
			}

			// Confirmation prompt (if TTY and not --force)
			if !force && output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) {
				fmt.Fprintf(os.Stdout, "Delete role '%s'? (y/N): ", recordName)
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
			if err := app.SDK.Delete(ctx, "sys_user_role", sysID); err != nil {
				return fmt.Errorf("failed to delete role: %w", err)
			}

			return app.OK(map[string]any{
				"name":    recordName,
				"sys_id":  sysID,
				"deleted": true,
			},
				output.WithSummary(fmt.Sprintf("Deleted role '%s'", recordName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "create",
						Cmd:         "jsn dev roles create --name '...' --description '...'",
						Description: "Create a new role",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev roles list",
						Description: "Back to all roles",
					},
				),
			)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

func listRoles(ctx context.Context, app *appctx.App, query string, columns []string, limit int) error {
	if len(columns) == 0 {
		columns = roleDefaultColumns
	}

	// Use default limit if not specified
	if limit <= 0 {
		limit = 20
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listRolesInteractive(ctx, app, query, limit)
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

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return fmt.Errorf("failed to list roles: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         "jsn dev roles create --name '...' --description '...'",
			Description: "Create a new role",
		},
		{
			Action:      "filter",
			Cmd:         "jsn dev roles list --query \"elevated_privilege=true\"",
			Description: "Filter: elevated roles only",
		},
	}

	return app.OK(map[string]any{
		"table":   "sys_user_role",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d role(s)", len(records))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listRolesInteractive shows an interactive picker for roles with pagination
func listRolesInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	// Create a reusable list fetcher configured for roles
	fetcher := tui.NewListFetcher("sys_user_role").
		WithColumns("name", "description", "elevated_privilege", "sys_scope").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			desc := getStringField(record, "description")
			elevated := getStringField(record, "elevated_privilege")
			scope := getStringField(record, "sys_scope")
			sysID := getStringField(record, "sys_id")

			// Format title: NAME | SCOPE | ELEVATED
			icon := "◌"
			if elevated == "true" {
				icon = "⚡"
			}

			title := fmt.Sprintf("%s %-30s | %s", icon, name, scope)
			if desc != "" {
				title = fmt.Sprintf("%s %-30s | %s | %s", icon, name, truncateString(desc, 25), scope)
			}

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

	// If user selected a role, show its details
	if selected != nil {
		// Extract name from title (format: ICON NAME ...)
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			return showRole(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return showRole(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// showRole displays a single role with full details
func showRole(ctx context.Context, app *appctx.App, identifier string) error {
	record, err := findRoleByNameOrSysID(ctx, app, identifier)
	if err != nil {
		return err
	}

	name := getStringField(record, "name")
	recordScope := getStringField(record, "sys_scope")

	// Add context for formatter to create links
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_user_role",
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn dev roles update %s --description '...'", name),
			Description: "Update this role",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn dev roles delete %s", name),
			Description: "Delete this role",
		},
		{
			Action:      "list",
			Cmd:         "jsn dev roles list",
			Description: "Back to all roles",
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
		output.WithSummary(fmt.Sprintf("Role: %s", name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findRoleByNameOrSysID finds a role by name or sys_id
func findRoleByNameOrSysID(ctx context.Context, app *appctx.App, identifier string) (map[string]any, error) {
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

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find role: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("role not found: %s", identifier)
	}

	return records[0], nil
}
