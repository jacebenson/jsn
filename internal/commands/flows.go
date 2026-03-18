package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// flowsListFlags holds the flags for the flows list command.
type flowsListFlags struct {
	limit       int
	active      bool
	query       string
	order       string
	desc        bool
	all         bool
	interactive bool
}

// NewFlowsCmd creates the flows command group.
func NewFlowsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "flows",
		Short: "Manage Flow Designer flows",
		Long:  "List and inspect ServiceNow Flow Designer flows.",
	}

	cmd.AddCommand(
		newFlowsListCmd(),
		newFlowsShowCmd(),
		newFlowsExecutionsCmd(),
		newFlowsDebugCmd(),
		newFlowsVariablesCmd(),
		newFlowsActivateCmd(),
		newFlowsDeactivateCmd(),
		newFlowsCreateCmd(),
		newFlowsDeleteCmd(),
		newFlowsUpdateCmd(),
		newFlowsActionsCmd(),
		newFlowsTriggersCmd(),
		newFlowsPublishCmd(),
		newFlowsExecuteCmd(),
	)

	return cmd
}

// newFlowsListCmd creates the flows list command.
func newFlowsListCmd() *cobra.Command {
	var flags flowsListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List flows",
		Long: `List Flow Designer flows from sys_hub_flow.

Examples:
  jsn flows list
  jsn flows list --active
  jsn flows list --query "nameLIKEapproval" --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of flows to fetch")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active flows")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all flows (no limit)")
	cmd.Flags().BoolVarP(&flags.interactive, "interactive", "i", false, "Interactive mode - select a flow to view details")

	return cmd
}

// runFlowsList executes the flows list command.
func runFlowsList(cmd *cobra.Command, flags flowsListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build query
	var queryParts []string
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_hub_flow"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListFlowsOptions{
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	flows, err := sdkClient.ListFlows(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list flows: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a flow to view
	if flags.interactive && isTerminal {
		selectedFlow, err := pickFlowFromList(flows)
		if err != nil {
			return err
		}
		if selectedFlow == "" {
			return fmt.Errorf("no flow selected")
		}
		// Show the selected flow
		return runFlowsShow(cmd, selectedFlow)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowsList(cmd, flows, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowsList(cmd, flows)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, flow := range flows {
		row := map[string]any{
			"sys_id":         flow.SysID,
			"name":           flow.Name,
			"active":         flow.Active,
			"scope":          flow.Scope,
			"sys_scope":      flow.SysScope,
			"version":        flow.Version,
			"run_as":         flow.RunAs,
			"sys_updated_on": flow.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d flows", len(flows))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn flows show <name>",
				Description: "Show flow details",
			},
		),
	)
}

// flowsExecuteFlags holds the flags for the flows execute command.
type flowsExecuteFlags struct {
	inputs map[string]string
}

// newFlowsExecuteCmd creates the flows execute command.
func newFlowsExecuteCmd() *cobra.Command {
	var flags flowsExecuteFlags

	cmd := &cobra.Command{
		Use:   "execute [<flow_name_or_id>]",
		Short: "Execute/test a flow",
		Long: `Manually execute a flow to test it.

If no flow name or sys_id is provided, an interactive picker will help you select one.
Use --input to provide flow input variables.

Examples:
  jsn flows execute "My Flow"
  jsn flows execute "My Flow" --input table=incident --input sys_id=12345`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var identifier string
			if len(args) > 0 {
				identifier = args[0]
			}
			return runFlowsExecute(cmd, identifier, flags)
		},
	}

	cmd.Flags().StringToStringVar(&flags.inputs, "input", nil, "Flow input variables (key=value pairs)")

	return cmd
}

// runFlowsExecute executes the flows execute command.
func runFlowsExecute(cmd *cobra.Command, identifier string, flags flowsExecuteFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no identifier provided
	if identifier == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name or sys_id is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to execute:")
		if err != nil {
			return err
		}
		identifier = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), identifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Convert inputs map to interface map
	inputs := make(map[string]interface{})
	for k, v := range flags.inputs {
		inputs[k] = v
	}

	// Execute the flow
	execInput := sdk.ExecuteFlowInput{
		Inputs: inputs,
	}

	execution, err := sdkClient.ExecuteFlow(cmd.Context(), flow.SysID, execInput)
	if err != nil {
		return fmt.Errorf("failed to execute flow: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id":    execution.SysID,
		"flow_id":   flow.SysID,
		"flow_name": flow.Name,
		"status":    execution.Status,
		"started":   execution.Started,
	},
		output.WithSummary(fmt.Sprintf("Executed flow '%s'", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "executions",
				Cmd:         fmt.Sprintf("jsn flows executions %s", flow.SysID),
				Description: "View execution history",
			},
		),
	)
}

// printStyledFlowsList outputs styled flows list.
func printStyledFlowsList(cmd *cobra.Command, flows []sdk.Flow, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Flows"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
		headerStyle.Render("Name"),
		headerStyle.Render("Status"),
		headerStyle.Render("Scope"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Flows
	for _, flow := range flows {
		status := "Active"
		statusStyle := activeStyle
		if !flow.Active {
			status = "Inactive"
			statusStyle = inactiveStyle
		}

		scope := flow.Scope
		if scope == "" {
			scope = flow.SysScope
		}
		if scope == "" {
			scope = "global"
		}

		name := flow.Name
		if len(name) > 38 {
			name = name[:35] + "..."
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
				nameWithLink,
				statusStyle.Render(status),
				mutedStyle.Render(scope),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
				name,
				statusStyle.Render(status),
				mutedStyle.Render(scope),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn flows show <name>",
		mutedStyle.Render("Show flow details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlowsList outputs markdown flows list.
func printMarkdownFlowsList(cmd *cobra.Command, flows []sdk.Flow) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Flows**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Name | Status | Scope |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|--------|-------|")

	for _, flow := range flows {
		status := "Active"
		if !flow.Active {
			status = "Inactive"
		}
		scope := flow.Scope
		if scope == "" {
			scope = flow.SysScope
		}
		if scope == "" {
			scope = "global"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s |\n", flow.Name, status, scope)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newFlowsShowCmd creates the flows show command.
func newFlowsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [<name>]",
		Short: "Show flow details",
		Long: `Display detailed information about a flow.

If no name is provided, an interactive picker will help you select one.

Examples:
  jsn flows show "Approval Flow"
  jsn flows show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsShow(cmd, name)
		},
	}
}

