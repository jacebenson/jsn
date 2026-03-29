package commands

import (
	"context"
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// scopeListFlags holds the flags for the scope list command.
type scopeListFlags struct {
	limit int
	all   bool
}

// NewScopeCmd creates the scope command group.
func NewScopeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scope",
		Short: "Manage application scopes",
		Long:  "View and switch between ServiceNow application scopes.",
	}

	cmd.AddCommand(
		newScopeShowCmd(),
		newScopeListCmd(),
		newScopeUseCmd(),
	)

	return cmd
}

// newScopeShowCmd creates the scope show command.
func newScopeShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Show current application scope",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScopeShow(cmd)
		},
	}
}

// runScopeShow executes the scope show command.
func runScopeShow(cmd *cobra.Command) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	currentApp, err := sdkClient.GetCurrentApplication(cmd.Context(), currentUser.SysID)
	if err != nil {
		return fmt.Errorf("failed to get current application: %w", err)
	}

	if currentApp == nil {
		return outputWriter.OK(map[string]string{
			"scope": "global",
			"note":  "No current application scope set",
		}, output.WithSummary("Current Application Scope"))
	}

	result := map[string]string{
		"name":   currentApp.Name,
		"scope":  currentApp.Scope,
		"sys_id": currentApp.SysID,
	}
	if currentApp.Description != "" {
		result["description"] = currentApp.Description
	}

	return outputWriter.OK(result, output.WithSummary("Current Application Scope"))
}

// newScopeListCmd creates the scope list command.
func newScopeListCmd() *cobra.Command {
	var flags scopeListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List application scopes",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScopeList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of scopes to fetch")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all scopes (no limit)")

	return cmd
}

// runScopeList executes the scope list command.
func runScopeList(cmd *cobra.Command, flags scopeListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get current scope for marking
	var currentAppID string
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err == nil && currentUser != nil {
		currentApp, _ := sdkClient.GetCurrentApplication(cmd.Context(), currentUser.SysID)
		if currentApp != nil {
			currentAppID = currentApp.SysID
		}
	}

	// Set limit (0 means no limit)
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	apps, err := sdkClient.ListApplications(cmd.Context(), limit)
	if err != nil {
		return fmt.Errorf("failed to list applications: %w", err)
	}

	// Get total count for display
	totalCount, countErr := sdkClient.CountRecords(cmd.Context(), "sys_scope", &sdk.CountRecordsOptions{})
	if countErr != nil {
		totalCount = len(apps)
	}

	// Build result with current marker
	var result []map[string]string
	for _, app := range apps {
		name := app.Name
		if app.SysID == currentAppID {
			name = "* " + name
		}
		result = append(result, map[string]string{
			"name":        name,
			"scope":       app.Scope,
			"sys_id":      app.SysID,
			"description": app.Description,
		})
	}

	// Build summary with count info
	summary := fmt.Sprintf("Application Scopes (%d)", len(apps))
	if !flags.all && len(apps) < totalCount {
		summary = fmt.Sprintf("Application Scopes (showing %d of %d)", len(apps), totalCount)
	}

	return outputWriter.OK(result, output.WithSummary(summary))
}

// newScopeUseCmd creates the scope use command.
func newScopeUseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use [<name>]",
		Short: "Switch to an application scope",
		Long:  "Switch to a different application scope. If no name is provided, an interactive selection will be shown.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) >= 1 {
				name = args[0]
			}
			return runScopeUse(cmd, name)
		},
	}
}

// runScopeUse executes the scope use command.
func runScopeUse(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get current user first
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Get current scope for marking
	var currentAppID string
	currentApp, _ := sdkClient.GetCurrentApplication(cmd.Context(), currentUser.SysID)
	if currentApp != nil {
		currentAppID = currentApp.SysID
	}

	// Interactive selection if no name provided
	if name == "" {
		// Create paginated fetcher for applications
		fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
			opts := &sdk.ListApplicationsOptions{
				Limit:  limit,
				Offset: offset,
			}
			apps, err := sdkClient.ListApplicationsWithOptions(ctx, opts)
			if err != nil {
				return nil, err
			}

			var items []tui.PickerItem
			for _, app := range apps {
				desc := app.Scope
				if desc == "" {
					desc = app.SysID[:8]
				}
				// Mark current scope with asterisk in title
				title := app.Name
				if app.SysID == currentAppID {
					title = "* " + app.Name
				}
				items = append(items, tui.PickerItem{
					ID:          app.SysID,
					Title:       title,
					Description: desc,
				})
			}

			hasMore := len(apps) >= limit
			return &tui.PageResult{
				Items:   items,
				HasMore: hasMore,
			}, nil
		}

		// Show picker with pagination
		selected, err := tui.PickWithPagination("Select application scope:", fetcher,
			tui.WithMaxVisible(15),
		)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		name = selected.Title
	}

	// Get the application
	app, err := sdkClient.GetApplication(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to find application: %w", err)
	}

	// Set as current application
	err = sdkClient.SetCurrentApplication(cmd.Context(), currentUser.SysID, app.SysID)
	if err != nil {
		return fmt.Errorf("failed to set current application: %w", err)
	}

	// Build result
	result := map[string]string{
		"name":   app.Name,
		"scope":  app.Scope,
		"sys_id": app.SysID,
		"status": "Now set as current application scope",
	}

	// Styled output for terminal
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		brandColor := lipgloss.Color("#e8a217")
		successStyle := lipgloss.NewStyle().Bold(true).Foreground(brandColor)
		mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), successStyle.Render("✓ Switched application scope"))
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  Name:  %s\n", app.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "  Scope: %s\n", mutedStyle.Render(app.Scope))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	return outputWriter.OK(result, output.WithSummary("Application Scope"))
}
