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

// userDefaultColumns are the default columns to show for users
var userDefaultColumns = []string{"user_name", "name", "email", "active"}

// NewUsersCmd creates the users command group.
func NewUsersCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "users",
		Aliases: []string{"user"},
		Short:   "Manage ServiceNow users",
		Long: `Manage ServiceNow users.

Examples:
  # Show this help
  jsn users

  # List users
  jsn users list

  # List users by name or username
  jsn users list --query "nameLIKEJohn Doe^ORuser_nameLIKEJohn Doe"

  # List with a filter
  jsn users list --query "active=true"`,
	}

	cmd.AddCommand(
		newUsersListCmd(),
		newUsersShowCmd(),
		newUsersCreateCmd(),
		newUsersUpdateCmd(),
		newUsersDeleteCmd(),
	)

	return cmd
}

func newUsersListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List users",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = userDefaultColumns
			}

			return listUsers(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newUsersShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [username]",
		Short: "Show a specific user by username",
		Long: `Display detailed information about a user by their unique username.

Examples:
  # Show user by username
  jsn users show admin

  # Show user by full name (will search)
  jsn users show "John Smith"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			username := args[0]

			// Try exact match on user_name first
			params := url.Values{}
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_display_value", "all")
			params.Set("sysparm_query", "user_name="+username)

			records, err := app.SDK.List(ctx, "sys_user", params)
			if err != nil {
				return fmt.Errorf("failed to find user: %w", err)
			}

			// If not found by user_name, try searching by name
			if len(records) == 0 {
				params.Set("sysparm_query", "name="+username)
				records, err = app.SDK.List(ctx, "sys_user", params)
				if err != nil {
					return fmt.Errorf("failed to find user: %w", err)
				}
			}

			if len(records) == 0 {
				return fmt.Errorf("user not found: %s", username)
			}

			// Add context for formatted display
			record := records[0]
			record["_context"] = map[string]any{
				"instance_url": app.Config.GetEffectiveInstance(),
				"table":        "sys_user",
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("User %s", username)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn users list",
						Description: "Back to all users",
					},
				),
			)
		},
	}
}

func listUsers(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = userDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listUsersInteractive(ctx, app, query)
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

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil {
		return fmt.Errorf("failed to list users: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, FormatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_user",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d user(s)", len(records))),
	)
}

func newUsersCreateCmd() *cobra.Command {
	var (
		userName string
		name     string
		email    string
		data     string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new user",
		Long: `Create a new user in ServiceNow.

Examples:
  # Create a basic user
  jsn users create --username "john.doe" --name "John Doe"

  # Create with email
  jsn users create --username "jane.doe" --name "Jane Doe" --email "jane@example.com"

  # Create with custom data
  jsn users create --data '{"user_name": "bob.smith", "first_name": "Bob", "last_name": "Smith"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			recordData := make(map[string]any)

			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON data: %w", err)
				}
			}

			if userName != "" {
				recordData["user_name"] = userName
			}
			if name != "" {
				recordData["name"] = name
			}
			if email != "" {
				recordData["email"] = email
			}

			if recordData["user_name"] == nil || recordData["user_name"] == "" {
				return fmt.Errorf("username is required (use --username or --data)")
			}

			record, err := app.SDK.Create(cmd.Context(), "sys_user", recordData)
			if err != nil {
				return fmt.Errorf("failed to create user: %w", err)
			}

			return app.OK(record,
				output.WithSummary(fmt.Sprintf("Created user %s", getDisplayValue(record, "user_name"))),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn users show %s", getDisplayValue(record, "user_name")),
						Description: "View the new user",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&userName, "username", "u", "", "Username (required if not in --data)")
	cmd.Flags().StringVarP(&name, "name", "n", "", "Full name")
	cmd.Flags().StringVarP(&email, "email", "e", "", "Email address")
	cmd.Flags().StringVar(&data, "data", "", "JSON data for additional fields")

	return cmd
}

