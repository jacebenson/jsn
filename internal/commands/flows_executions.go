package commands

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

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
				Cmd:         fmt.Sprintf("jsn flows %s", name),
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
