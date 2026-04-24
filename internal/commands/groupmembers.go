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

// NewGroupMembersCmd creates the groupmembers command group.
func NewGroupMembersCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "groupmembers",
		Aliases: []string{"groupmember", "gmember", "gm"},
		Short:   "Manage group memberships",
		Long: `Manage user memberships in ServiceNow groups.

Examples:
  # Add a user to a group
  jsn groupmembers add --group "IT Support" --user "john.smith"

  # Remove a user from a group
  jsn groupmembers remove --group "IT Support" --user "john.smith"

  # List members of a group
  jsn groupmembers list --group "IT Support"`,
	}

	cmd.AddCommand(
		newGroupMembersAddCmd(),
		newGroupMembersRemoveCmd(),
		newGroupMembersListCmd(),
	)

	return cmd
}

func newGroupMembersAddCmd() *cobra.Command {
	var (
		groupName string
		userName  string
	)

	cmd := &cobra.Command{
		Use:   "add",
		Short: "Add a user to a group",
		Long: `Add a user to a ServiceNow group.

Examples:
  jsn groupmembers add --group "IT Support" --user "john.smith"
  jsn gm add -g "IT Support" -u "john.smith"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" || userName == "" {
				return fmt.Errorf("--group and --user are required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return addGroupMember(ctx, app, groupName, userName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	cmd.Flags().StringVarP(&userName, "user", "u", "", "Username to add (required)")
	_ = cmd.MarkFlagRequired("group")
	_ = cmd.MarkFlagRequired("user")

	return cmd
}

func newGroupMembersRemoveCmd() *cobra.Command {
	var (
		groupName string
		userName  string
	)

	cmd := &cobra.Command{
		Use:   "remove",
		Short: "Remove a user from a group",
		Long: `Remove a user from a ServiceNow group.

Examples:
  jsn groupmembers remove --group "IT Support" --user "john.smith"
  jsn gm remove -g "IT Support" -u "john.smith"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" || userName == "" {
				return fmt.Errorf("--group and --user are required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return removeGroupMember(ctx, app, groupName, userName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	cmd.Flags().StringVarP(&userName, "user", "u", "", "Username to remove (required)")
	_ = cmd.MarkFlagRequired("group")
	_ = cmd.MarkFlagRequired("user")

	return cmd
}

func newGroupMembersListCmd() *cobra.Command {
	var groupName string

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List members of a group",
		Long: `List all users who are members of a ServiceNow group.

Examples:
  jsn groupmembers list --group "IT Support"
  jsn gm list -g "IT Support"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if groupName == "" {
				return fmt.Errorf("--group is required")
			}

			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listGroupMembers(ctx, app, groupName)
		},
	}

	cmd.Flags().StringVarP(&groupName, "group", "g", "", "Group name (required)")
	_ = cmd.MarkFlagRequired("group")

	return cmd
}

func addGroupMember(ctx context.Context, app *appctx.App, groupName, userName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// Find user sys_id
	userSysID, err := findUserSysID(ctx, app, userName)
	if err != nil {
		return err
	}

	// Check if membership already exists
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s^user=%s", groupSysID, userSysID))
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	existing, err := app.SDK.List(ctx, "sys_user_grmember", params)
	if err != nil {
		return fmt.Errorf("failed to check existing membership: %w", err)
	}
	if len(existing) > 0 {
		return fmt.Errorf("user %s is already a member of group %s", userName, groupName)
	}

	// Create the membership record
	recordData := map[string]any{
		"group": groupSysID,
		"user":  userSysID,
	}

	record, err := app.SDK.Create(ctx, "sys_user_grmember", recordData)
	if err != nil {
		return fmt.Errorf("failed to add user to group: %w", err)
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Added %s to %s", userName, groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn groupmembers list --group \"%s\"", groupName),
				Description: "List group members",
			},
			output.Breadcrumb{
				Action:      "remove",
				Cmd:         fmt.Sprintf("jsn groupmembers remove --group \"%s\" --user \"%s\"", groupName, userName),
				Description: "Remove this member",
			},
		),
	)
}

func removeGroupMember(ctx context.Context, app *appctx.App, groupName, userName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// Find user sys_id
	userSysID, err := findUserSysID(ctx, app, userName)
	if err != nil {
		return err
	}

	// Find the membership record
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s^user=%s", groupSysID, userSysID))
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_user_grmember", params)
	if err != nil {
		return fmt.Errorf("failed to find membership: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("user %s is not a member of group %s", userName, groupName)
	}

	membershipSysID := getDisplayValue(records[0], "sys_id")

	// Delete the membership record
	if err := app.SDK.Delete(ctx, "sys_user_grmember", membershipSysID); err != nil {
		return fmt.Errorf("failed to remove user from group: %w", err)
	}

	return app.OK(map[string]string{
		"user":  userName,
		"group": groupName,
	},
		output.WithSummary(fmt.Sprintf("Removed %s from %s", userName, groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn groupmembers list --group \"%s\"", groupName),
				Description: "List group members",
			},
			output.Breadcrumb{
				Action:      "add",
				Cmd:         fmt.Sprintf("jsn groupmembers add --group \"%s\" --user \"%s\"", groupName, userName),
				Description: "Add user back to group",
			},
		),
	)
}

func listGroupMembers(ctx context.Context, app *appctx.App, groupName string) error {
	// Find group sys_id
	groupSysID, err := findGroupSysID(ctx, app, groupName)
	if err != nil {
		return err
	}

	// List members
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("group=%s", groupSysID))
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "user")
	params.Set("sysparm_limit", "100")

	records, err := app.SDK.List(ctx, "sys_user_grmember", params)
	if err != nil {
		return fmt.Errorf("failed to list group members: %w", err)
	}

	var members []map[string]string
	for _, record := range records {
		if userField, ok := record["user"].(map[string]any); ok {
			displayName := ""
			userName := ""
			if dv, ok := userField["display_value"].(string); ok {
				displayName = dv
			}
			if val, ok := userField["value"].(string); ok {
				// Get username from sys_id
				userName = getUserNameFromSysID(ctx, app, val)
			}
			members = append(members, map[string]string{
				"name":     displayName,
				"username": userName,
			})
		}
	}

	return app.OK(map[string]any{
		"group":   groupName,
		"count":   len(members),
		"members": members,
	},
		output.WithSummary(fmt.Sprintf("%d member(s) in %s", len(members), groupName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "add",
				Cmd:         fmt.Sprintf("jsn groupmembers add --group \"%s\" --user \"<username>\"", groupName),
				Description: "Add a member to this group",
			},
			output.Breadcrumb{
				Action:      "group",
				Cmd:         fmt.Sprintf("jsn groups show \"%s\"", groupName),
				Description: "View group details",
			},
		),
	)
}

// findGroupSysID finds a group by name and returns its sys_id
func findGroupSysID(ctx context.Context, app *appctx.App, groupName string) (string, error) {
	params := url.Values{}
	params.Set("sysparm_query", "name="+groupName)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_user_group", params)
	if err != nil {
		return "", fmt.Errorf("failed to find group: %w", err)
	}
	if len(records) == 0 {
		return "", fmt.Errorf("group not found: %s", groupName)
	}

	return getDisplayValue(records[0], "sys_id"), nil
}

// findUserSysID finds a user by username and returns their sys_id
func findUserSysID(ctx context.Context, app *appctx.App, userName string) (string, error) {
	params := url.Values{}
	params.Set("sysparm_query", "user_name="+userName)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil {
		return "", fmt.Errorf("failed to find user: %w", err)
	}
	if len(records) == 0 {
		return "", fmt.Errorf("user not found: %s", userName)
	}

	return getDisplayValue(records[0], "sys_id"), nil
}

// getUserNameFromSysID looks up a username from sys_id
func getUserNameFromSysID(ctx context.Context, app *appctx.App, sysID string) string {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "user_name")

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil || len(records) == 0 {
		return ""
	}

	return getDisplayValue(records[0], "user_name")
}
