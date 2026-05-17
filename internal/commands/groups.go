// Package commands provides CLI commands.
package commands

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

// groupDefaultColumns are the default columns to show for groups
var groupDefaultColumns = []string{"name", "manager", "email"}

// NewGroupsCmd creates the groups command group.
func NewGroupsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "groups",
		Aliases: []string{"group"},
		Short:   "Manage ServiceNow groups",
		Long: `Manage ServiceNow user groups.

Examples:
  # Show this help
  jsn groups

  # List groups
  jsn groups list

  # List groups by name
  jsn groups list --query "nameLIKEIT Support"

  # List with a filter
  jsn groups list --query "active=true"`,
	}

	cmd.AddCommand(
		newGroupsListCmd(),
		newGroupsShowCmd(),
		newGroupsCreateCmd(),
		newGroupsUpdateCmd(),
		newGroupsDeleteCmd(),
	)

	return cmd
}

func newGroupsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List groups",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = groupDefaultColumns
			}

			return listGroups(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newGroupsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name]",
		Short: "Show a specific group by name",
		Long: `Display detailed information about a user group by its unique name.

Examples:
  # Show group by name
  jsn groups show "IT Support"

  # Show group by sys_id
  jsn groups show abc123def456abc123def456abc12345`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			groupName := args[0]
			return showGroupByName(ctx, app, groupName)
		},
	}
}

// showGroupByName displays detailed information about a group.
func showGroupByName(ctx context.Context, app *appctx.App, groupName string) error {
	// Query by exact name match to get the group
	params := url.Values{}
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "sys_id,name,manager,group_email,parent,description,active")
	params.Set("sysparm_query", "name="+groupName)

	groups, err := app.SDK.List(ctx, "sys_user_group", params)
	if err != nil {
		return fmt.Errorf("failed to find group: %w", err)
	}

	if len(groups) == 0 {
		return fmt.Errorf("group not found: %s", groupName)
	}

	group := groups[0]
	groupSysID := getDisplayValue(group, "sys_id")

	// Fetch related data concurrently
	type queryResult struct {
		data []map[string]any
		err  error
	}

	rolesChan := make(chan queryResult, 1)
	membersChan := make(chan queryResult, 1)
	childrenChan := make(chan queryResult, 1)

	// Fetch roles
	go func() {
		roleParams := url.Values{}
		roleParams.Set("sysparm_display_value", "all")
		roleParams.Set("sysparm_fields", "role")
		roleParams.Set("sysparm_query", "group="+groupSysID)
		data, err := app.SDK.List(ctx, "sys_group_has_role", roleParams)
		rolesChan <- queryResult{formatRelatedRecords(data, "role"), err}
	}()

	// Fetch members
	go func() {
		memberParams := url.Values{}
		memberParams.Set("sysparm_display_value", "all")
		memberParams.Set("sysparm_fields", "user")
		memberParams.Set("sysparm_query", "group="+groupSysID)
		data, err := app.SDK.List(ctx, "sys_user_grmember", memberParams)
		membersChan <- queryResult{formatMemberRecords(data), err}
	}()

	// Fetch child groups
	go func() {
		childParams := url.Values{}
		childParams.Set("sysparm_display_value", "all")
		childParams.Set("sysparm_fields", "name")
		childParams.Set("sysparm_query", "parent="+groupSysID)
		data, err := app.SDK.List(ctx, "sys_user_group", childParams)
		childrenChan <- queryResult{formatRelatedRecords(data, "name"), err}
	}()

	// Collect results
	rolesResult := <-rolesChan
	membersResult := <-membersChan
	childrenResult := <-childrenChan

	if rolesResult.err != nil {
		return fmt.Errorf("failed to fetch roles: %w", rolesResult.err)
	}
	if membersResult.err != nil {
		return fmt.Errorf("failed to fetch members: %w", membersResult.err)
	}
	if childrenResult.err != nil {
		return fmt.Errorf("failed to fetch child groups: %w", childrenResult.err)
	}

	// Format output
	formatted := formatGroupDisplay(
		group,
		rolesResult.data,
		membersResult.data,
		childrenResult.data,
		app.Config.GetEffectiveInstance(),
	)

	return app.OK(map[string]any{
		"_formatted": formatted,
		"_raw": map[string]any{
			"group":   group,
			"roles":   rolesResult.data,
			"members": membersResult.data,
			"groups":  childrenResult.data,
		},
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_user_group",
		},
	},
		output.WithSummary(fmt.Sprintf("Group %s", groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn groups list",
				Description: "Back to all groups",
			},
			output.Breadcrumb{
				Action:      "add-user",
				Cmd:         fmt.Sprintf("jsn groupmembers add --group \"%s\" --user <username>", groupName),
				Description: "Add a user to this group",
			},
			output.Breadcrumb{
				Action:      "add-role",
				Cmd:         fmt.Sprintf("jsn grouproles add --group \"%s\" --role <role_name>", groupName),
				Description: "Add a role to this group",
			},
		),
	)
}