// runFlowsShow executes the flows show command.
func runFlowsShow(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow:")
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlow(cmd, flow, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlow(cmd, flow, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         flow.SysID,
		"name":           flow.Name,
		"active":         flow.Active,
		"description":    flow.Description,
		"scope":          flow.Scope,
		"sys_scope":      flow.SysScope,
		"version":        flow.Version,
		"run_as":         flow.RunAs,
		"run_as_user":    flow.RunAsUser,
		"sys_created_on": flow.CreatedOn,
		"sys_updated_on": flow.UpdatedOn,
		"sys_created_by": flow.CreatedBy,
		"sys_updated_by": flow.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Flow: %s", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn flows list",
				Description: "List all flows",
			},
		),
	)
}

// printStyledFlow outputs styled flow details.
func printStyledFlow(cmd *cobra.Command, flow *sdk.Flow, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(flow.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !flow.Active {
		status = "Inactive"
	}

	scope := flow.Scope
	if scope == "" {
		scope = flow.SysScope
	}
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(flow.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Scope:"), valueStyle.Render(scope))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Version:"), valueStyle.Render(flow.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Run As:"), valueStyle.Render(flow.RunAs))
	if flow.RunAsUser != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Run As User:"), valueStyle.Render(flow.RunAsUser))
	}

	if flow.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(flow.Description))
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", flow.CreatedOn, flow.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", flow.UpdatedOn, flow.UpdatedBy)))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			mutedStyle.Render("Link:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn flows list",
		mutedStyle.Render("List all flows"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlow outputs markdown flow details.
func printMarkdownFlow(cmd *cobra.Command, flow *sdk.Flow, instanceURL string) error {
	status := "Active"
	if !flow.Active {
		status = "Inactive"
	}

	scope := flow.Scope
	if scope == "" {
		scope = flow.SysScope
	}
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", flow.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", flow.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", scope)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Version:** %s\n", flow.Version)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Run As:** %s\n", flow.RunAs)
	if flow.RunAsUser != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Run As User:** %s\n", flow.RunAsUser)
	}
	if flow.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", flow.Description)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Created:** %s by %s\n", flow.CreatedOn, flow.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", flow.UpdatedOn, flow.UpdatedBy)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// pickFlow shows an interactive flow picker and returns the selected flow name.
func pickFlow(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListFlowsOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		flows, err := sdkClient.ListFlows(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, f := range flows {
			status := "Active"
			if !f.Active {
				status = "Inactive"
			}
			items = append(items, tui.PickerItem{
				ID:          f.Name,
				Title:       f.Name,
				Description: status,
			})
		}

		hasMore := len(flows) >= limit
		return &tui.PageResult{
			Items:   items,
			HasMore: hasMore,
		}, nil
	}

	selected, err := tui.PickWithPagination(title, fetcher, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", fmt.Errorf("selection cancelled")
	}

	return selected.ID, nil
}

// pickFlowFromList shows a picker from an already-fetched list of flows.
func pickFlowFromList(flows []sdk.Flow) (string, error) {
	var items []tui.PickerItem
	for _, f := range flows {
		status := "Active"
		if !f.Active {
			status = "Inactive"
		}
		scope := f.Scope
		if scope == "" {
			scope = f.SysScope
		}
		if scope == "" {
			scope = "global"
		}
		items = append(items, tui.PickerItem{
			ID:          f.Name,
			Title:       f.Name,
			Description: fmt.Sprintf("%s - %s", status, scope),
		})
	}

	selected, err := tui.Pick("Select a flow to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}

// newFlowsExecutionsCmd creates the flows executions command.
func newFlowsExecutionsCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "executions [<flow_name>]",
		Short: "Show flow execution history",
		Long: `Display execution history for a Flow Designer flow.

If no flow name is provided, an interactive picker will help you select one.

Examples:
  jsn flows executions "My Flow"
  jsn flows executions --limit 50
  jsn flows executions  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsExecutions(cmd, name, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "Maximum number of executions to show")

	return cmd
}

// runFlowsExecutions executes the flows executions command.
func runFlowsExecutions(cmd *cobra.Command, name string, limit int) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to view executions:")
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow to get its sys_id
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	opts := &sdk.ListFlowExecutionsOptions{
		FlowID:    flow.SysID,
		Limit:     limit,
		OrderBy:   "sys_created_on",
		OrderDesc: true,
	}

	executions, err := sdkClient.ListFlowExecutions(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list flow executions: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowExecutions(cmd, executions, flow.Name)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowExecutions(cmd, executions, flow.Name)
	}

	// Build data for JSON
	var data []map[string]any
	for _, exec := range executions {
		data = append(data, map[string]any{
			"sys_id":         exec.SysID,
			"flow_id":        exec.FlowID,
			"flow_name":      exec.FlowName,
			"status":         exec.Status,
			"started":        exec.Started,
			"ended":          exec.Ended,
			"duration":       exec.Duration,
			"sys_updated_on": exec.SysUpdatedOn,
		})
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d executions for flow '%s'", len(executions), flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", name),
				Description: "Show flow details",
			},
		),
	)
}

// printStyledFlowExecutions outputs styled flow executions list.
func printStyledFlowExecutions(cmd *cobra.Command, executions []sdk.FlowExecution, flowName string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00"))
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#aa0000"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Flow Executions (%s)", flowName)))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(executions) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No executions found for this flow."))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %-12s %-20s %-10s %s\n",
		headerStyle.Render("Started"),
		headerStyle.Render("Duration"),
		headerStyle.Render("Status"),
		headerStyle.Render("Ended"),
		headerStyle.Render("Sys ID"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Executions
	for _, exec := range executions {
		statusStyle := mutedStyle
		switch exec.Status {
		case "success", "completed":
			statusStyle = successStyle
		case "error", "failed":
			statusStyle = errorStyle
		}

		started := exec.Started
		if started == "" {
			started = exec.SysUpdatedOn
		}
		if len(started) > 18 {
			started = started[:16]
		}

		duration := exec.Duration
		if duration == "" {
			duration = "-"
		}

		ended := exec.Ended
		if ended == "" {
			ended = "-"
		}
		if len(ended) > 10 {
			ended = ended[:10]
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %-12s %-20s %-10s %s\n",
			mutedStyle.Render(started),
			mutedStyle.Render(duration),
			statusStyle.Render(exec.Status),
			mutedStyle.Render(ended),
			mutedStyle.Render(exec.SysID),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlowExecutions outputs markdown flow executions list.
func printMarkdownFlowExecutions(cmd *cobra.Command, executions []sdk.FlowExecution, flowName string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Flow Executions (%s)**\n\n", flowName)

	if len(executions) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No executions found for this flow.")
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout(), "| Started | Duration | Status | Ended | Sys ID |")
	fmt.Fprintln(cmd.OutOrStdout(), "|---------|----------|--------|-------|--------|")

	for _, exec := range executions {
		started := exec.Started
		if started == "" {
			started = exec.SysUpdatedOn
		}
		duration := exec.Duration
		if duration == "" {
			duration = "-"
		}
		ended := exec.Ended
		if ended == "" {
			ended = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s |\n",
			started, duration, exec.Status, ended, exec.SysID)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newFlowsDebugCmd creates the flows debug command.
func newFlowsDebugCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "debug [<flow_name>]",
		Short: "Show flow with all actions and subflows",
		Long: `Display detailed flow information including all actions and subflows.

If no flow name is provided, an interactive picker will help you select one.

Examples:
  jsn flows debug "My Flow"
  jsn flows debug  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsDebug(cmd, name)
		},
	}
}

