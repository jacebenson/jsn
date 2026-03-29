package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
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
	limit  int
	active bool
	search string
	query  string
	order  string
	desc   bool
	all    bool
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

Filtering:
  --search <term>   Fuzzy search on name (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering

Examples:
  jsn flows list
  jsn flows list --search approval
  jsn flows list --active
  jsn flows list --query "nameLIKEapproval^active=true" --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of flows to fetch")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active flows")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on name")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "name" for alphabetical browsing - most intuitive for finding flows
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all flows (no limit)")

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
	if flags.search != "" {
		queryParts = append(queryParts, fmt.Sprintf("nameLIKE%s", flags.search))
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

	// Interactive mode - let user select a flow to view (auto-detect TTY)
	useInteractive := isTerminal && !appCtx.NoInteractive() && format == output.FormatAuto
	if useInteractive {
		selectedFlow, err := pickFlowFromList(flows)
		if err != nil {
			return err
		}
		if selectedFlow == "" {
			return fmt.Errorf("no flow selected")
		}
		// Show the selected flow
		return runFlowsShow(cmd, selectedFlow, false)
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
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-20s\n",
		headerStyle.Render("Sys ID"),
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
		if len(name) > 34 {
			name = name[:31] + "..."
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, flow.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-20s\n",
				mutedStyle.Render(flow.SysID),
				nameWithLink,
				statusStyle.Render(status),
				mutedStyle.Render(scope),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-20s\n",
				mutedStyle.Render(flow.SysID),
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
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Name | Status | Scope |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------|--------|-------|")

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
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n", flow.SysID, flow.Name, status, scope)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newFlowsShowCmd creates the flows show command.
func newFlowsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "show [<identifier>] [variables]",
		Aliases: []string{"get"},
		Short:   "Show flow details",
		Long: `Display detailed information about a flow.

The identifier can be a flow name or sys_id.
If no identifier is provided, an interactive picker will help you select one.
Use "variables" as the second argument to show only flow variables.

Examples:
  jsn flows show "Approval Flow"
  jsn flows show 0123456789abcdef0123456789abcdef
  jsn flows show "Approval Flow" variables
  jsn flows show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			var showVariables bool

			if len(args) > 0 {
				name = args[0]
			}
			if len(args) > 1 && args[1] == "variables" {
				showVariables = true
			}

			return runFlowsShow(cmd, name, showVariables)
		},
	}
}

// runFlowsShow executes the flows show command.
func runFlowsShow(cmd *cobra.Command, name string, showVariables bool) error {
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

		selectedFlow, err := pickFlow(cmd.Context(), sdkClient, "Select a flow:")
		if err != nil {
			return err
		}
		name = selectedFlow
	}

	// Get the flow first to get the ID
	flow, err := sdkClient.GetFlow(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// If showing variables only
	if showVariables {
		return showFlowVariables(cmd, flow, sdkClient, outputWriter)
	}

	// Use InspectFlow to get comprehensive flow details
	inspection, err := sdkClient.InspectFlow(cmd.Context(), flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to inspect flow: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Get instance URL for links
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFlowInspection(cmd, inspection, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFlowInspection(cmd, inspection)
	}

	// Build data for JSON
	data := map[string]any{
		"flow": map[string]any{
			"sys_id":      inspection.Flow.SysID,
			"name":        inspection.Flow.Name,
			"active":      inspection.Flow.Active,
			"description": inspection.Flow.Description,
			"version":     inspection.Flow.Version,
		},
		"components":          inspection.Components,
		"action_instances":    inspection.ActionInstances,
		"action_instances_v2": inspection.ActionInstancesV2,
		"trigger_instances":   inspection.TriggerInstances,
		"timer_triggers":      inspection.TimerTriggers,
		"record_triggers":     inspection.RecordTriggers,
		"flow_inputs":         inspection.FlowInputs,
		"flow_outputs":        inspection.FlowOutputs,
		"flow_data_vars":      inspection.FlowDataVars,
		"version_record":      inspection.Version,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, inspection.Flow.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Flow: %s", inspection.Flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn flows list",
				Description: "List all flows",
			},
		),
	)
}

// showFlowVariables displays only the flow variables.
func showFlowVariables(cmd *cobra.Command, flow *sdk.Flow, sdkClient *sdk.Client, outputWriter *output.Writer) error {
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
// printStyledFlowInspection outputs comprehensive styled flow inspection.
func printStyledFlowInspection(cmd *cobra.Command, inspection *sdk.FlowInspection, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()
	triggerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00FF00"))
	actionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#FFAA00"))
	linkStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00AAFF"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Flow: %s", inspection.Flow.Name)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic flow info
	status := "Inactive"
	if inspection.Flow.Active {
		status = "Active"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  Status: %s | Version: %s\n", valueStyle.Render(status), mutedStyle.Render(inspection.Flow.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "  Sys ID: %s\n", mutedStyle.Render(inspection.Flow.SysID))

	// Show link if available
	if instanceURL != "" {
		flowURL := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, inspection.Flow.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "  Link: %s\n", linkStyle.Render(flowURL))
	}

	// Show Inputs/Outputs section only for subflows
	isSubflow := strings.EqualFold(inspection.Flow.Type, "subflow")
	if isSubflow && (len(inspection.FlowInputs) > 0 || len(inspection.FlowOutputs) > 0) {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), triggerStyle.Render("▶ SUBFLOW"))
		fmt.Fprintln(cmd.OutOrStdout(), strings.Repeat("─", 50))

		// Show inputs
		if len(inspection.FlowInputs) > 0 {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s (%d)\n", valueStyle.Render("Inputs"), len(inspection.FlowInputs))
			for _, input := range inspection.FlowInputs {
				label := getString(input, "label")
				name := getString(input, "name")
				inputType := getString(input, "type")
				mandatory := getString(input, "mandatory")

				displayName := label
				if displayName == "" {
					displayName = name
				}

				mandatoryStr := ""
				if mandatory == "true" {
					mandatoryStr = " (required)"
				}

				if inputType != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "    • %s: %s%s\n", mutedStyle.Render(displayName), valueStyle.Render(inputType), mutedStyle.Render(mandatoryStr))
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "    • %s%s\n", mutedStyle.Render(displayName), mutedStyle.Render(mandatoryStr))
				}
			}
		}

		// Show outputs
		if isSubflow && len(inspection.FlowOutputs) > 0 {
			if len(inspection.FlowInputs) > 0 {
				fmt.Fprintln(cmd.OutOrStdout())
			}
			fmt.Fprintf(cmd.OutOrStdout(), "  %s (%d)\n", valueStyle.Render("Outputs"), len(inspection.FlowOutputs))
			for _, output := range inspection.FlowOutputs {
				label := getString(output, "label")
				name := getString(output, "name")
				outputType := getString(output, "type")

				displayName := label
				if displayName == "" {
					displayName = name
				}

				if outputType != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "    • %s: %s\n", mutedStyle.Render(displayName), valueStyle.Render(outputType))
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "    • %s\n", mutedStyle.Render(displayName))
				}
			}
		}

		// Add spacing before trigger section if there are also triggers
		if len(inspection.TriggerInstances) > 0 || len(inspection.Version) > 0 {
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	// TRIGGER SECTION
	// Primary source: version payload's triggerInstances (has name, type, table)
	// Fallback: sys_hub_trigger_instance table (has flow field)
	triggerName := ""
	triggerType := ""
	triggerTable := ""
	triggerTime := ""

	if len(inspection.Version) > 0 {
		if tn, ok := inspection.Version["trigger_name"].(string); ok && tn != "" {
			triggerName = tn
		}
		if tt, ok := inspection.Version["trigger_type"].(string); ok && tt != "" {
			triggerType = tt
		}
		if tb, ok := inspection.Version["trigger_table"].(string); ok && tb != "" {
			triggerTable = tb
		}
		if tt, ok := inspection.Version["trigger_time"].(string); ok && tt != "" {
			// Extract just the time part (HH:MM:SS) from the datetime
			parts := strings.Split(tt, " ")
			if len(parts) == 2 {
				triggerTime = parts[1]
			} else {
				triggerTime = tt
			}
		}
	}

	// Fallback to trigger instances table
	if triggerName == "" && len(inspection.TriggerInstances) > 0 {
		ti := inspection.TriggerInstances[0]
		triggerName = getString(ti, "name")
		if triggerName == "" {
			triggerName = getString(ti, "trigger_type")
		}
		triggerType = getString(ti, "trigger_type")
	}

	if triggerName != "" || triggerType != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), triggerStyle.Render("▶ TRIGGER"))
		fmt.Fprintln(cmd.OutOrStdout(), strings.Repeat("─", 50))

		// Display trigger name
		if triggerName != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(triggerName))
		}

		// Display trigger type if different from name
		if triggerType != "" {
			// Format type for display (e.g., "record_create" -> "Record Create")
			typeDisplay := strings.ReplaceAll(triggerType, "_", " ")
			typeDisplay = titleCase(typeDisplay)
			if typeDisplay != triggerName {
				fmt.Fprintf(cmd.OutOrStdout(), "  %s: %s\n", mutedStyle.Render("Type"), mutedStyle.Render(typeDisplay))
			}
		}

		// Display table for record-based triggers
		if triggerTable != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s: %s\n", mutedStyle.Render("Table"), valueStyle.Render(triggerTable))
		}

		// Display time for scheduled triggers
		if triggerTime != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s: %s\n", mutedStyle.Render("Time"), mutedStyle.Render(triggerTime))
		}
	}

	// ACTIONS SECTION
	// Build flow structure from version payload if available
	if len(inspection.Version) > 0 {
		if payload, ok := inspection.Version["payload"].(string); ok && payload != "" {
			var payloadData map[string]interface{}
			if err := json.Unmarshal([]byte(payload), &payloadData); err == nil {
				// Show flow structure with logic and actions
				fmt.Fprintln(cmd.OutOrStdout())
				fmt.Fprintln(cmd.OutOrStdout(), actionStyle.Render("⚡ FLOW STRUCTURE"))
				fmt.Fprintln(cmd.OutOrStdout(), strings.Repeat("─", 50))

				// Collect all top-level items (actions, logic, subflows) sorted by order.
				// Logic instances with flowBlock arrays contain their children inline.
				// We build a tree by:
				//  1. Identifying which uiUniqueIdentifiers appear inside any flowBlock
				//  2. Top-level = items NOT inside any flowBlock
				//  3. Logic blocks' children come from their flowBlock array (recursive)

				// First pass: collect all uids that appear inside a flowBlock
				childUIDs := make(map[string]bool)
				var markChildren func(items []interface{})
				markChildren = func(items []interface{}) {
					for _, item := range items {
						if m, ok := item.(map[string]interface{}); ok {
							if uid, ok := m["uiUniqueIdentifier"].(string); ok && uid != "" {
								childUIDs[uid] = true
							}
							// Recurse into nested flowBlocks
							if fb, ok := m["flowBlock"].([]interface{}); ok {
								markChildren(fb)
							}
						}
					}
				}
				// Scan logic instances for flowBlock children
				if flowLogic, ok := payloadData["flowLogicInstances"].([]interface{}); ok {
					for _, logic := range flowLogic {
						if m, ok := logic.(map[string]interface{}); ok {
							if fb, ok := m["flowBlock"].([]interface{}); ok {
								markChildren(fb)
							}
						}
					}
				}

				// Build top-level step list (items not inside any flowBlock)
				var rootSteps []flowStep

				if actionInstances, ok := payloadData["actionInstances"].([]interface{}); ok {
					for _, action := range actionInstances {
						if m, ok := action.(map[string]interface{}); ok {
							uid := getString(m, "uiUniqueIdentifier")
							if uid != "" && childUIDs[uid] {
								continue // skip, it's a child of a logic block
							}
							orderStr := getString(m, "order")
							order, _ := strconv.Atoi(orderStr)
							rootSteps = append(rootSteps, flowStep{stepType: "action", data: m, order: order})
						}
					}
				}
				if subFlowInstances, ok := payloadData["subFlowInstances"].([]interface{}); ok {
					for _, sf := range subFlowInstances {
						if m, ok := sf.(map[string]interface{}); ok {
							uid := getString(m, "uiUniqueIdentifier")
							if uid != "" && childUIDs[uid] {
								continue
							}
							orderStr := getString(m, "order")
							order, _ := strconv.Atoi(orderStr)
							rootSteps = append(rootSteps, flowStep{stepType: "subflow", data: m, order: order})
						}
					}
				}
				if flowLogic, ok := payloadData["flowLogicInstances"].([]interface{}); ok {
					for _, logic := range flowLogic {
						if m, ok := logic.(map[string]interface{}); ok {
							uid := getString(m, "uiUniqueIdentifier")
							if uid != "" && childUIDs[uid] {
								continue
							}
							orderStr := getString(m, "order")
							order, _ := strconv.Atoi(orderStr)
							rootSteps = append(rootSteps, flowStep{stepType: "logic", data: m, order: order})
						}
					}
				}

				sort.Slice(rootSteps, func(i, j int) bool {
					return rootSteps[i].order < rootSteps[j].order
				})

				// Recursive walk: print a step, then if it's a logic block, walk its flowBlock children
				stepNum := 1
				var walkSteps func(steps []flowStep, indent int)
				walkSteps = func(steps []flowStep, indent int) {
					for _, step := range steps {
						printFlowStep(cmd, stepNum, indent, step, valueStyle, mutedStyle)
						stepNum++

						// If this is a logic block, walk its flowBlock children
						if step.stepType == "logic" {
							if fb, ok := step.data["flowBlock"].([]interface{}); ok && len(fb) > 0 {
								var children []flowStep
								for _, child := range fb {
									if m, ok := child.(map[string]interface{}); ok {
										childType := classifyPayloadItem(m)
										orderStr := getString(m, "order")
										order, _ := strconv.Atoi(orderStr)
										children = append(children, flowStep{stepType: childType, data: m, order: order})
									}
								}
								sort.Slice(children, func(i, j int) bool {
									return children[i].order < children[j].order
								})
								walkSteps(children, indent+1)
							}
						}
					}
				}
				walkSteps(rootSteps, 0)
			}
		}
	}

	// Fallback: show flat list from V1/V2 action instances + flow logic + subflow instances
	// when no version payload was available
	hasPayload := false
	if len(inspection.Version) > 0 {
		if payload, ok := inspection.Version["payload"].(string); ok && payload != "" {
			hasPayload = true
		}
	}
	if !hasPayload {
		type flatStep struct {
			order int
			label string
			name  string // original name (for subflow hints)
			kind  string // "action", "logic", "subflow"
		}
		var steps []flatStep

		// Add V1 action instances
		for _, action := range inspection.ActionInstances {
			name := ""
			if at, ok := action["action_type"].(map[string]interface{}); ok {
				name = getString(at, "display_value")
			}
			if name == "" {
				name = getString(action, "name")
			}
			if name == "" {
				name = getString(action, "display_text")
			}
			if name == "" {
				name = "Action"
			}
			orderStr := getString(action, "order")
			order, _ := strconv.Atoi(orderStr)
			steps = append(steps, flatStep{order: order, label: name, kind: "action"})
		}

		// Add V2 action instances
		for _, action := range inspection.ActionInstancesV2 {
			name := ""
			if at, ok := action["action_type"].(map[string]interface{}); ok {
				name = getString(at, "display_value")
			}
			if name == "" {
				name = getString(action, "name")
			}
			if name == "" {
				name = getString(action, "display_text")
			}
			if name == "" {
				name = "Action"
			}
			orderStr := getString(action, "order")
			order, _ := strconv.Atoi(orderStr)
			steps = append(steps, flatStep{order: order, label: name, kind: "action"})
		}

		// Add flow logic instances
		for _, logic := range inspection.FlowLogicInstances {
			name := getString(logic, "name")
			if name == "" {
				name = getString(logic, "display_text")
			}
			if name == "" {
				name = "Logic"
			}
			orderStr := getString(logic, "order")
			order, _ := strconv.Atoi(orderStr)
			steps = append(steps, flatStep{order: order, label: name, kind: "logic"})
		}

		// Add subflow instances
		for _, sf := range inspection.SubFlowInstances {
			name := getString(sf, "name")
			if name == "" {
				name = getString(sf, "display_text")
			}
			if name == "" {
				name = "Subflow"
			}
			orderStr := getString(sf, "order")
			order, _ := strconv.Atoi(orderStr)
			steps = append(steps, flatStep{order: order, label: "↪ " + name, name: name, kind: "subflow"})
		}

		if len(steps) > 0 {
			sort.Slice(steps, func(i, j int) bool {
				return steps[i].order < steps[j].order
			})

			fmt.Fprintln(cmd.OutOrStdout())
			fmt.Fprintln(cmd.OutOrStdout(), actionStyle.Render("⚡ FLOW STRUCTURE"))
			fmt.Fprintln(cmd.OutOrStdout(), strings.Repeat("─", 50))
			for i, step := range steps {
				fmt.Fprintf(cmd.OutOrStdout(), "%d. %s\n", i+1, valueStyle.Render(step.label))
				if step.kind == "subflow" && step.name != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "   %s\n", mutedStyle.Render(fmt.Sprintf("jsn flows show \"%s\"", step.name)))
				}
			}
		}
	}

	// Show step instances if they have labels (these are the actual configured steps)
	labeledSteps := 0
	for _, step := range inspection.StepInstances {
		if getString(step, "label") != "" {
			labeledSteps++
		}
	}

	if labeledSteps > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Steps:"))
		for _, step := range inspection.StepInstances {
			label := getString(step, "label")
			if label != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", valueStyle.Render(label))
			}
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// flowStep represents an action, logic, or subflow step for tree display
type flowStep struct {
	stepType string // "action", "logic", or "subflow"
	data     map[string]interface{}
	order    int
}

// classifyPayloadItem determines the step type of a payload item by checking for
// type-specific fields: flowLogicDefinition (logic), subFlowType (subflow), else action.
func classifyPayloadItem(m map[string]interface{}) string {
	if _, ok := m["flowLogicDefinition"]; ok {
		return "logic"
	}
	if _, ok := m["subFlowType"]; ok {
		return "subflow"
	}
	// Some subflows lack subFlowType but have subflowSysId or subFlow
	if _, ok := m["subflowSysId"]; ok {
		return "subflow"
	}
	if _, ok := m["subFlow"]; ok {
		return "subflow"
	}
	return "action"
}

// printFlowStep prints a single flow step (action, logic, or subflow) with tree indentation.
// indent=0 is top-level, indent=1 adds 4 spaces, etc.
func printFlowStep(cmd *cobra.Command, stepNum int, indent int, step flowStep, valueStyle lipgloss.Style, mutedStyle lipgloss.Style) {
	pad := strings.Repeat("    ", indent)

	switch step.stepType {
	case "action":
		printActionStep(cmd, stepNum, pad, step.data, valueStyle, mutedStyle)
	case "subflow":
		printSubFlowStep(cmd, stepNum, pad, step.data, valueStyle, mutedStyle)
	default: // "logic"
		printLogicStep(cmd, stepNum, pad, step.data, valueStyle, mutedStyle)
	}
}

// printActionStep prints a flow action step with indentation
func printActionStep(cmd *cobra.Command, stepNum int, pad string, action map[string]interface{}, valueStyle lipgloss.Style, mutedStyle lipgloss.Style) {
	// Get action name from actionType.fName or fallbacks
	actionName := ""
	if actionType, ok := action["actionType"].(map[string]interface{}); ok {
		actionName = getString(actionType, "fName")
	}
	if actionName == "" {
		actionName = getString(action, "actionName")
	}
	if actionName == "" {
		actionName = getString(action, "actionInternalName")
	}
	if actionName == "" {
		actionName = getString(action, "name")
	}
	if actionName == "" {
		actionName = "Unknown Action"
	}

	// For Update Record actions, get the table name
	tableName := ""
	if inputs, ok := action["inputs"].([]interface{}); ok {
		for _, input := range inputs {
			if inputMap, ok := input.(map[string]interface{}); ok {
				if name := getString(inputMap, "name"); name == "table_name" {
					tableName = getString(inputMap, "displayValue")
					if tableName == "" {
						tableName = getString(inputMap, "value")
					}
					break
				}
			}
		}
	}

	// Build full action description
	actionDisplay := actionName
	if tableName != "" && actionName == "Update Record" {
		actionDisplay = actionName + " - " + tableName
	}

	// Get annotation/comment
	comment := getString(action, "comment")
	if comment == "" {
		comment = getString(action, "displayText")
	}

	// Print the action with indentation
	if comment != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "%s%d. %s (%s)\n", pad, stepNum, valueStyle.Render(actionDisplay), mutedStyle.Render(comment))
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "%s%d. %s\n", pad, stepNum, valueStyle.Render(actionDisplay))
	}
}

// printSubFlowStep prints a subflow call step with indentation
func printSubFlowStep(cmd *cobra.Command, stepNum int, pad string, subFlow map[string]interface{}, valueStyle lipgloss.Style, mutedStyle lipgloss.Style) {
	// Get subflow name from subFlowType.fName or fallbacks
	subFlowName := ""
	if subFlowType, ok := subFlow["subFlowType"].(map[string]interface{}); ok {
		subFlowName = getString(subFlowType, "fName")
	}
	if subFlowName == "" {
		subFlowName = getString(subFlow, "subFlowName")
	}
	if subFlowName == "" {
		subFlowName = getString(subFlow, "subFlowInternalName")
	}
	// Check subFlow object (nested flow definition with name)
	if subFlowName == "" {
		if sf, ok := subFlow["subFlow"].(map[string]interface{}); ok {
			subFlowName = getString(sf, "name")
		}
	}
	if subFlowName == "" {
		subFlowName = getString(subFlow, "name")
	}
	if subFlowName == "" {
		subFlowName = "Unknown Subflow"
	}

	// Get annotation/comment
	comment := getString(subFlow, "comment")

	if comment != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "%s%d. %s (%s)\n", pad, stepNum, valueStyle.Render("↪ "+subFlowName), mutedStyle.Render(comment))
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "%s%d. %s\n", pad, stepNum, valueStyle.Render("↪ "+subFlowName))
	}

	// Show drill-down hint
	fmt.Fprintf(cmd.OutOrStdout(), "%s   %s\n", pad, mutedStyle.Render(fmt.Sprintf("jsn flows show \"%s\"", subFlowName)))
}

// printLogicStep prints a flow logic step with indentation
func printLogicStep(cmd *cobra.Command, stepNum int, pad string, logic map[string]interface{}, valueStyle lipgloss.Style, mutedStyle lipgloss.Style) {
	// Get logic type from flowLogicDefinition
	logicType := "Logic"
	if flowLogicDef, ok := logic["flowLogicDefinition"].(map[string]interface{}); ok {
		if name := getString(flowLogicDef, "name"); name != "" {
			logicType = name
		}
	}
	if logicType == "" {
		logicType = getString(logic, "name")
	}
	if logicType == "" {
		logicType = "Logic Step"
	}

	// Get annotation/comment
	comment := getString(logic, "comment")

	// Extract condition for If statements
	condition := ""
	conditionLabel := ""
	if logicType == "If" || logicType == "Else If" {
		if inputs, ok := logic["inputs"].([]interface{}); ok {
			for _, input := range inputs {
				if inputMap, ok := input.(map[string]interface{}); ok {
					inputName := getString(inputMap, "name")
					if inputName == "condition" {
						condition = getString(inputMap, "displayValue")
						if condition == "" {
							condition = getString(inputMap, "value")
						}
					} else if inputName == "condition_name" {
						conditionLabel = getString(inputMap, "displayValue")
						if conditionLabel == "" {
							conditionLabel = getString(inputMap, "value")
						}
					}
				}
			}
		}
	}

	// Build display text
	displayText := logicType
	if conditionLabel != "" {
		displayText = logicType + ": " + conditionLabel
	} else if condition != "" && len(condition) < 60 {
		displayText = logicType + ": " + condition
	}

	// Print the logic step with indentation
	fmt.Fprintf(cmd.OutOrStdout(), "%s%d. %s\n", pad, stepNum, valueStyle.Render(displayText))

	// Print condition on separate line if it's long
	if condition != "" && len(condition) >= 60 && conditionLabel == "" {
		fmt.Fprintf(cmd.OutOrStdout(), "%s   %s: %s\n", pad, mutedStyle.Render("Condition"), valueStyle.Render(condition))
	}

	if comment != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "%s   %s: %s\n", pad, mutedStyle.Render("Annotation"), valueStyle.Render(comment))
	}

	// For Set Flow Variables, show the variables being set
	if logicType == "Set Flow Variables" {
		if flowVars, ok := logic["flowVariables"].([]interface{}); ok && len(flowVars) > 0 {
			fmt.Fprintf(cmd.OutOrStdout(), "%s   %s:\n", pad, mutedStyle.Render("Variables Set"))
			for _, fv := range flowVars {
				if fvMap, ok := fv.(map[string]interface{}); ok {
					varName := getString(fvMap, "name")
					varValue := getString(fvMap, "displayValue")
					if varValue == "" {
						varValue = getString(fvMap, "value")
					}
					if varName != "" {
						if varValue != "" {
							fmt.Fprintf(cmd.OutOrStdout(), "%s     • %s = %s\n", pad, varName, valueStyle.Render(varValue))
						} else {
							fmt.Fprintf(cmd.OutOrStdout(), "%s     • %s\n", pad, varName)
						}
					}
				}
			}
		}
	}
}

// printMarkdownFlowInspection outputs comprehensive markdown flow inspection.
func printMarkdownFlowInspection(cmd *cobra.Command, inspection *sdk.FlowInspection) error {
	fmt.Fprintf(cmd.OutOrStdout(), "# Flow Inspection: %s\n\n", inspection.Flow.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "**Sys ID:** %s\n\n", inspection.Flow.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "**Active:** %v\n\n", inspection.Flow.Active)
	fmt.Fprintf(cmd.OutOrStdout(), "**Version:** %s\n\n", inspection.Flow.Version)

	// Combine components and actions into a single sorted list
	type flowItem struct {
		order    int
		itemType string
		name     string
		details  string
		comment  string
	}

	var items []flowItem

	// Build logic name map from payload if available
	logicNameMap := make(map[string]string)
	if len(inspection.Version) > 0 {
		if payload, ok := inspection.Version["payload"].(string); ok && payload != "" {
			var payloadData map[string]interface{}
			if err := json.Unmarshal([]byte(payload), &payloadData); err == nil {
				if flowLogic, ok := payloadData["flowLogicInstances"].([]interface{}); ok {
					for _, logic := range flowLogic {
						if logicMap, ok := logic.(map[string]interface{}); ok {
							// Get the uiUniqueIdentifier as the key
							uiID := ""
							if id, ok := logicMap["uiUniqueIdentifier"].(string); ok {
								uiID = id
							} else if id, ok := logicMap["id"].(string); ok {
								uiID = id
							}

							// Get the logic type name from flowLogicDefinition
							logicName := "Logic"
							if flowLogicDef, ok := logicMap["flowLogicDefinition"].(map[string]interface{}); ok {
								if name, ok := flowLogicDef["name"].(string); ok && name != "" {
									logicName = name
								}
							}
							if logicName == "" {
								if name, ok := logicMap["name"].(string); ok {
									logicName = name
								}
							}

							if uiID != "" {
								logicNameMap[uiID] = logicName
							}
						}
					}
				}
			}
		}
	}

	// Add components (excluding action/subflow instances - those are added separately with more detail)
	for _, comp := range inspection.Components {
		className := getString(comp, "sys_class_name")
		// Skip action instances and subflow instances - we'll add them separately
		if className == "sys_hub_action_instance" || className == "sys_hub_sub_flow_instance" {
			continue
		}

		orderStr := getString(comp, "order")
		order, _ := strconv.Atoi(orderStr)
		sysID := getString(comp, "sys_id")
		uiID := getString(comp, "ui_id")

		// Get the logic name from the payload data if available
		name := className
		if uiID != "" {
			if logicName, found := logicNameMap[uiID]; found {
				name = logicName
			}
		}

		items = append(items, flowItem{
			order:    order,
			itemType: className,
			name:     name,
			details:  sysID,
			comment:  "",
		})
	}

	// Add V1 action instances (may come from API or version payload)
	for _, action := range inspection.ActionInstances {
		orderStr := getString(action, "order")
		order, _ := strconv.Atoi(orderStr)

		// Handle both API format (action_type) and payload format (actionType.fName)
		actionName := getString(action, "action_type")
		if actionName == "" {
			if at, ok := action["actionType"].(map[string]interface{}); ok {
				actionName = getString(at, "fName")
			}
		}
		if actionName == "" {
			actionName = getString(action, "actionName")
		}

		comment := getString(action, "comment")
		sysID := getString(action, "sys_id")
		if sysID == "" {
			sysID = getString(action, "id")
		}

		items = append(items, flowItem{
			order:    order,
			itemType: "sys_hub_action_instance",
			name:     actionName,
			details:  sysID,
			comment:  comment,
		})
	}

	// Add subflow instances from payload (preferred — has names) or components (fallback)
	if len(inspection.SubFlowInstances) > 0 {
		for _, subFlow := range inspection.SubFlowInstances {
			orderStr := getString(subFlow, "order")
			order, _ := strconv.Atoi(orderStr)
			sysID := getString(subFlow, "id")

			subFlowName := ""
			if subFlowType, ok := subFlow["subFlowType"].(map[string]interface{}); ok {
				subFlowName = getString(subFlowType, "fName")
			}
			if subFlowName == "" {
				subFlowName = getString(subFlow, "subFlowName")
			}
			if subFlowName == "" {
				subFlowName = getString(subFlow, "name")
			}
			if subFlowName == "" {
				subFlowName = "Subflow"
			}

			comment := getString(subFlow, "comment")

			items = append(items, flowItem{
				order:    order,
				itemType: "sys_hub_sub_flow_instance",
				name:     subFlowName,
				details:  sysID,
				comment:  comment,
			})
		}
	} else {
		for _, comp := range inspection.Components {
			className := getString(comp, "sys_class_name")
			if className == "sys_hub_sub_flow_instance" {
				orderStr := getString(comp, "order")
				order, _ := strconv.Atoi(orderStr)
				sysID := getString(comp, "sys_id")

				items = append(items, flowItem{
					order:    order,
					itemType: "sys_hub_sub_flow_instance",
					name:     "Subflow",
					details:  sysID,
					comment:  "",
				})
			}
		}
	}

	// Add V2 action instances
	for _, action := range inspection.ActionInstancesV2 {
		orderStr := getString(action, "order")
		order, _ := strconv.Atoi(orderStr)
		actionType := getString(action, "action_type")
		sysID := getString(action, "sys_id")

		items = append(items, flowItem{
			order:    order,
			itemType: "sys_hub_action_instance_v2",
			name:     actionType,
			details:  sysID,
			comment:  "",
		})
	}

	// Sort by order
	sort.Slice(items, func(i, j int) bool {
		return items[i].order < items[j].order
	})

	// Print combined list
	if len(items) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Flow Steps (%d)\n\n", len(items))
		for _, item := range items {
			prefix := ""
			if item.itemType == "sys_hub_action_instance" {
				prefix = "[V1] "
			} else if item.itemType == "sys_hub_action_instance_v2" {
				prefix = "[V2] "
			} else if item.itemType == "sys_hub_sub_flow_instance" {
				prefix = "[Subflow] "
			}

			if item.comment != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "- Order %d: %s%s (%s)\n", item.order, prefix, item.name, item.comment)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- Order %d: %s%s\n", item.order, prefix, item.name)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Show Inputs/Outputs only for subflows
	isSubflow := strings.EqualFold(inspection.Flow.Type, "subflow")
	if isSubflow && len(inspection.FlowInputs) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Inputs (%d)\n\n", len(inspection.FlowInputs))
		for _, input := range inspection.FlowInputs {
			label := getString(input, "label")
			name := getString(input, "name")
			inputType := getString(input, "type")
			mandatory := getString(input, "mandatory")

			displayName := label
			if displayName == "" {
				displayName = name
			}

			mandatoryStr := ""
			if mandatory == "true" {
				mandatoryStr = " (required)"
			}

			if inputType != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s**: %s%s\n", displayName, inputType, mandatoryStr)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s**%s\n", displayName, mandatoryStr)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if len(inspection.FlowOutputs) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "## Outputs (%d)\n\n", len(inspection.FlowOutputs))
		for _, output := range inspection.FlowOutputs {
			label := getString(output, "label")
			name := getString(output, "name")
			outputType := getString(output, "type")

			displayName := label
			if displayName == "" {
				displayName = name
			}

			if outputType != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s**: %s\n", displayName, outputType)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s**\n", displayName)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Show Trigger info in markdown from version payload or trigger instances
	triggerNameMD := ""
	triggerTypeMD := ""
	triggerTableMD := ""
	if len(inspection.Version) > 0 {
		if tn, ok := inspection.Version["trigger_name"].(string); ok && tn != "" {
			triggerNameMD = tn
		}
		if tt, ok := inspection.Version["trigger_type"].(string); ok && tt != "" {
			triggerTypeMD = tt
		}
		if tb, ok := inspection.Version["trigger_table"].(string); ok && tb != "" {
			triggerTableMD = tb
		}
	}
	if triggerNameMD == "" && len(inspection.TriggerInstances) > 0 {
		ti := inspection.TriggerInstances[0]
		triggerNameMD = getString(ti, "name")
		triggerTypeMD = getString(ti, "trigger_type")
	}
	if triggerNameMD != "" || triggerTypeMD != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "## Trigger\n\n")
		if triggerNameMD != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "- **%s**", triggerNameMD)
			if triggerTypeMD != "" {
				fmt.Fprintf(cmd.OutOrStdout(), " (%s)", triggerTypeMD)
			}
			fmt.Fprintln(cmd.OutOrStdout())
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "- Type: %s\n", triggerTypeMD)
		}
		if triggerTableMD != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "- Table: %s\n", triggerTableMD)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// getString safely extracts a string value from a map.
// titleCase capitalizes the first letter of each space-separated word.
// Replaces deprecated strings.Title for simple cases.
func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

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
