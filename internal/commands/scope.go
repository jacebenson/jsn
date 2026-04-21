package commands

import (
	"context"
	"fmt"
	"strings"
	"unicode"

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
		newScopeCreateCmd(),
	)

	return cmd
}

// scopeCreateFlags holds the flags for the scope create command.
type scopeCreateFlags struct {
	name        string
	scope       string
	description string
	version     string
	setCurrent  bool
	global      bool
}

// newScopeCreateCmd creates the scope create command.
func newScopeCreateCmd() *cobra.Command {
	var flags scopeCreateFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new scoped application",
		Long: `Create a new ServiceNow scoped application.

When --scope is omitted, the prefix is auto-generated from the instance's
glide.appcreator.company.code property and the application name.

Examples:
  jsn scope create --name "My App"
  jsn scope create --name "My App" --scope x_1234_myapp
  jsn scope create --name "My App" --global`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScopeCreate(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Application name (required)")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Application scope prefix (auto-generated if omitted)")
	cmd.Flags().StringVar(&flags.scope, "prefix", "", "Alias for --scope")
	cmd.Flags().StringVar(&flags.description, "description", "", "Application description")
	cmd.Flags().StringVar(&flags.version, "version", "1.0.0", "Application version")
	cmd.Flags().BoolVar(&flags.setCurrent, "set-current", true, "Set as current scope after creation")
	cmd.Flags().BoolVar(&flags.global, "global", false, "Create as a global application")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runScopeCreate executes the scope create command.
func runScopeCreate(cmd *cobra.Command, flags scopeCreateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	scope := flags.scope
	if scope == "" {
		if flags.global {
			scope = "global"
		} else {
			vendorCode, err := sdkClient.GetProperty(cmd.Context(), "glide.appcreator.company.code")
			if err != nil {
				return fmt.Errorf("cannot auto-generate scope: failed to fetch glide.appcreator.company.code: %w. Provide --scope explicitly", err)
			}
			scope = generateScopePrefix(flags.name, vendorCode)
		}
	}

	// Create the application
	app, err := sdkClient.CreateApplication(cmd.Context(), sdk.CreateApplicationOptions{
		Name:        flags.name,
		Scope:       scope,
		Description: flags.description,
		Version:     flags.version,
	})
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}

	// Set as current if requested
	if flags.setCurrent {
		currentUser, userErr := sdkClient.GetCurrentUser(cmd.Context())
		if userErr == nil && currentUser != nil {
			_ = sdkClient.SetCurrentApplication(cmd.Context(), currentUser.SysID, app.SysID)
		}
	}

	result := map[string]any{
		"sys_id":      app.SysID,
		"name":        app.Name,
		"scope":       app.Scope,
		"description": app.Description,
	}

	var breadcrumbs []output.Breadcrumb
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "use",
		Cmd:         fmt.Sprintf("jsn scope use %s", app.Scope),
		Description: "Switch to this scope",
	})
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn scope list",
		Description: "List all scopes",
	})

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created application '%s' (%s)", app.Name, app.Scope)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// generateScopePrefix builds a scope prefix like x_1234_mynapp_0.
// It sanitizes the name, truncates to fit ServiceNow limits, and appends _0.
func generateScopePrefix(name, vendorCode string) string {
	// Sanitize: lowercase, replace non-alphanumerics with underscores, collapse runs
	var b strings.Builder
	prevUnderscore := false
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevUnderscore = false
		} else if !prevUnderscore {
			b.WriteRune('_')
			prevUnderscore = true
		}
	}
	sanitized := strings.Trim(b.String(), "_")

	// Truncate the name portion so the full scope stays under ~20 chars.
	// Format: x_<vendor>_<name>_0
	// Vendor is typically 3-5 chars. Reserve 2 (x_) + 1 (_) + 2 (_0) = 5 fixed,
	// plus vendor len + 1 separator = ~6-8. That leaves ~10-12 for the name.
	maxName := 10
	if len(sanitized) > maxName {
		sanitized = sanitized[:maxName]
	}
	// Trim trailing underscores after truncation
	sanitized = strings.TrimRight(sanitized, "_")

	return fmt.Sprintf("x_%s_%s_0", vendorCode, sanitized)
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
		fetcher := func(ctx context.Context, offset, limit int, searchQuery string) (*tui.PageResult, error) {
			q := ""
			if searchQuery != "" {
				q = "nameLIKE" + searchQuery
			}
			opts := &sdk.ListApplicationsOptions{
				Limit:  limit,
				Offset: offset,
				Query:  q,
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
		selected, err := tui.PickWithQueryablePagination("Select application scope:", fetcher,
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
