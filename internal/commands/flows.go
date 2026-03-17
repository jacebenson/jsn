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

	// Get flow actions
	actions, err := sdkClient.GetFlowActions(cmd.Context(), flow.SysID)
	if err != nil {
		// Don't fail if we can't get actions, just show flow info
		actions = []sdk.FlowAction{}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowDebug(cmd, flow, actions)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowDebug(cmd, flow, actions)
	}

	// Build data for JSON
	actionData := make([]map[string]any, len(actions))
	for i, a := range actions {
		actionData[i] = map[string]any{
			"sys_id": a.SysID,
			"name":   a.Name,
			"action": a.Action,
			"order":  a.Order,
			"active": a.Active,
		}
	}

	data := map[string]any{
		"sys_id":  flow.SysID,
		"name":    flow.Name,
		"active":  flow.Active,
		"actions": actionData,
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Flow Debug: %s (%d actions)", flow.Name, len(actions))),
	)
}

// printStyledFlowDebug outputs styled flow debug info.
func printStyledFlowDebug(cmd *cobra.Command, flow *sdk.Flow, actions []sdk.FlowAction) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Flow Debug: %s", flow.Name)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !flow.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(flow.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Version:"), valueStyle.Render(flow.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Actions:"), valueStyle.Render(fmt.Sprintf("%d", len(actions))))

	// Actions list
	if len(actions) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Actions:"))
		fmt.Fprintln(cmd.OutOrStdout())

		for _, action := range actions {
			actionStatus := "Active"
			if !action.Active {
				actionStatus = "Inactive"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "  %s. %s (%s) - %s\n",
				mutedStyle.Render(fmt.Sprintf("%d", action.Order)),
				valueStyle.Render(action.Name),
				mutedStyle.Render(action.Action),
				mutedStyle.Render(actionStatus),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFlowDebug outputs markdown flow debug info.
func printMarkdownFlowDebug(cmd *cobra.Command, flow *sdk.Flow, actions []sdk.FlowAction) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Flow Debug: %s**\n\n", flow.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", flow.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", map[bool]string{true: "Active", false: "Inactive"}[flow.Active])
	fmt.Fprintf(cmd.OutOrStdout(), "- **Version:** %s\n", flow.Version)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Actions:** %d\n", len(actions))

	if len(actions) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Actions:**")
		for _, action := range actions {
			fmt.Fprintf(cmd.OutOrStdout(), "- %d. %s (%s) - %s\n",
				action.Order, action.Name, action.Action,
				map[bool]string{true: "Active", false: "Inactive"}[action.Active])
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
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