// formatGroupDisplay formats a group for terminal display.
// This is command-specific formatting owned by the groups command.
func formatGroupDisplay(group map[string]any, roles, members, children []map[string]any, instanceURL string) string {
	var b strings.Builder

	groupName := getDisplayValue(group, "name")
	if groupName == "" {
		groupName = "Unknown Group"
	}

	b.WriteString(fmt.Sprintf("\nGroup %s\n\n", groupName))

	// Core section
	b.WriteString("─ Core ─\n")

	coreFields := []struct {
		label string
		field string
	}{
		{"name", "name"},
		{"manager", "manager"},
		{"group_email", "group_email"},
		{"parent", "parent"},
		{"active", "active"},
	}

	for _, f := range coreFields {
		value := getDisplayValue(group, f.field)
		if value != "" {
			b.WriteString(fmt.Sprintf("  %s: %s\n", f.label, value))
		}
	}

	// Description (multi-line handling)
	desc := getDisplayValue(group, "description")
	if desc != "" {
		if strings.Contains(desc, "\n") {
			b.WriteString("  description:\n")
			for _, line := range strings.Split(desc, "\n") {
				b.WriteString(fmt.Sprintf("    %s\n", line))
			}
		} else {
			b.WriteString(fmt.Sprintf("  description: %s\n", desc))
		}
	}
	b.WriteString("\n")

	// Roles section
	if len(roles) > 0 {
		b.WriteString("─ Roles ─\n")
		for _, role := range roles {
			if name, ok := role["name"].(string); ok && name != "" {
				b.WriteString(fmt.Sprintf("  %s\n", name))
			}
		}
		b.WriteString("\n")
	}

	// Members section
	if len(members) > 0 {
		b.WriteString("─ Members ─\n")
		for _, member := range members {
			displayName, _ := member["display_name"].(string)
			userName, _ := member["user_name"].(string)
			if displayName != "" && userName != "" {
				b.WriteString(fmt.Sprintf("  %s [%s]\n", displayName, userName))
			} else if displayName != "" {
				b.WriteString(fmt.Sprintf("  %s\n", displayName))
			}
		}
		b.WriteString("\n")
	}

	// Child Groups section
	if len(children) > 0 {
		b.WriteString("─ Groups ─\n")
		for _, child := range children {
			if name, ok := child["name"].(string); ok && name != "" {
				b.WriteString(fmt.Sprintf("  %s\n", name))
			}
		}
		b.WriteString("\n")
	}

	// Add link
	if instanceURL != "" {
		sysID := getDisplayValue(group, "sys_id")
		if sysID != "" {
			recordURL := fmt.Sprintf("%s/sys_user_group.do?sys_id=%s", instanceURL, sysID)
			b.WriteString(fmt.Sprintf("Link:  %s\n\n", recordURL))
		}
	}

	return b.String()
}

// formatRelatedRecords extracts display values from related records
func formatRelatedRecords(records []map[string]any, field string) []map[string]any {
	var result []map[string]any
	for _, rec := range records {
		value := getDisplayValue(rec, field)
		if value != "" {
			result = append(result, map[string]any{
				"name": value,
			})
		}
	}
	return result
}

// formatMemberRecords formats user records with display name and username
func formatMemberRecords(records []map[string]any) []map[string]any {
	var result []map[string]any
	for _, rec := range records {
		if userField, ok := rec["user"].(map[string]any); ok {
			display := ""
			if dv, ok := userField["display_value"].(string); ok {
				display = dv
			}
			// Try to extract username from the display or value
			username := ""
			if val, ok := userField["value"].(string); ok {
				username = val
			}
			result = append(result, map[string]any{
				"display_name": display,
				"user_name":    username,
			})
		}
	}
	return result
}

func listGroups(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = groupDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listGroupsInteractive(ctx, app, query)
	}

	// Non-interactive: use normal list output
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

	records, err := app.SDK.List(ctx, "sys_user_group", params)
	if err != nil {
		return fmt.Errorf("failed to list groups: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_user_group",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d group(s)", len(records))),
	)
}