// runFlowsDebug executes the flows debug command.
func runFlowsDebug(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to debug:")
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Get comprehensive inspection
	inspection, err := sdkClient.InspectFlow(cmd.Context(), flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to inspect flow: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowInspection(cmd, inspection)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowInspection(cmd, inspection)
	}

	// Build comprehensive data for JSON
	data := map[string]any{
		"flow": map[string]any{
			"sys_id":  inspection.Flow.SysID,
			"name":    inspection.Flow.Name,
			"active":  inspection.Flow.Active,
			"version": inspection.Flow.Version,
		},
		"version_record":      inspection.Version,
		"components":          inspection.Components,
		"trigger_instances":   inspection.TriggerInstances,
		"timer_triggers":      inspection.TimerTriggers,
		"record_triggers":     inspection.RecordTriggers,
		"action_instances":    inspection.ActionInstances,
		"action_instances_v2": inspection.ActionInstancesV2,
		"step_instances":      inspection.StepInstances,
		"flow_inputs":         inspection.FlowInputs,
		"flow_data_vars":      inspection.FlowDataVars,
		"trigger_definitions": inspection.TriggerDefinitions,
	}

	totalActions := len(inspection.ActionInstances) + len(inspection.ActionInstancesV2)
	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Flow Inspection: %s (%d actions, %d components)",
			inspection.Flow.Name, totalActions, len(inspection.Components))),
	)
}

