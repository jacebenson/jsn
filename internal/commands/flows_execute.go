package commands

import (
	"fmt"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

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
