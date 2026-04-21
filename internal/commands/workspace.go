package commands

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// workspaceCreateFlags holds the flags for the workspace create command.
type workspaceCreateFlags struct {
	name        string
	description string
	active      bool
	homeType    string
}

// workspaceAddFlags holds shared flags for workspace add-* commands.
type workspaceAddFlags struct {
	workspace   string
	name        string
	description string
	active      bool
	macroponent string
}

// NewWorkspaceCmd creates the workspace command group.
func NewWorkspaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Manage Configurable Workspaces",
		Long:  "Create and manage ServiceNow Configurable Workspace artifacts.",
	}

	cmd.AddCommand(
		newWorkspaceCreateCmd(),
		newWorkspaceAddPageCmd(),
		newWorkspaceAddScreenCmd(),
		newWorkspaceAddMacroponentCmd(),
		newWorkspaceAddListCmd(),
		newWorkspaceAddDashboardCmd(),
	)

	return cmd
}

// newWorkspaceCreateCmd creates the workspace create command.
func newWorkspaceCreateCmd() *cobra.Command {
	var flags workspaceCreateFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new workspace (sys_ux_app_config)",
		Long: `Create a new Configurable Workspace with all required artifacts.

This command creates:
  - sys_ux_app_config (workspace configuration)
  - sys_ux_page_registry (URL route and app shell)
  - sys_ux_registry_m2m_category (registers in Workspaces menu)
  - sys_ux_screen_type (Home screen collection)
  - sys_ux_screen (Default Home screen)
  - sys_ux_app_route (maps /home to the Home screen)
  - sys_ux_page_property (×5) — chrome_header, chrome_footer, chrome_toolbar, chrome_tab, wbApplicabilityConfigId
  - sys_ux_applicability (audience for menu visibility)
  - Custom sys_ux_macroponent extending Page Template with a Heading component

After creation, open the workspace from the Workspaces menu in the
Unified Navigator, or visit: /now/<path>/home

Examples:
  jsn workspace create --name "My Workspace"
  jsn workspace create --name "My Workspace" --description "Agent experience for my app"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceCreate(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Workspace name (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Workspace description")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")
	cmd.Flags().StringVar(&flags.homeType, "home-type", "heading", "Home page type: heading, dashboard, or list")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceCreate executes the workspace create command.
func runWorkspaceCreate(cmd *cobra.Command, flags workspaceCreateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)
	ctx := cmd.Context()

	// ─── Step 1: Create workspace config ────────────────────────────────
	appConfigData := map[string]interface{}{
		"name":   flags.name,
		"active": flags.active,
	}
	if flags.description != "" {
		appConfigData["description"] = flags.description
	}

	appConfig, err := sdkClient.CreateRecord(ctx, "sys_ux_app_config", appConfigData)
	if err != nil {
		return fmt.Errorf("failed to create workspace config: %w", err)
	}
	workspaceSysID := getString(appConfig, "sys_id")

	// ─── Step 2: Look up default workspace references ───────────────────
	appShellSysID, err := lookupRecordSysID(ctx, sdkClient, "sys_ux_macroponent", "name=Workspace App Shell")
	if err != nil {
		return fmt.Errorf("failed to find Workspace App Shell: %w", err)
	}

	parentAppSysID, err := lookupRecordSysID(ctx, sdkClient, "sys_ux_app", "name=Unified Navigation app shell")
	if err != nil {
		return fmt.Errorf("failed to find Unified Navigation app shell: %w", err)
	}

	workspaceCategorySysID, err := lookupRecordSysID(ctx, sdkClient, "sys_ux_experience_category", "name=Workspace")
	if err != nil {
		return fmt.Errorf("failed to find Workspace experience category: %w", err)
	}

	// ─── Step 3: Create page registry (URL route) ──────────────────────
	path := slugify(flags.name)
	registryData := map[string]interface{}{
		"title":             flags.name,
		"path":              path,
		"active":            flags.active,
		"admin_panel":       workspaceSysID,
		"admin_panel_table": "sys_ux_app_config",
		"parent_app":        parentAppSysID,
		"root_macroponent":  appShellSysID,
	}

	registry, err := sdkClient.CreateRecord(ctx, "sys_ux_page_registry", registryData)
	if err != nil {
		return fmt.Errorf("failed to create page registry: %w", err)
	}
	registrySysID := getString(registry, "sys_id")

	// ─── Step 4: Register in Workspaces menu ───────────────────────────
	_, err = sdkClient.CreateRecord(ctx, "sys_ux_registry_m2m_category", map[string]interface{}{
		"page_registry":       registrySysID,
		"experience_category": workspaceCategorySysID,
		"order":               100,
	})
	if err != nil {
		return fmt.Errorf("failed to register workspace in menu: %w", err)
	}

	// ─── Step 5: Create Home screen type ───────────────────────────────
	screenType, err := sdkClient.CreateRecord(ctx, "sys_ux_screen_type", map[string]interface{}{
		"name": "Home",
	})
	if err != nil {
		return fmt.Errorf("failed to create screen type: %w", err)
	}
	screenTypeSysID := getString(screenType, "sys_id")

	// ─── Step 6: Create custom Home macroponent ────────────────────────
	// The screen needs a custom macroponent extending Page Template
	pageTemplateSysID, err := lookupRecordSysID(ctx, sdkClient, "sys_ux_macroponent", "name=Page Template")
	if err != nil {
		return fmt.Errorf("failed to find Page Template: %w", err)
	}

	// Create the home macroponent based on the selected home type
	var customMacroponentSysID string
	switch flags.homeType {
	case "dashboard":
		customMacroponentSysID, err = createHomeDashboardMacroponent(ctx, sdkClient, flags.name, pageTemplateSysID)
	case "list":
		customMacroponentSysID, err = createHomeListMacroponent(ctx, sdkClient, flags.name, pageTemplateSysID)
	default: // "heading" or any other value defaults to heading
		customMacroponentSysID, err = createHomeHeadingMacroponent(ctx, sdkClient, flags.name, pageTemplateSysID)
	}
	if err != nil {
		return fmt.Errorf("failed to create home macroponent: %w", err)
	}

	macroponentConfig := `{
		"bare": {"type": "JSON_LITERAL", "value": true},
		"headerLevel": {"type": "JSON_LITERAL", "value": "1"},
		"headingOnlyVisibleToScreenReaders": {"type": "JSON_LITERAL", "value": false},
		"interceptNotifications": {"type": "JSON_LITERAL", "value": false},
		"label": {"type": "TRANSLATION_LITERAL", "value": {"code": null, "comment": "", "message": ""}},
		"propagateNotifications": {"type": "JSON_LITERAL", "value": false},
		"scrollable": {"type": "JSON_LITERAL", "value": "y"},
		"sysId": {"type": "JSON_LITERAL", "value": ""}
	}`

	_, err = sdkClient.CreateRecord(ctx, "sys_ux_screen", map[string]interface{}{
		"name":               "Home default",
		"app_config":         workspaceSysID,
		"screen_type":        screenTypeSysID,
		"parent_macroponent": appShellSysID,
		"macroponent":        customMacroponentSysID,
		"macroponent_config": macroponentConfig,
		"active":             true,
		"order":              0,
	})
	if err != nil {
		return fmt.Errorf("failed to create default screen: %w", err)
	}

	// Add additional pages based on home type
	switch flags.homeType {
	case "dashboard":
		_, err = createDashboardPage(ctx, sdkClient, workspaceSysID, appShellSysID, screenTypeSysID, flags.name)
		if err != nil {
			// Non-fatal: just log the error
			fmt.Fprintf(cmd.ErrOrStderr(), "Warning: failed to create dashboard page: %v\n", err)
		}
	case "list":
		_, err = createListPage(ctx, sdkClient, workspaceSysID, appShellSysID, screenTypeSysID, flags.name)
		if err != nil {
			// Non-fatal: just log the error
			fmt.Fprintf(cmd.ErrOrStderr(), "Warning: failed to create list page: %v\n", err)
		}
	}

	// ─── Step 7: Create home route ─────────────────────────────────────
	_, err = sdkClient.CreateRecord(ctx, "sys_ux_app_route", map[string]interface{}{
		"name":               "Home",
		"route_type":         "home",
		"app_config":         workspaceSysID,
		"screen_type":        screenTypeSysID,
		"parent_macroponent": appShellSysID,
		"order":              0,
	})
	if err != nil {
		return fmt.Errorf("failed to create home route: %w", err)
	}

	// ─── Step 8: Create page properties ────────────────────────────────
	scopeSysID := getString(appConfig, "sys_scope")
	if scopeSysID == "" {
		// sys_scope may be a reference object
		if ref, ok := appConfig["sys_scope"].(map[string]interface{}); ok {
			scopeSysID = getString(ref, "value")
		}
	}
	scopePrefix, err := getScopePrefix(ctx, sdkClient, scopeSysID)
	if err != nil {
		return fmt.Errorf("failed to get scope prefix: %w", err)
	}

	pageProps := []struct {
		name  string
		typ   string
		value string
	}{
		{
			name:  "chrome_header",
			typ:   "json",
			value: `{"privatePage":{"userPrefsEnabled":false,"searchEnabled":false,"currentScreenLinkConfiguration":{},"globalTools":{"collapsingMenuId":0,"primaryItems":[],"secondaryItems":[]},"notificationsEnabled":false},"publicPage":{"searchEnabled":false,"logoRoute":{},"actionButtons":[]}}`,
		},
		{
			name:  "chrome_footer",
			typ:   "json",
			value: `{"public_page":{"enable_footer_topbar":false,"footer_topbar_options":{},"enable_footer_bar":false,"footer_bar_options":{}}}`,
		},
		{
			name:  "chrome_toolbar",
			typ:   "json",
			value: `[{"id":"home","label":{"translatable":true,"message":"Home"},"icon":"home-fill","routeInfo":{"route":"home"},"group":"top","order":100,"badge":{},"presence":{},"availability":{},"viewportInfo":{}}]`,
		},
		{
			name:  "chrome_tab",
			typ:   "json",
			value: `{"contextual":["record"],"newTabMenu":[],"maxMainTabLimit":10,"maxTotalSubTabLimit":30}`,
		},
	}

	for _, prop := range pageProps {
		_, err = sdkClient.CreateRecord(ctx, "sys_ux_page_property", map[string]interface{}{
			"name":        prop.name,
			"suffix":      prop.name,
			"page":        registrySysID,
			"type":        prop.typ,
			"value":       prop.value,
			"unique_name": fmt.Sprintf("%s.%s.root.global.%s", scopePrefix, registrySysID, prop.name),
		})
		if err != nil {
			return fmt.Errorf("failed to create page property %s: %w", prop.name, err)
		}
	}

	// ─── Step 9: Create applicability for menu visibility ──────────────
	applicability, err := sdkClient.CreateRecord(ctx, "sys_ux_applicability", map[string]interface{}{
		"name": fmt.Sprintf("Audience for app %s", path),
	})
	if err != nil {
		return fmt.Errorf("failed to create applicability: %w", err)
	}
	applicabilitySysID := getString(applicability, "sys_id")

	_, err = sdkClient.CreateRecord(ctx, "sys_ux_page_property", map[string]interface{}{
		"name":        "wbApplicabilityConfigId",
		"page":        registrySysID,
		"type":        "string",
		"value":       applicabilitySysID,
		"unique_name": fmt.Sprintf("%s.%s.root.global.wbApplicabilityConfigId", scopePrefix, registrySysID),
	})
	if err != nil {
		return fmt.Errorf("failed to create applicability page property: %w", err)
	}

	result := map[string]any{
		"sys_id":      workspaceSysID,
		"name":        flags.name,
		"description": flags.description,
		"path":        path,
		"url":         fmt.Sprintf("/now/%s/home", path),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created workspace '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_app_config %s", workspaceSysID), Description: "View workspace config"},
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_page_registry %s", registrySysID), Description: "View page registry"},
			output.Breadcrumb{Action: "add-page", Cmd: fmt.Sprintf("jsn workspace add-page --workspace %s --name home", workspaceSysID), Description: "Add a page"},
			output.Breadcrumb{Action: "add-screen", Cmd: fmt.Sprintf("jsn workspace add-screen --workspace %s --name list", workspaceSysID), Description: "Add a screen"},
		),
	)
}

// newWorkspaceAddPageCmd creates the workspace add-page command.
func newWorkspaceAddPageCmd() *cobra.Command {
	var flags workspaceAddFlags

	cmd := &cobra.Command{
		Use:   "add-page",
		Short: "Add a page to a workspace (sys_ux_page)",
		Long: `Create a new page within a Configurable Workspace.

sys_ux_page uses 'title' instead of 'name' and does not reference app_config directly.

Examples:
  jsn workspace add-page --workspace <sys_id> --name "home"
  jsn workspace add-page --workspace "My Workspace" --name "dashboard"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceAddPage(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.workspace, "workspace", "", "Workspace sys_id or name (stored for context)")
	cmd.Flags().StringVar(&flags.name, "name", "", "Page title (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Page description")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceAddPage executes the add-page command.
func runWorkspaceAddPage(cmd *cobra.Command, flags workspaceAddFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	data := map[string]interface{}{
		"title": flags.name,
	}
	if flags.description != "" {
		data["description"] = flags.description
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_ux_page", data)
	if err != nil {
		return fmt.Errorf("failed to create page: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id": sysID,
		"title":  getString(record, "title"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created page '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_page %s", sysID), Description: "View page"},
			output.Breadcrumb{Action: "list", Cmd: "jsn records --table sys_ux_page", Description: "List all pages"},
		),
	)
}

// newWorkspaceAddScreenCmd creates the workspace add-screen command.
func newWorkspaceAddScreenCmd() *cobra.Command {
	var flags workspaceAddFlags

	cmd := &cobra.Command{
		Use:   "add-screen",
		Short: "Add a screen to a workspace (sys_ux_screen)",
		Long: `Create a new screen within a Configurable Workspace.

Examples:
  jsn workspace add-screen --workspace <sys_id> --name "home"
  jsn workspace add-screen --workspace <sys_id> --name "list" --macroponent <macroponent_sys_id>`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceAddScreen(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.workspace, "workspace", "", "Workspace sys_id or name (required)")
	cmd.Flags().StringVar(&flags.name, "name", "", "Screen name (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Screen description")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")
	cmd.Flags().StringVar(&flags.macroponent, "macroponent", "", "Macroponent sys_id to associate with this screen")

	_ = cmd.MarkFlagRequired("workspace")
	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceAddScreen executes the add-screen command.
func runWorkspaceAddScreen(cmd *cobra.Command, flags workspaceAddFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve workspace reference to sys_id
	workspaceSysID, err := resolveWorkspace(cmd.Context(), sdkClient, flags.workspace)
	if err != nil {
		return err
	}

	data := map[string]interface{}{
		"name":       flags.name,
		"app_config": workspaceSysID,
		"active":     flags.active,
	}
	if flags.description != "" {
		data["description"] = flags.description
	}
	if flags.macroponent != "" {
		data["macroponent"] = flags.macroponent
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_ux_screen", data)
	if err != nil {
		return fmt.Errorf("failed to create screen: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id":     sysID,
		"name":       getString(record, "name"),
		"app_config": workspaceSysID,
		"active":     getString(record, "active"),
	}
	if flags.macroponent != "" {
		result["macroponent"] = flags.macroponent
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created screen '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_screen %s", sysID), Description: "View screen"},
			output.Breadcrumb{Action: "list", Cmd: "jsn records --table sys_ux_screen", Description: "List all screens"},
		),
	)
}

// newWorkspaceAddMacroponentCmd creates the workspace add-macroponent command.
func newWorkspaceAddMacroponentCmd() *cobra.Command {
	var flags workspaceAddFlags

	cmd := &cobra.Command{
		Use:   "add-macroponent",
		Short: "Add a macroponent to a workspace (sys_ux_macroponent)",
		Long: `Create a new macroponent within a Configurable Workspace.

sys_ux_macroponent does not reference app_config directly.

Examples:
  jsn workspace add-macroponent --name "My Component"
  jsn workspace add-macroponent --name "list"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceAddMacroponent(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.workspace, "workspace", "", "Workspace sys_id or name (stored for context)")
	cmd.Flags().StringVar(&flags.name, "name", "", "Macroponent name (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Macroponent description")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceAddMacroponent executes the add-macroponent command.
func runWorkspaceAddMacroponent(cmd *cobra.Command, flags workspaceAddFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	data := map[string]interface{}{
		"name":   flags.name,
		"active": flags.active,
	}
	if flags.description != "" {
		data["description"] = flags.description
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_ux_macroponent", data)
	if err != nil {
		return fmt.Errorf("failed to create macroponent: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id": sysID,
		"name":   getString(record, "name"),
		"active": getString(record, "active"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created macroponent '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_macroponent %s", sysID), Description: "View macroponent"},
			output.Breadcrumb{Action: "list", Cmd: "jsn records --table sys_ux_macroponent", Description: "List all macroponents"},
		),
	)
}

// workspaceAddListFlags holds flags for add-list command.
type workspaceAddListFlags struct {
	workspace   string
	name        string
	table       string
	description string
	active      bool
}

// newWorkspaceAddListCmd creates the workspace add-list command.
func newWorkspaceAddListCmd() *cobra.Command {
	var flags workspaceAddListFlags

	cmd := &cobra.Command{
		Use:   "add-list",
		Short: "Add a list page to a workspace",
		Long: `Create a list page (sys_ux_list) for browsing table records within a workspace.

This command creates:
  - sys_ux_list configuration for the specified table
  - Associated menu configuration for navigation

Examples:
  jsn workspace add-list --workspace <sys_id> --table incident --name "Incidents"
  jsn workspace add-list --workspace "My Workspace" --table problem --name "Problems"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceAddList(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.workspace, "workspace", "", "Workspace sys_id or name (required)")
	cmd.Flags().StringVar(&flags.name, "name", "", "List page name (required)")
	cmd.Flags().StringVar(&flags.table, "table", "task", "Table to display in the list")
	cmd.Flags().StringVar(&flags.description, "description", "", "List page description")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")

	_ = cmd.MarkFlagRequired("workspace")
	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceAddList executes the add-list command.
func runWorkspaceAddList(cmd *cobra.Command, flags workspaceAddListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve workspace reference to sys_id
	workspaceSysID, err := resolveWorkspace(cmd.Context(), sdkClient, flags.workspace)
	if err != nil {
		return err
	}

	// Create the list configuration
	listConfig, err := sdkClient.CreateRecord(cmd.Context(), "sys_ux_list", map[string]interface{}{
		"name":        flags.name,
		"table":       flags.table,
		"active":      flags.active,
		"description": flags.description,
	})
	if err != nil {
		return fmt.Errorf("failed to create list config: %w", err)
	}
	listConfigSysID := getString(listConfig, "sys_id")

	// Create menu configuration for the list
	_, err = sdkClient.CreateRecord(cmd.Context(), "sys_ux_list_menu_config", map[string]interface{}{
		"list":   listConfigSysID,
		"active": flags.active,
	})
	if err != nil {
		// Non-fatal - the list is created even if menu config fails
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: failed to create menu config: %v\n", err)
	}

	result := map[string]any{
		"sys_id":    listConfigSysID,
		"name":      getString(listConfig, "name"),
		"table":     flags.table,
		"workspace": workspaceSysID,
		"active":    getString(listConfig, "active"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created list page '%s' for table '%s'", flags.name, flags.table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_list %s", listConfigSysID), Description: "View list configuration"},
			output.Breadcrumb{Action: "list", Cmd: "jsn records --table sys_ux_list", Description: "List all list configs"},
		),
	)
}

// workspaceAddDashboardFlags holds flags for add-dashboard command.
type workspaceAddDashboardFlags struct {
	workspace   string
	name        string
	description string
	isDefault   bool
	active      bool
}

// newWorkspaceAddDashboardCmd creates the workspace add-dashboard command.
func newWorkspaceAddDashboardCmd() *cobra.Command {
	var flags workspaceAddDashboardFlags

	cmd := &cobra.Command{
		Use:   "add-dashboard",
		Short: "Add a dashboard page to a workspace",
		Long: `Create a dashboard (par_dashboard) within a workspace.

This command creates:
  - par_dashboard configuration
  - Optional dashboard canvas and widgets

Examples:
  jsn workspace add-dashboard --workspace <sys_id> --name "Overview"
  jsn workspace add-dashboard --workspace "My Workspace" --name "Analytics" --default`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceAddDashboard(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.workspace, "workspace", "", "Workspace sys_id or name (required)")
	cmd.Flags().StringVar(&flags.name, "name", "", "Dashboard name (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Dashboard description")
	cmd.Flags().BoolVar(&flags.isDefault, "default", false, "Set as default dashboard for the workspace")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")

	_ = cmd.MarkFlagRequired("workspace")
	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runWorkspaceAddDashboard executes the add-dashboard command.
func runWorkspaceAddDashboard(cmd *cobra.Command, flags workspaceAddDashboardFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve workspace reference to sys_id
	workspaceSysID, err := resolveWorkspace(cmd.Context(), sdkClient, flags.workspace)
	if err != nil {
		return err
	}

	// Create the dashboard
	dashboard, err := sdkClient.CreateRecord(cmd.Context(), "par_dashboard", map[string]interface{}{
		"name":        flags.name,
		"description": flags.description,
		"is_default":  flags.isDefault,
		"active":      flags.active,
	})
	if err != nil {
		return fmt.Errorf("failed to create dashboard: %w", err)
	}
	dashboardSysID := getString(dashboard, "sys_id")

	// Create a dashboard canvas
	canvas, err := sdkClient.CreateRecord(cmd.Context(), "par_dashboard_canvas", map[string]interface{}{
		"dashboard": dashboardSysID,
		"name":      flags.name + " Canvas",
		"active":    flags.active,
	})
	if err != nil {
		// Non-fatal - the dashboard is created even if canvas creation fails
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: failed to create dashboard canvas: %v\n", err)
	} else {
		// Create a placeholder widget on the canvas
		canvasSysID := getString(canvas, "sys_id")
		_, err = sdkClient.CreateRecord(cmd.Context(), "par_dashboard_widget", map[string]interface{}{
			"canvas":      canvasSysID,
			"name":        "Welcome Widget",
			"widget_type": "text",
			"position":    `{"x":0,"y":0,"w":4,"h":2}`,
		})
		if err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "Warning: failed to create dashboard widget: %v\n", err)
		}
	}

	result := map[string]any{
		"sys_id":     dashboardSysID,
		"name":       getString(dashboard, "name"),
		"is_default": flags.isDefault,
		"workspace":  workspaceSysID,
		"active":     getString(dashboard, "active"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created dashboard '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table par_dashboard %s", dashboardSysID), Description: "View dashboard"},
			output.Breadcrumb{Action: "list", Cmd: "jsn records --table par_dashboard", Description: "List all dashboards"},
		),
	)
}

// resolveWorkspace resolves a workspace identifier (sys_id or name) to a sys_id.
func resolveWorkspace(ctx context.Context, sdkClient *sdk.Client, identifier string) (string, error) {
	if len(identifier) == 32 {
		return identifier, nil
	}

	query := fmt.Sprintf("name=%s", identifier)
	records, err := sdkClient.ListRecords(ctx, "sys_ux_app_config", &sdk.ListRecordsOptions{
		Limit:  1,
		Query:  query,
		Fields: []string{"sys_id", "name"},
	})
	if err != nil {
		return "", fmt.Errorf("failed to resolve workspace: %w", err)
	}
	if len(records) == 0 {
		return "", fmt.Errorf("workspace not found: %s", identifier)
	}
	return getString(records[0], "sys_id"), nil
}

// lookupRecordSysID finds the first record in a table matching a query and returns its sys_id.
func lookupRecordSysID(ctx context.Context, c *sdk.Client, table, query string) (string, error) {
	records, err := c.ListRecords(ctx, table, &sdk.ListRecordsOptions{
		Limit:  1,
		Query:  query,
		Fields: []string{"sys_id"},
	})
	if err != nil {
		return "", err
	}
	if len(records) == 0 {
		return "", fmt.Errorf("no record found in %s matching: %s", table, query)
	}
	return getString(records[0], "sys_id"), nil
}

// getScopePrefix returns the application scope prefix for a given scope sys_id.
func getScopePrefix(ctx context.Context, c *sdk.Client, scopeSysID string) (string, error) {
	records, err := c.ListRecords(ctx, "sys_scope", &sdk.ListRecordsOptions{
		Limit:  1,
		Query:  fmt.Sprintf("sys_id=%s", scopeSysID),
		Fields: []string{"scope"},
	})
	if err != nil {
		return "", err
	}
	if len(records) == 0 {
		return "", fmt.Errorf("no scope found")
	}
	return getString(records[0], "scope"), nil
}

// slugify converts a name to a URL-friendly path segment.
func slugify(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteRune('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// createHomeHeadingMacroponent creates a home page with a heading component.
func createHomeHeadingMacroponent(ctx context.Context, c *sdk.Client, name, pageTemplateSysID string) (string, error) {
	headingComponentSysID, err := lookupRecordSysID(ctx, c, "sys_ux_macroponent", "name=Heading")
	if err != nil {
		return "", fmt.Errorf("failed to find Heading component: %w", err)
	}

	composition := fmt.Sprintf(`[{
		"definition": {"id": "%s", "type": "MACROPONENT"},
		"elementId": "heading_1",
		"elementLabel": "Heading 1",
		"propertyValues": {
			"label": {"type": "JSON_LITERAL", "value": "Welcome to %s"},
			"variant": {"type": "JSON_LITERAL", "value": "header-primary"},
			"level": {"type": "JSON_LITERAL", "value": "1"}
		},
		"slot": null,
		"styles": null
	}]`, headingComponentSysID, name)

	macroponent, err := c.CreateRecord(ctx, "sys_ux_macroponent", map[string]interface{}{
		"name":                    "Home",
		"extends":                 pageTemplateSysID,
		"category":                "page",
		"schema_version":          "1.0.0",
		"layout":                  `{"default":{"children":null,"isInline":null,"items":[{"element_id":"heading_1","styles":{}}],"root":null,"rules":null,"styles":{"flex-direction":"column","height":"100%"},"templateId":"5832fd4d53c31010e6bcddeeff7b12db","type":"flex"},"version":"3.0.0"}`,
		"composition":             composition,
		"data":                    "[]",
		"props":                   "[{\"description\":null,\"fieldType\":\"string\",\"label\":\"sysId\",\"mandatory\":false,\"name\":\"sysId\",\"readOnly\":true,\"selectable\":false,\"typeMetadata\":null,\"valueType\":\"string\"}]",
		"internal_event_mappings": "{}",
	})
	if err != nil {
		return "", err
	}

	return getString(macroponent, "sys_id"), nil
}

// createHomeDashboardMacroponent creates a home page with an embedded dashboard.
func createHomeDashboardMacroponent(ctx context.Context, c *sdk.Client, name, pageTemplateSysID string) (string, error) {
	// Create the dashboard first
	dashboard, err := c.CreateRecord(ctx, "par_dashboard", map[string]interface{}{
		"name":        name + " Home Dashboard",
		"description": "Dashboard for " + name + " workspace",
		"is_default":  false,
		"is_template": false,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create dashboard: %w", err)
	}
	dashboardSysID := getString(dashboard, "sys_id")

	// Create a simple macroponent with dashboard reference
	macroponent, err := c.CreateRecord(ctx, "sys_ux_macroponent", map[string]interface{}{
		"name":                    "Home",
		"extends":                 pageTemplateSysID,
		"category":                "page",
		"schema_version":          "1.0.0",
		"layout":                  `{"default":{"children":null,"isInline":null,"items":[],"root":null,"rules":null,"styles":{"flex-direction":"column","height":"100%"},"templateId":"5832fd4d53c31010e6bcddeeff7b12db","type":"flex"},"version":"3.0.0"}`,
		"composition":             "[]",
		"data":                    fmt.Sprintf(`[{"elementId":"dashboard_1","elementType":"dashboard","elementProps":{"dashboardId":"%s"}}]`, dashboardSysID),
		"props":                   "[{\"description\":null,\"fieldType\":\"string\",\"label\":\"sysId\",\"mandatory\":false,\"name\":\"sysId\",\"readOnly\":true,\"selectable\":false,\"typeMetadata\":null,\"valueType\":\"string\"}]",
		"internal_event_mappings": "{}",
	})
	if err != nil {
		return "", err
	}

	return getString(macroponent, "sys_id"), nil
}

// createHomeListMacroponent creates a home page with a list component.
func createHomeListMacroponent(ctx context.Context, c *sdk.Client, name, pageTemplateSysID string) (string, error) {
	// Create the list configuration
	listConfig, err := c.CreateRecord(ctx, "sys_ux_list", map[string]interface{}{
		"name":   name + " List",
		"table":  "task", // Default to task, user can customize
		"active": true,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create list config: %w", err)
	}
	listConfigSysID := getString(listConfig, "sys_id")

	// Create a macroponent with list reference
	macroponent, err := c.CreateRecord(ctx, "sys_ux_macroponent", map[string]interface{}{
		"name":                    "Home",
		"extends":                 pageTemplateSysID,
		"category":                "page",
		"schema_version":          "1.0.0",
		"layout":                  `{"default":{"children":null,"isInline":null,"items":[],"root":null,"rules":null,"styles":{"flex-direction":"column","height":"100%"},"templateId":"5832fd4d53c31010e6bcddeeff7b12db","type":"flex"},"version":"3.0.0"}`,
		"composition":             "[]",
		"data":                    fmt.Sprintf(`[{"elementId":"list_1","elementType":"list","elementProps":{"listId":"%s"}}]`, listConfigSysID),
		"props":                   "[{\"description\":null,\"fieldType\":\"string\",\"label\":\"sysId\",\"mandatory\":false,\"name\":\"sysId\",\"readOnly\":true,\"selectable\":false,\"typeMetadata\":null,\"valueType\":\"string\"}]",
		"internal_event_mappings": "{}",
	})
	if err != nil {
		return "", err
	}

	return getString(macroponent, "sys_id"), nil
}

// createDashboardPage adds a dedicated dashboard page to a workspace.
func createDashboardPage(ctx context.Context, c *sdk.Client, workspaceSysID, appShellSysID, screenTypeSysID, name string) (string, error) {
	// Create the dashboard
	dashboard, err := c.CreateRecord(ctx, "par_dashboard", map[string]interface{}{
		"name":        name + " Dashboard",
		"description": "Dashboard page for " + name + " workspace",
		"is_default":  false,
		"is_template": false,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create dashboard: %w", err)
	}

	return getString(dashboard, "sys_id"), nil
}

// createListPage adds a dedicated list page to a workspace.
func createListPage(ctx context.Context, c *sdk.Client, workspaceSysID, appShellSysID, screenTypeSysID, name string) (string, error) {
	// Create the list configuration
	listConfig, err := c.CreateRecord(ctx, "sys_ux_list", map[string]interface{}{
		"name":   name + " List Page",
		"table":  "task",
		"active": true,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create list config: %w", err)
	}

	return getString(listConfig, "sys_id"), nil
}