// printStyledFlowInspection outputs comprehensive styled flow inspection.
func printStyledFlowInspection(cmd *cobra.Command, inspection *sdk.FlowInspection) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00FFFF"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Flow Inspection: %s", inspection.Flow.Name)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic flow info
	fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(inspection.Flow.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Name:"), valueStyle.Render(inspection.Flow.Name))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Active:"), valueStyle.Render(fmt.Sprintf("%v", inspection.Flow.Active)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Version:"), valueStyle.Render(inspection.Flow.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Internal Name:"), valueStyle.Render(inspection.Flow.Name))

	// Version Record
	if len(inspection.Version) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("Version Record:"))
		if flow, ok := inspection.Version["flow"].(map[string]interface{}); ok {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-25s %s\n", mutedStyle.Render("Flow Link:"), valueStyle.Render(getString(flow, "value")))
		}
	}

	// Components
	if len(inspection.Components) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Flow Components (%d):", len(inspection.Components))))
		for _, comp := range inspection.Components {
			sysID := getString(comp, "sys_id")
			className := getString(comp, "sys_class_name")
			order := getString(comp, "order")
			displayText := getString(comp, "display_text")
			uiID := getString(comp, "ui_id")

			if displayText == "" {
				displayText = className
			}
			if displayText == "" {
				displayText = sysID[:8] + "..."
			}

			fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s (order: %s, ui: %s)\n",
				mutedStyle.Render(sysID[:8]),
				valueStyle.Render(displayText),
				mutedStyle.Render(order),
				mutedStyle.Render(uiID[:8]),
			)
		}
	}

	// Trigger Instances
	if len(inspection.TriggerInstances) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Trigger Instances (%d):", len(inspection.TriggerInstances))))
		for _, trigger := range inspection.TriggerInstances {
			name := getString(trigger, "name")
			triggerType := getString(trigger, "trigger_type")
			displayText := getString(trigger, "display_text")

			if name == "" {
				name = triggerType
			}
			if displayText == "" {
				displayText = name
			}

			fmt.Fprintf(cmd.OutOrStdout(), "  %s (%s)\n",
				valueStyle.Render(displayText),
				mutedStyle.Render(triggerType),
			)
		}
	}

	// Timer Triggers
	if len(inspection.TimerTriggers) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Timer Triggers (%d):", len(inspection.TimerTriggers))))
		for _, trigger := range inspection.TimerTriggers {
			timerType := getString(trigger, "timer_type")
			time := getString(trigger, "time")
			active := getString(trigger, "active")

			fmt.Fprintf(cmd.OutOrStdout(), "  %s (time: %s, active: %s)\n",
				valueStyle.Render(timerType),
				mutedStyle.Render(time),
				mutedStyle.Render(active),
			)
		}
	}

	// Action Instances
	totalActions := len(inspection.ActionInstances) + len(inspection.ActionInstancesV2)
	if totalActions > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Action Instances (%d):", totalActions)))

		for _, action := range inspection.ActionInstances {
			actionType := ""
			if at, ok := action["action_type"].(map[string]interface{}); ok {
				actionType = getString(at, "display_value")
			}
			if actionType == "" {
				actionType = getString(action, "action_type")
			}
			order := getString(action, "order")
			comment := getString(action, "comment")

			fmt.Fprintf(cmd.OutOrStdout(), "  [V1] Order %s: %s\n",
				mutedStyle.Render(order),
				valueStyle.Render(actionType),
			)
			if comment != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "       %s\n", mutedStyle.Render(comment))
			}
		}

		for _, action := range inspection.ActionInstancesV2 {
			actionType := ""
			if at, ok := action["action_type"].(map[string]interface{}); ok {
				actionType = getString(at, "display_value")
			}
			if actionType == "" {
				actionType = getString(action, "action_type")
			}
			order := getString(action, "order")

			fmt.Fprintf(cmd.OutOrStdout(), "  [V2] Order %s: %s\n",
				mutedStyle.Render(order),
				valueStyle.Render(actionType),
			)
		}
	}

	// Step Instances
	if len(inspection.StepInstances) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Step Instances (%d):", len(inspection.StepInstances))))
		for _, step := range inspection.StepInstances {
			label := getString(step, "label")
			order := getString(step, "order")

			if label != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  Order %s: %s\n",
					mutedStyle.Render(order),
					valueStyle.Render(label),
				)
			}
		}
	}

	// Trigger Definitions
	if len(inspection.TriggerDefinitions) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("Trigger Definitions (%d):", len(inspection.TriggerDefinitions))))
		for _, def := range inspection.TriggerDefinitions {
			name := getString(def, "name")
			defType := getString(def, "type")

			fmt.Fprintf(cmd.OutOrStdout(), "  %s (%s)\n",
				valueStyle.Render(name),
				mutedStyle.Render(defType),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlowInspection outputs comprehensive markdown flow inspection.
func printMarkdownFlowInspection(cmd *cobra.Command, inspection *sdk.FlowInspection) error {
	fmt.Fprintf(cmd.OutOrStdout(), "# Flow Inspection: %s\n\n", inspection.Flow.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "**Sys ID:** %s\n\n", inspection.Flow.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "**Active:** %v\n\n", inspection.Flow.Active)
	fmt.Fprintf(cmd.OutOrStdout(), "**Version:** %s\n\n", inspection.Flow.Version)

	// Components
	if len(inspection.Components) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Flow Components (%d)\n\n", len(inspection.Components))
		for _, comp := range inspection.Components {
			sysID := getString(comp, "sys_id")
			className := getString(comp, "sys_class_name")
			order := getString(comp, "order")

			fmt.Fprintf(cmd.OutOrStdout(), "- `%s` (%s) - Order: %s\n", sysID, className, order)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Actions
	totalActions := len(inspection.ActionInstances) + len(inspection.ActionInstancesV2)
	if totalActions > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Action Instances (%d)\n\n", totalActions)

		for _, action := range inspection.ActionInstances {
			actionType := getString(action, "action_type")
			order := getString(action, "order")
			comment := getString(action, "comment")

			fmt.Fprintf(cmd.OutOrStdout(), "- [V1] Order %s: %s\n", order, actionType)
			if comment != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  - Comment: %s\n", comment)
			}
		}

		for _, action := range inspection.ActionInstancesV2 {
			actionType := getString(action, "action_type")
			order := getString(action, "order")

			fmt.Fprintf(cmd.OutOrStdout(), "- [V2] Order %s: %s\n", order, actionType)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Triggers
	if len(inspection.TimerTriggers) > 0 || len(inspection.RecordTriggers) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Triggers\n\n")

		for _, trigger := range inspection.TimerTriggers {
			timerType := getString(trigger, "timer_type")
			fmt.Fprintf(cmd.OutOrStdout(), "- Timer: %s\n", timerType)
		}

		for _, trigger := range inspection.RecordTriggers {
			table := getString(trigger, "table")
			when := getString(trigger, "when")
			fmt.Fprintf(cmd.OutOrStdout(), "- Record: %s on %s\n", when, table)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// getString safely extracts a string value from a map.
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		switch val := v.(type) {
		case string:
			return val
		case map[string]interface{}:
			if dv, ok := val["display_value"].(string); ok {
				return dv
			}
			if v, ok := val["value"].(string); ok {
				return v
			}
		}
	}
	return ""
}

// newFlowsVariablesCmd creates the flows variables command.
func newFlowsVariablesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "variables [<flow_name>]",
		Short: "Show flow inputs/outputs/schema",
		Long: `Display flow input variables, output variables, and data schema.

If no flow name is provided, an interactive picker will help you select one.

Examples:
  jsn flows variables "My Flow"
  jsn flows variables  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsVariables(cmd, name)
		},
	}
}

// runFlowsVariables executes the flows variables command.
func runFlowsVariables(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to view variables:")
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Get flow variables
	variables, err := sdkClient.GetFlowVariables(cmd.Context(), flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to get flow variables: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowVariables(cmd, flow, variables)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowVariables(cmd, flow, variables)
	}

	// Build data for JSON
	varData := make([]map[string]any, len(variables))
	for i, v := range variables {
		varData[i] = map[string]any{
			"sys_id": v.SysID,
			"name":   v.Name,
			"type":   v.Type,
			"label":  v.Label,
			"value":  v.Value,
		}
	}

	data := map[string]any{
		"sys_id":    flow.SysID,
		"name":      flow.Name,
		"variables": varData,
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Flow Variables: %s (%d variables)", flow.Name, len(variables))),
	)
}

// printStyledFlowVariables outputs styled flow variables.
func printStyledFlowVariables(cmd *cobra.Command, flow *sdk.Flow, variables []sdk.FlowVariable) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Flow Variables: %s", flow.Name)))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(variables) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No variables defined for this flow."))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-30s %-20s %-30s %s\n",
		headerStyle.Render("Name"),
		headerStyle.Render("Type"),
		headerStyle.Render("Label"),
		headerStyle.Render("Value"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Variables
	for _, v := range variables {
		name := v.Name
		if len(name) > 28 {
			name = name[:25] + "..."
		}

		label := v.Label
		if len(label) > 28 {
			label = label[:25] + "..."
		}

		value := v.Value
		if value == "" {
			value = "-"
		}
		if len(value) > 20 {
			value = value[:17] + "..."
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-30s %-20s %-30s %s\n",
			valueStyle.Render(name),
			mutedStyle.Render(v.Type),
			mutedStyle.Render(label),
			mutedStyle.Render(value),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlowVariables outputs markdown flow variables.
func printMarkdownFlowVariables(cmd *cobra.Command, flow *sdk.Flow, variables []sdk.FlowVariable) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Flow Variables: %s**\n\n", flow.Name)

	if len(variables) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No variables defined for this flow.")
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout(), "| Name | Type | Label | Value |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|------|-------|-------|")

	for _, v := range variables {
		value := v.Value
		if value == "" {
			value = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n", v.Name, v.Type, v.Label, value)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newFlowsActivateCmd creates the flows activate command.
func newFlowsActivateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activate [<flow_name>]",
		Short: "Activate a flow",
		Long: `Activate a Flow Designer flow.

If no flow name is provided, an interactive picker will help you select one.

Examples:
  jsn flows activate "My Flow"
  jsn flows activate  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsActivate(cmd, name, true)
		},
	}
}