func newUsersUpdateCmd() *cobra.Command {
	var data string

	cmd := &cobra.Command{
		Use:   "update [username]",
		Short: "Update a user",
		Long: `Update an existing user by username.

Examples:
  # Update user email
  jsn users update "john.doe" --data '{"email": "newemail@example.com"}'

  # Update user manager
  jsn users update "john.doe" --data '{"manager": "jane.doe"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			username := args[0]

			if data == "" {
				return fmt.Errorf("--data is required")
			}

			var recordData map[string]any
			if err := json.Unmarshal([]byte(data), &recordData); err != nil {
				return fmt.Errorf("invalid JSON data: %w", err)
			}

			// Find user by username
			params := url.Values{}
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_display_value", "all")
			params.Set("sysparm_fields", "sys_id")
			params.Set("sysparm_query", "user_name="+username)

			records, err := app.SDK.List(cmd.Context(), "sys_user", params)
			if err != nil {
				return fmt.Errorf("failed to find user: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("user not found: %s", username)
			}

			sysID := getDisplayValue(records[0], "sys_id")

			updated, err := app.SDK.Update(cmd.Context(), "sys_user", sysID, recordData)
			if err != nil {
				return fmt.Errorf("failed to update user: %w", err)
			}

			return app.OK(updated,
				output.WithSummary(fmt.Sprintf("Updated user %s", username)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn users show %s", username),
						Description: "View the updated user",
					},
				),
			)
		},
	}

	cmd.Flags().StringVar(&data, "data", "", "JSON data to update (required)")
	_ = cmd.MarkFlagRequired("data")

	return cmd
}

func newUsersDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete [username]",
		Short: "Delete a user",
		Long:  "Delete a user by their unique username.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			username := args[0]

			// Find user by username
			params := url.Values{}
			params.Set("sysparm_limit", "1")
			params.Set("sysparm_display_value", "all")
			params.Set("sysparm_fields", "sys_id")
			params.Set("sysparm_query", "user_name="+username)

			records, err := app.SDK.List(cmd.Context(), "sys_user", params)
			if err != nil {
				return fmt.Errorf("failed to find user: %w", err)
			}

			if len(records) == 0 {
				return fmt.Errorf("user not found: %s", username)
			}

			sysID := getDisplayValue(records[0], "sys_id")

			if err := app.SDK.Delete(cmd.Context(), "sys_user", sysID); err != nil {
				return fmt.Errorf("failed to delete user: %w", err)
			}

			return app.OK(map[string]string{
				"username": username,
				"message":  "User deleted",
			}, output.WithSummary(fmt.Sprintf("Deleted user %s", username)))
		},
	}
}

// listUsersInteractive shows an interactive picker for users
func listUsersInteractive(ctx context.Context, app *appctx.App, baseQuery string) error {
	// Create a reusable list fetcher configured for users
	fetcher := tui.NewListFetcher("sys_user").
		WithColumns("user_name", "name", "email", "active").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			userName := getStringField(record, "user_name")
			name := getStringField(record, "name")
			email := getStringField(record, "email")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			// Format title: ICON USERNAME - NAME (EMAIL)
			activeIcon := getActiveIcon(active)

			title := fmt.Sprintf("%s %s", activeIcon, userName)
			if name != "" {
				title += fmt.Sprintf(" - %s", name)
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

	// If user selected a user, show its details
	if selected != nil {
		// Extract username from the title
		// Title format: ICON USERNAME - NAME (EMAIL)
		parts := strings.SplitN(selected.Title, " ", 3)
		if len(parts) >= 2 {
			// parts[0] is icon, parts[1] is username
			return showUserByUsername(ctx, app, parts[1])
		}
		// Fallback: try to get by sys_id
		return getUserBySysID(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}

// getActiveIcon returns an icon for the active status
func getActiveIcon(active string) string {
	switch strings.ToLower(active) {
	case "true", "yes", "1":
		return "🟢"
	case "false", "no", "0":
		return "🔴"
	default:
		return "⚪"
	}
}

// getUserBySysID retrieves a user by their sys_id
func getUserBySysID(ctx context.Context, app *appctx.App, sysID string) error {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+sysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", strings.Join(userDefaultColumns, ","))

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil {
		return fmt.Errorf("failed to get user: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("user not found: %s", sysID)
	}

	// Add context for formatted display
	record := records[0]
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_user",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("User %s", getDisplayValue(record, "user_name"))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn users list",
				Description: "Back to all users",
			},
		),
	)
}

// showUserByUsername retrieves a user by their username (used after picker selection)
func showUserByUsername(ctx context.Context, app *appctx.App, username string) error {
	params := url.Values{}
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "user_name="+username)

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil {
		return fmt.Errorf("failed to find user: %w", err)
	}

	// If not found by user_name, try searching by name
	if len(records) == 0 {
		params.Set("sysparm_query", "name="+username)
		records, err = app.SDK.List(ctx, "sys_user", params)
		if err != nil {
			return fmt.Errorf("failed to find user: %w", err)
		}
	}

	if len(records) == 0 {
		return fmt.Errorf("user not found: %s", username)
	}

	// Add context for formatted display
	record := records[0]
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_user",
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("User %s", username)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn users list",
				Description: "Back to all users",
			},
		),
	)
}
