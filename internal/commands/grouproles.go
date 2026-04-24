// Package commands provides CLI commands.
package commands

import (
	"context"
	"fmt"
	"net/url"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// NewGroupRolesCmd creates the grouproles command group.
func NewGroupRolesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "grouproles",
		Aliases: []string{"grouprole", "grole", "gr"},
		Short:   "Manage group roles",
		Long: `Manage role assignments to ServiceNow groups.

Examples:
  # Add a role to a group
  jsn grouproles add --group "IT Support" --role "itil"

  # Remove a role from a group
  jsn grouproles remove --group "IT Support" --role "itil"

  # List roles of a group
  jsn grouproles list --group "IT Support"`,
	}

	cmd.AddCommand(
		newGroupRolesAddCmd(),
		newGroupRolesRemoveCmd(),
		newGroupRolesListCmd(),
	)

	return cmd
}

func newGroupRolesAddCmd() *cobra.Command {
	var (
		groupName string
		roleName  string
	)

	cmd := &cobra.Command{
		Use:   "add",
		Short: "Add a role to a group",
		Long: `Add a role to a ServiceNow group.

Examples:
  jsn grouproles add --group "IT Support" --role "itil"
  jsn gr add -g "IT Support" -r "admin"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" || roleName == "" {
				return fmt.Errorf("--group and --role are required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return addGroupRole(ctx, app, groupName, roleName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	cmd.Flags().StringVarP(&roleName, "role", "r", "", "Role name to add (required)")
	_ = cmd.MarkFlagRequired("group")
	_ = cmd.MarkFlagRequired("role")

	return cmd
}

func newGroupRolesRemoveCmd() *cobra.Command {
	var (
		groupName string
		roleName  string
	)

	cmd := &cobra.Command{
		Use:   "remove",
		Short: "Remove a role from a group",
		Long: `Remove a role from a ServiceNow group.

Examples:
  jsn grouproles remove --group "IT Support" --role "itil"
  jsn gr remove -g "IT Support" -r "admin"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" || roleName == "" {
				return fmt.Errorf("--group and --role are required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return removeGroupRole(ctx, app, groupName, roleName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	cmd.Flags().StringVarP(&roleName, "role", "r", "", "Role name to remove (required)")
	_ = cmd.MarkFlagRequired("group")
	_ = cmd.MarkFlagRequired("role")

	return cmd
}

func newGroupRolesListCmd() *cobra.Command {
	var groupName string

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List roles of a group",
		Long: `List all roles assigned to a ServiceNow group.

Examples:
  jsn grouproles list --group "IT Support"
  jsn gr list -g "IT Support"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" {
				return fmt.Errorf("--group is required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listGroupRoles(ctx, app, groupName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	_ = cmd.MarkFlagRequired("group")

	return cmd
}

func addGroupRole(ctx context.Context, app *appctx.App, groupName, roleName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// Find role sys_id
	roleSysID, err := findRoleSysID(ctx, app, roleName)
	if err != nil {
		return err
	}

	// Check if role assignment already exists
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s^role=%s", groupSysID, roleSysID))
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	existing, err := app.SDK.List(ctx, "sys_group_has_role", params)
	if err != nil {
		return fmt.Errorf("failed to check existing role assignment: %w", err)
	}
	if len(existing) > 0 {
		return fmt.Errorf("group %s already has role %s", groupName, roleName)
	}

	// Create the role assignment record
	recordData := map[string]any{
		"group": groupSysID,
		"role":  roleSysID,
	}

	record, err := app.SDK.Create(ctx, "sys_group_has_role", recordData)
	if err != nil {
		return fmt.Errorf("failed to add role to group: %w", err)
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Added role %s to %s", roleName, groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn grouproles list --group \"%s\"", groupName),
				Description: "List group roles",
			},
			output.Breadcrumb{
				Action:      "remove",
				Cmd:         fmt.Sprintf("jsn grouproles remove --group \"%s\" --role \"%s\"", groupName, roleName),
				Description: "Remove this role",
			},
		),
	)
}

func removeGroupRole(ctx context.Context, app *appctx.App, groupName, roleName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// Find role sys_id
	roleSysID, err := findRoleSysID(ctx, app, roleName)
	if err != nil {
		return err
	}

	// Find the role assignment record
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s^role=%s", groupSysID, roleSysID))
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_group_has_role", params)
	if err != nil {
		return fmt.Errorf("failed to find role assignment: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("group %s does not have role %s", groupName, roleName)
	}

	assignmentSysID := getDisplayValue(records[0], "sys_id")

	// Delete the role assignment record
	if err := app.SDK.Delete(ctx, "sys_group_has_role", assignmentSysID); err != nil {
		return fmt.Errorf("failed to remove role from group: %w", err)
	}

	return app.OK(map[string]string{
		"role":  roleName,
		"group": groupName,
	},
		output.WithSummary(fmt.Sprintf("Removed role %s from %s", roleName, groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn grouproles list --group \"%s\"", groupName),
				Description: "List group roles",
			},
			output.Breadcrumb{
				Action:      "add",
				Cmd:         fmt.Sprintf("jsn grouproles add --group \"%s\" --role \"%s\"", groupName, roleName),
				Description: "Add role back to group",
			},
		),
	)
}

func listGroupRoles(ctx context.Context, app *appctx.App, groupName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// List roles
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s", groupSysID))
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "role")
	params.Set("sysparm_limit", "100")

	records, err := app.SDK.List(ctx, "sys_group_has_role", params)
	if err != nil {
		return fmt.Errorf("failed to list group roles: %w", err)
	}

	var roles []map[string]string
	for _, record := range records {
		if roleField, ok := record["role"].(map[string]any); ok {
			roleName := ""
			if dv, ok := roleField["display_value"].(string); ok {
				roleName = dv
			}
			roles = append(roles, map[string]string{
				"role": roleName,
			})
		}
	}

	return app.OK(map[string]any{
		"group": groupName,
		"count": len(roles),
		"roles": roles,
	},
		output.WithSummary(fmt.Sprintf("%d role(s) assigned to %s", len(roles), groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "add",
				Cmd:         fmt.Sprintf("jsn grouproles add --group \"%s\" --role \"<role_name>\"", groupName),
				Description: "Add a role to this group",
			},
			output.Breadcrumb{
				Action:      "group",
				Cmd:         fmt.Sprintf("jsn groups show \"%s\"", groupName),
				Description: "View group details",
			},
		),
	)
}

// findRoleSysID finds a role by name and returns its sys_id
func findRoleSysID(ctx context.Context, app *appctx.App, roleName string) (string, error) {
	params := url.Values{}
	params.Set("sysparm_query", "name="+roleName)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_user_role", params)
	if err != nil {
		return "", fmt.Errorf("failed to find role: %w", err)
	}
	if len(records) == 0 {
		return "", fmt.Errorf("role not found: %s", roleName)
	}

	return getDisplayValue(records[0], "sys_id"), nil
}
