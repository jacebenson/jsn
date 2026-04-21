package commands

import (
	"context"
	"fmt"

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
	)

	return cmd
}

// newWorkspaceCreateCmd creates the workspace create command.
func newWorkspaceCreateCmd() *cobra.Command {
	var flags workspaceCreateFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new workspace (sys_ux_app_config)",
		Long: `Create a new Configurable Workspace by creating a sys_ux_app_config record.

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

	data := map[string]interface{}{
		"name":   flags.name,
		"active": flags.active,
	}
	if flags.description != "" {
		data["description"] = flags.description
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_ux_app_config", data)
	if err != nil {
		return fmt.Errorf("failed to create workspace: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id":      sysID,
		"name":        getString(record, "name"),
		"description": getString(record, "description"),
		"active":      getString(record, "active"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created workspace '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_ux_app_config %s", sysID), Description: "View workspace"},
			output.Breadcrumb{Action: "add-page", Cmd: fmt.Sprintf("jsn workspace add-page --workspace %s --name home", sysID), Description: "Add a page"},
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