// newFlowsDeactivateCmd creates the flows deactivate command.
func newFlowsDeactivateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "deactivate [<flow_name>]",
		Short: "Deactivate a flow",
		Long: `Deactivate a Flow Designer flow.

If no flow name is provided, an interactive picker will help you select one.

Examples:
  jsn flows deactivate "My Flow"
  jsn flows deactivate  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runFlowsActivate(cmd, name, false)
		},
	}
}

// runFlowsActivate executes the activate/deactivate command.
func runFlowsActivate(cmd *cobra.Command, name string, activate bool) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, fmt.Sprintf("Select a flow to %s:", map[bool]string{true: "activate", false: "deactivate"}[activate]))
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Update the flow status
	if err := sdkClient.UpdateFlowStatus(cmd.Context(), flow.SysID, activate); err != nil {
		return fmt.Errorf("failed to %s flow: %w", map[bool]string{true: "activate", false: "deactivate"}[activate], err)
	}

	action := "activated"
	if !activate {
		action = "deactivated"
	}

	return outputWriter.OK(map[string]any{
		"sys_id": flow.SysID,
		"name":   flow.Name,
		"status": map[bool]string{true: "active", false: "inactive"}[activate],
	},
		output.WithSummary(fmt.Sprintf("Flow '%s' %s", flow.Name, action)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", name),
				Description: "Show flow details",
			},
		),
	)
}

// flowsCreateFlags holds the flags for the flows create command.
type flowsCreateFlags struct {
	name        string
	description string
	scope       string
	active      bool
	runAs       string
}

// newFlowsCreateCmd creates the flows create command.
func newFlowsCreateCmd() *cobra.Command {
	var flags flowsCreateFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new flow",
		Long: `Create a new Flow Designer flow.