// listGroupsInteractive shows an interactive picker for groups with pagination
func listGroupsInteractive(ctx context.Context, app *appctx.App, baseQuery string) error {
	// Create a reusable list fetcher configured for groups
	fetcher := tui.NewListFetcher("sys_user_group").
		WithColumns("name", "manager", "email").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			manager := getStringField(record, "manager")
			email := getStringField(record, "email")
			sysID := getStringField(record, "sys_id")

			// Format title: NAME → MANAGER (EMAIL)
			title := name
			if manager != "" && manager != "null" {
				title += fmt.Sprintf(" → %s", manager)
			}
			if email != "" {
				title += fmt.Sprintf(" (%s)", email)
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	// Show the interactive picker
	selected, err := tui.ListInteractive(ctx, app, fetcher, 20)
	if err != nil {
		return err
	}

	// If user selected a group, show its details
	if selected != nil {
		// Title format: NAME → MANAGER...
		parts := strings.SplitN(selected.Title, " →", 2)
		if len(parts) >= 1 {
			groupName := parts[0]
			return showGroupByName(ctx, app, groupName)
		}
		// Fallback: try to get by sys_id
		return getGroupBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getGroupBySysID retrieves a group by its sys_id.
func getGroupBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(groupDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "sys_user_group", params)
	if err != nil {
		return fmt.Errorf("failed to get group: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("group not found: %s", sysID)
	}

	return app.OK(records[0],
		output.WithSummary(fmt.Sprintf("Group %s", getStringField(records[0], "name"))),
	)
}

func newGroupsCreateCmd() *cobra.Command {
	var (
		name    string
		manager string
		data    string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new group",
		Long: `Create a new user group in ServiceNow.

Examples:
  # Create a basic group
  jsn groups create --name "My Group"

  # Create with manager
  jsn groups create --name "IT Support" --manager "admin"

  # Create with custom data
  jsn groups create --data '{"name": "Dev Team", "description": "Development team"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			recordData := make(map[string]any)

			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			if name != "" {
				recordData["name"] = name
			}
			if manager != "" {
				recordData["manager"] = manager
			}

			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("name is required (use --name or --data)")
			}

			record, err := app.SDK.Create(cmd.Context(), "sys_user_group", recordData)
			if err != nil {
				return fmt.Errorf("failed to create group: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created group %s", getDisplayValue(record, "name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn groups show %s", getDisplayValue(record, "name")),
						Description: "View the new group",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Group name (required if not in --data)")
	cmd.Flags().StringVarP(&manager, "manager", "m", "", "Manager username")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newGroupsUpdateCmd() *cobra.Command {
	var data string

	cmd := &cobra.Command{
		Use:   "update [name]",
		Short: "Update a group",
		Long: `Update an existing user group by name.

Examples:
  # Update group manager
  jsn groups update "IT Support" --data '{"manager": "new.manager"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			groupName := args[0]

			if data == "" {
				return fmt.Errorf("--data is required")
			}

			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			// Find group by name
			params := url.Values{}
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_display_value", "all")
			params.Set("sysparm_fields", "sys_id")
			params.Set("sysparm_query", "name="+groupName)

			records, err := app.SDK.List(cmd.Context(), "sys_user_group", params)
			if err != nil {
				return fmt.Errorf("failed to find group: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("group not found: %s", groupName)
			}

			sysID := getDisplayValue(records[0], "sys_id")

			updated, err := app.SDK.Update(cmd.Context(), "sys_user_group", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update group: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated group %s", groupName)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn groups show %s", groupName),
						Description: "View the updated group",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required)")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newGroupsDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete [name]",
		Short: "Delete a group",
		Long:  "Delete a user group by its unique name.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			groupName := args[0]

			// Find group by name
			params := url.Values{}
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_display_value", "all")
			params.Set("sysparm_fields", "sys_id")
			params.Set("sysparm_query", "name="+groupName)

			records, err := app.SDK.List(cmd.Context(), "sys_user_group", params)
			if err != nil {
				return fmt.Errorf("failed to find group: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("group not found: %s", groupName)
			}

			sysID := getDisplayValue(records[0], "sys_id")

			if err := app.SDK.Delete(cmd.Context(), "sys_user_group", sysID); err != nil {
				return fmt.Errorf("failed to delete group: %w", err)
			}

			return app.OK(map[string]string{
				"name":    groupName,
				"message": "Group deleted",
			}, output.WithSummary(fmt.Sprintf("Deleted group %s", groupName)))
		},
	}
}

// getDisplayValue extracts a display value from a record field
func getDisplayValue(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			if display, ok := v["display_value"].(string); ok {
				return display
			}
			if value, ok := v["value"].(string); ok {
				return value
			}
		}
		return fmt.Sprintf("%v", val)
	}
	return ""
}
