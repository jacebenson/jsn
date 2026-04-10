package commands

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// newFlowsVariablesCmd creates the flows variables subcommand group.
func newFlowsVariablesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "variables",
		Short: "Manage flow variables",
		Long: `Add, list, and remove variables from Flow Designer flows.

Flow variables store data that can be referenced in actions and conditions
using "pill" syntax like {{flow_variable.my_var}}.

Examples:
  # List variables on a flow
  jsn flows variables list "My Flow"

  # Add a variable
  jsn flows variables add "My Flow" --name day_of_week --type string

  # Add with options
  jsn flows variables add "My Flow" --name priority --type integer \
    --label "Priority Level" --default 3`,
	}

	cmd.AddCommand(
		newFlowsVariablesListCmd(),
		newFlowsVariablesAddCmd(),
	)

	return cmd
}

// flowsVariablesAddFlags holds flags for the flows variables add command.
type flowsVariablesAddFlags struct {
	name         string
	label        string
	varType      string
	mandatory    bool
	defaultValue string
}

// newFlowsVariablesAddCmd creates the flows variables add command.
func newFlowsVariablesAddCmd() *cobra.Command {
	var flags flowsVariablesAddFlags

	cmd := &cobra.Command{
		Use:   "add <flow_name_or_sys_id>",
		Short: "Add a variable to a flow",
		Long: `Add a variable to an existing flow.

Variable Types:
  string     Text values
  integer    Whole numbers
  boolean    true/false
  reference  Reference to another record
  choice     Selection from options

The variable will be available as a "pill" reference:
  {{flow_variable.your_variable_name}}

Examples:
  # Add a string variable
  jsn flows variables add "My Flow" --name day_of_week --type string

  # Add with label and default
  jsn flows variables add "My Flow" --name status --type string \
    --label "Current Status" --default "new"

  # Add mandatory integer
  jsn flows variables add "My Flow" --name priority --type integer \
    --mandatory --default 3`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsVariablesAdd(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Variable name (required)")
	cmd.Flags().StringVar(&flags.label, "label", "", "Display label (defaults to name)")
	cmd.Flags().StringVar(&flags.varType, "type", "", "Variable type: string, integer, boolean, reference, choice (required)")
	cmd.Flags().BoolVar(&flags.mandatory, "mandatory", false, "Make variable required")
	cmd.Flags().StringVar(&flags.defaultValue, "default", "", "Default value")

	cmd.MarkFlagRequired("name")
	cmd.MarkFlagRequired("type")

	return cmd
}

// runFlowsVariablesAdd adds a variable to a flow.
func runFlowsVariablesAdd(cmd *cobra.Command, flowID string, flags flowsVariablesAddFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	opts := sdk.AddFlowVariableOptions{
		FlowID:       flowID,
		Name:         flags.name,
		Label:        flags.label,
		Type:         flags.varType,
		Mandatory:    flags.mandatory,
		DefaultValue: flags.defaultValue,
	}

	variable, err := sdkClient.AddFlowVariable(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to add variable: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":     flowID,
		"variable": variable.Name,
		"type":     variable.Type,
		"pill":     sdk.FlowVariablePill(variable.Name),
	}, output.WithSummary(fmt.Sprintf("Added variable '%s' to flow", variable.Name)))
}

// newFlowsVariablesListCmd creates the flows variables list command.
func newFlowsVariablesListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <flow_name_or_sys_id>",
		Short: "List variables on a flow",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsVariablesList(cmd, args[0])
		},
	}

	return cmd
}

// runFlowsVariablesList lists variables on a flow.
func runFlowsVariablesList(cmd *cobra.Command, flowID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get flow to display name
	flow, err := sdkClient.GetFlow(cmd.Context(), flowID)
	if err != nil {
		return fmt.Errorf("failed to get flow: %w", err)
	}

	// Get variables
	variables, err := sdkClient.GetFlowVariables(cmd.Context(), flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to get variables: %w", err)
	}

	// Display variables
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s %s\n", headerStyle.Render("Variables for:"), flow.Name)
	fmt.Fprintln(cmd.OutOrStdout())

	if len(variables) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No variables configured"))
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  Add a variable:"))
		fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render("jsn flows variables add \""+flow.Name+"\" --name my_var --type string"))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	for _, v := range variables {
		fmt.Fprintf(cmd.OutOrStdout(), "  • %s", v.Name)
		if v.Label != "" && v.Label != v.Name {
			fmt.Fprintf(cmd.OutOrStdout(), " (%s)", mutedStyle.Render(v.Label))
		}
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "    Type: %s | Pill: %s\n", v.Type, codeStyle.Render(sdk.FlowVariablePill(v.Name)))
		if v.Value != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "    Default: %s\n", v.Value)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}