Examples:
  jsn flows create --name "My Flow" --description "Test flow" --scope "x_myapp"
  jsn flows create --name "Simple Flow" --active`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsCreate(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Flow name (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Flow description")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Application scope (name or sys_id)")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Create as active")
	cmd.Flags().StringVar(&flags.runAs, "run-as", "", "Run as: system, user, or sys_id")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runFlowsCreate executes the flows create command.
func runFlowsCreate(cmd *cobra.Command, flags flowsCreateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	input := sdk.CreateFlowInput{
		Name:        flags.name,
		Description: flags.description,
		Scope:       flags.scope,
		Active:      flags.active,
		RunAs:       flags.runAs,
	}

	flow, err := sdkClient.CreateFlow(cmd.Context(), input)
	if err != nil {
		return fmt.Errorf("failed to create flow: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id": flow.SysID,
		"name":   flow.Name,
		"active": flow.Active,
	},
		output.WithSummary(fmt.Sprintf("Created flow '%s'", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", flow.SysID),
				Description: "Show flow details",
			},
			output.Breadcrumb{
				Action:      "activate",
				Cmd:         fmt.Sprintf("jsn flows activate %s", flow.SysID),
				Description: "Activate the flow",
			},
		),
	)
}

// flowsDeleteFlags holds the flags for the flows delete command.
type flowsDeleteFlags struct {
	cascade bool
}

// newFlowsDeleteCmd creates the flows delete command.
func newFlowsDeleteCmd() *cobra.Command {
	var flags flowsDeleteFlags

	cmd := &cobra.Command{
		Use:   "delete [<flow_name_or_id>]",
		Short: "Delete a flow",
		Long: `Delete a Flow Designer flow.

If no flow name or sys_id is provided, an interactive picker will help you select one.
Use --cascade to also delete related records (actions, variables).

Examples:
  jsn flows delete "My Flow"
  jsn flows delete 1234567890abcdef1234567890abcdef
  jsn flows delete "My Flow" --cascade`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var identifier string
			if len(args) > 0 {
				identifier = args[0]
			}
			return runFlowsDelete(cmd, identifier, flags)
		},
	}

	cmd.Flags().BoolVar(&flags.cascade, "cascade", false, "Also delete related records (actions, variables)")

	return cmd
}

// runFlowsDelete executes the flows delete command.
func runFlowsDelete(cmd *cobra.Command, identifier string, flags flowsDeleteFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no identifier provided
	if identifier == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name or sys_id is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to delete:")
		if err != nil {
			return err
		}
		identifier = selectedFlow
	}

	// Get the flow first to show what we're deleting
	flow, err := sdkClient.GetFlow(cmd.Context(), identifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Delete the flow
	if err := sdkClient.DeleteFlow(cmd.Context(), flow.SysID, flags.cascade); err != nil {
		return fmt.Errorf("failed to delete flow: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id":  flow.SysID,
		"name":    flow.Name,
		"cascade": flags.cascade,
	},
		output.WithSummary(fmt.Sprintf("Deleted flow '%s'", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn flows list",
				Description: "List remaining flows",
			},
		),
	)
}

// flowsUpdateFlags holds the flags for the flows update command.
type flowsUpdateFlags struct {
	name        string
	description string
	scope       string
	active      bool
	inactive    bool
	runAs       string
}

// newFlowsUpdateCmd creates the flows update command.
func newFlowsUpdateCmd() *cobra.Command {
	var flags flowsUpdateFlags

	cmd := &cobra.Command{
		Use:   "update [<flow_name_or_id>]",
		Short: "Update a flow",
		Long: `Update a Flow Designer flow's properties.

If no flow name or sys_id is provided, an interactive picker will help you select one.

Examples:
  jsn flows update "My Flow" --name "New Name"
  jsn flows update "My Flow" --description "Updated description"
  jsn flows update "My Flow" --active
  jsn flows update "My Flow" --run-as system`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var identifier string
			if len(args) > 0 {
				identifier = args[0]
			}
			return runFlowsUpdate(cmd, identifier, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "New flow name")
	cmd.Flags().StringVar(&flags.description, "description", "", "New description")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "New scope (name or sys_id)")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Activate the flow")
	cmd.Flags().BoolVar(&flags.inactive, "inactive", false, "Deactivate the flow")
	cmd.Flags().StringVar(&flags.runAs, "run-as", "", "Run as: system, user, or sys_id")

	cmd.MarkFlagsMutuallyExclusive("active", "inactive")

	return cmd
}

// runFlowsUpdate executes the flows update command.
func runFlowsUpdate(cmd *cobra.Command, identifier string, flags flowsUpdateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no identifier provided
	if identifier == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name or sys_id is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to update:")
		if err != nil {
			return err
		}
		identifier = selectedFlow
	}

	// Build updates map
	updates := make(map[string]interface{})

	if flags.name != "" {
		updates["name"] = flags.name
	}
	if flags.description != "" {
		updates["description"] = flags.description
	}
	if flags.scope != "" {
		updates["scope"] = flags.scope
	}
	if flags.active {
		updates["active"] = true
	}
	if flags.inactive {
		updates["active"] = false
	}
	if flags.runAs != "" {
		updates["run_as"] = flags.runAs
	}

	if len(updates) == 0 {
		return output.ErrUsage("no updates specified")
	}

	// Update the flow
	flow, err := sdkClient.UpdateFlow(cmd.Context(), identifier, updates)
	if err != nil {
		return fmt.Errorf("failed to update flow: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id": flow.SysID,
		"name":   flow.Name,
		"active": flow.Active,
	},
		output.WithSummary(fmt.Sprintf("Updated flow '%s'", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", flow.SysID),
				Description: "Show flow details",
			},
		),
	)
}

// newFlowsActionsCmd creates the flows actions command group.
func newFlowsActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "actions",
		Short: "Manage flow actions",
		Long:  "Add, list, and manage actions in Flow Designer flows.",
	}

	cmd.AddCommand(
		newFlowsActionsAddCmd(),
		newFlowsActionsListCmd(),
	)

	return cmd
}

// flowsActionsAddFlags holds the flags for the flows actions add command.
type flowsActionsAddFlags struct {
	actionType string
	name       string
	order      int
	inputs     map[string]string
}

// newFlowsActionsAddCmd creates the flows actions add command.
func newFlowsActionsAddCmd() *cobra.Command {
	var flags flowsActionsAddFlags

	cmd := &cobra.Command{
		Use:   "add <flow_name_or_id>",
		Short: "Add an action to a flow",
		Long: `Add an action to a Flow Designer flow.

Examples:
  jsn flows actions add "My Flow" --type "core.log" --name "Log Message" --order 100
  jsn flows actions add "My Flow" --type "core.createRecord" --name "Create Incident" --order 200 --input table=incident --input short_description="Test"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsAdd(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.actionType, "type", "", "Action type (required) - e.g., core.log, core.createRecord")
	cmd.Flags().StringVar(&flags.name, "name", "", "Action name (required)")
	cmd.Flags().IntVar(&flags.order, "order", 100, "Action order/priority")
	cmd.Flags().StringToStringVar(&flags.inputs, "input", nil, "Action inputs (key=value pairs)")

	_ = cmd.MarkFlagRequired("type")
	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runFlowsActionsAdd executes the flows actions add command.
func runFlowsActionsAdd(cmd *cobra.Command, flowIdentifier string, flags flowsActionsAddFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the flow to resolve name to sys_id
	flow, err := sdkClient.GetFlow(cmd.Context(), flowIdentifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Convert inputs map to interface map
	inputs := make(map[string]interface{})
	for k, v := range flags.inputs {
		inputs[k] = v
	}

	input := sdk.CreateFlowActionInput{
		Name:       flags.name,
		ActionType: flags.actionType,
		Order:      flags.order,
		Inputs:     inputs,
	}

	action, err := sdkClient.CreateFlowAction(cmd.Context(), flow.SysID, input)
	if err != nil {
		return fmt.Errorf("failed to add action: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id":      action.SysID,
		"name":        action.Name,
		"action_type": action.Action,
		"order":       action.Order,
		"flow_id":     flow.SysID,
	},
		output.WithSummary(fmt.Sprintf("Added action '%s' to flow '%s'", action.Name, flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "debug",
				Cmd:         fmt.Sprintf("jsn flows debug %s", flow.SysID),
				Description: "Show flow with actions",
			},
		),
	)
}

// newFlowsActionsListCmd creates the flows actions list command.
func newFlowsActionsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <flow_name_or_id>",
		Short: "List actions in a flow",
		Long: `List all actions in a Flow Designer flow.

Examples:
  jsn flows actions list "My Flow"
  jsn flows actions list 1234567890abcdef1234567890abcdef`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsList(cmd, args[0])
		},
	}
}

// runFlowsActionsList executes the flows actions list command.
func runFlowsActionsList(cmd *cobra.Command, flowIdentifier string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), flowIdentifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Get actions
	actions, err := sdkClient.GetFlowActions(cmd.Context(), flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to get flow actions: %w", err)
	}

	// Build data for output
	var data []map[string]any
	for _, action := range actions {
		data = append(data, map[string]any{
			"sys_id":      action.SysID,
			"name":        action.Name,
			"action_type": action.Action,
			"order":       action.Order,
			"active":      action.Active,
		})
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d actions in flow '%s'", len(actions), flow.Name)),
	)
}

// newFlowsTriggersCmd creates the flows triggers command group.
func newFlowsTriggersCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "triggers",
		Short: "Manage flow triggers",
		Long:  "Add and manage triggers for Flow Designer flows.",
	}

	cmd.AddCommand(
		newFlowsTriggersAddTimerCmd(),
	)

	return cmd
}

// flowsTriggersAddTimerFlags holds the flags for the flows triggers add-timer command.
type flowsTriggersAddTimerFlags struct {
	schedule string
	active   bool
}

// newFlowsTriggersAddTimerCmd creates the flows triggers add-timer command.
func newFlowsTriggersAddTimerCmd() *cobra.Command {
	var flags flowsTriggersAddTimerFlags

	cmd := &cobra.Command{
		Use:   "add-timer <flow_name_or_id>",
		Short: "Add a scheduled/timer trigger to a flow",
		Long: `Add a timer trigger to run a flow on a schedule.

The schedule uses cron format:
  "0 * * * *"     - Every hour
  "0 0 * * *"     - Daily at midnight
  "*/15 * * * *"  - Every 15 minutes
  "0 9 * * 1"     - Mondays at 9am

Examples:
  jsn flows triggers add-timer "My Flow" --schedule "0 * * * *"
  jsn flows triggers add-timer "My Flow" --schedule "0 0 * * *" --active`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsTriggersAddTimer(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.schedule, "schedule", "0 * * * *", "Cron schedule expression")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Activate the trigger immediately")

	return cmd
}

// runFlowsTriggersAddTimer executes the flows triggers add-timer command.
func runFlowsTriggersAddTimer(cmd *cobra.Command, flowIdentifier string, flags flowsTriggersAddTimerFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), flowIdentifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	trigger, err := sdkClient.CreateFlowTimerTrigger(cmd.Context(), flow.SysID, flags.schedule, flags.active)
	if err != nil {
		return fmt.Errorf("failed to add timer trigger: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id":   trigger.SysID,
		"flow_id":  flow.SysID,
		"type":     trigger.Type,
		"schedule": trigger.Schedule,
		"active":   trigger.Active,
	},
		output.WithSummary(fmt.Sprintf("Added %s trigger to flow '%s'", trigger.Type, flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", flow.SysID),
				Description: "Show flow details",
			},
		),
	)
}

// newFlowsPublishCmd creates the flows publish command.
func newFlowsPublishCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "publish [<flow_name_or_id>]",
		Short: "Publish a flow (create snapshot)",
		Long: `Publish a flow by creating a snapshot and making it usable in Flow Designer.

If no flow name or sys_id is provided, an interactive picker will help you select one.

Examples:
  jsn flows publish "My Flow"
  jsn flows publish 85841440c37ff6103c71770d050131c5`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var identifier string
			if len(args) > 0 {
				identifier = args[0]
			}
			return runFlowsPublish(cmd, identifier)
		},
	}
}

// runFlowsPublish executes the flows publish command.
func runFlowsPublish(cmd *cobra.Command, identifier string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive flow selection if no identifier provided
	if identifier == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Flow name or sys_id is required in non-interactive mode")
		}

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow to publish:")
		if err != nil {
			return err
		}
		identifier = selectedFlow
	}

	// Get the flow
	flow, err := sdkClient.GetFlow(cmd.Context(), identifier)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Publish the flow
	if err := sdkClient.PublishFlow(cmd.Context(), flow.SysID); err != nil {
		return fmt.Errorf("failed to publish flow: %w", err)
	}

	return outputWriter.OK(map[string]any{
		"sys_id": flow.SysID,
		"name":   flow.Name,
		"status": "Published",
	},
		output.WithSummary(fmt.Sprintf("Published flow '%s'", flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows show %s", flow.SysID),
				Description: "Show flow details",
			},
		),
	)
}
