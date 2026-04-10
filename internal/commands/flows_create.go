package commands

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// flowsCreateFlags holds the flags for the flows create command.
type flowsCreateFlags struct {
	name        string
	flowType    string
	description string
	active      bool
	runAs       string
	scope       string
	inputs      []string
	outputs     []string
	interactive bool
}

// newFlowsCreateCmd creates the flows create command.
func newFlowsCreateCmd() *cobra.Command {
	var flags flowsCreateFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new flow or subflow",
		Long: `Create a new Flow Designer flow or subflow.

Interactive Mode (default in TTY):
  When running in a terminal without required flags, you'll be prompted
  interactively to configure the flow step by step.

Non-Interactive Mode (scripts/CI):
  Use flags to specify all options. The --name flag is required.

Examples:
  # Interactive (TTY)
  jsn flows create

  # Non-interactive with flags
  jsn flows create --name "My Flow" --type flow
  jsn flows create --name "My Helper" --type subflow \
    --input "record_id:string:Record ID:true" \
    --output "result:boolean:Success"
  jsn flows create --name "System Flow" --active --run-as system

Input/Output Format:
  --input "name:type:label:required"
  --output "name:type:label"
  
  Types: string, integer, boolean, reference, choice, date, datetime
  Required: true or false (default: false)`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsCreate(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Flow name")
	cmd.Flags().StringVar(&flags.flowType, "type", "flow", "Flow type: flow or subflow")
	cmd.Flags().StringVar(&flags.description, "description", "", "Flow description")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Create as active")
	cmd.Flags().StringVar(&flags.runAs, "run-as", "user", "Run as: user or system")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Scope (defaults to current scope)")
	cmd.Flags().StringArrayVar(&flags.inputs, "input", nil, "Input variable (format: name:type:label:required)")
	cmd.Flags().StringArrayVar(&flags.outputs, "output", nil, "Output variable (format: name:type:label)")
	cmd.Flags().BoolVar(&flags.interactive, "interactive", false, "Force interactive mode (default auto-detected)")

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
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Determine if we should use interactive mode
	useInteractive := flags.interactive || (isTerminal && flags.name == "")

	// Interactive mode: prompt for missing values
	if useInteractive {
		if err := interactiveFlowCreate(cmd, sdkClient, &flags); err != nil {
			return err
		}
	}

	// Validate required fields
	if flags.name == "" {
		return output.ErrUsage("flow name is required (use --name or run interactively in a terminal)")
	}

	// Parse inputs
	var inputs []sdk.FlowVariableDef
	for _, inputStr := range flags.inputs {
		def, err := parseFlowVariableDef(inputStr, true)
		if err != nil {
			return output.ErrUsage(fmt.Sprintf("invalid input definition '%s': %v", inputStr, err))
		}
		inputs = append(inputs, def)
	}

	// Parse outputs
	var outputs []sdk.FlowVariableDef
	for _, outputStr := range flags.outputs {
		def, err := parseFlowVariableDef(outputStr, false)
		if err != nil {
			return output.ErrUsage(fmt.Sprintf("invalid output definition '%s': %v", outputStr, err))
		}
		outputs = append(outputs, def)
	}

	// Create flow or subflow based on type
	var flow *sdk.Flow
	var err error

	if flags.flowType == "subflow" {
		flow, err = sdkClient.CreateSubflow(cmd.Context(), sdk.CreateSubflowOptions{
			Name:        flags.name,
			Description: flags.description,
			Active:      flags.active,
			RunAs:       flags.runAs,
			Scope:       flags.scope,
			Inputs:      inputs,
			Outputs:     outputs,
		})
	} else {
		if len(inputs) > 0 || len(outputs) > 0 {
			return output.ErrUsage("inputs and outputs are only supported for subflows")
		}
		flow, err = sdkClient.CreateFlow(cmd.Context(), sdk.CreateFlowOptions{
			Name:        flags.name,
			Type:        flags.flowType,
			Description: flags.description,
			Active:      flags.active,
			RunAs:       flags.runAs,
			Scope:       flags.scope,
		})
	}

	if err != nil {
		return fmt.Errorf("failed to create flow: %w", err)
	}

	// Interactive mode: offer to add trigger and actions
	if useInteractive && flags.flowType != "subflow" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Flow Created!"))

		addTrigger, _ := confirmPrompt("Would you like to add a trigger?")
		if addTrigger {
			if err := interactiveAddTrigger(cmd, sdkClient, flow.SysID); err != nil {
				fmt.Fprintf(cmd.OutOrStdout(), "Warning: Could not add trigger: %v\n", err)
			}
		}
	}

	// Build summary
	flowTypeStr := "Flow"
	if flags.flowType == "subflow" {
		flowTypeStr = "Subflow"
	}

	data := map[string]any{
		"sys_id":      flow.SysID,
		"name":        flow.Name,
		"type":        flow.Type,
		"active":      flow.Active,
		"description": flow.Description,
	}

	if len(inputs) > 0 {
		data["inputs"] = len(inputs)
	}
	if len(outputs) > 0 {
		data["outputs"] = len(outputs)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Created %s '%s'", flowTypeStr, flow.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn flows %s", flow.SysID),
				Description: "View flow details",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn flows",
				Description: "List all flows",
			},
		),
	)
}

// interactiveFlowCreate prompts the user for flow configuration interactively
func interactiveFlowCreate(cmd *cobra.Command, sdkClient *sdk.Client, flags *flowsCreateFlags) error {
	reader := bufio.NewReader(os.Stdin)

	// Flow name
	if flags.name == "" {
		fmt.Print("Flow name: ")
		name, _ := reader.ReadString('\n')
		flags.name = strings.TrimSpace(name)
	}

	// Flow type
	if flags.flowType == "flow" {
		items := []tui.PickerItem{
			{ID: "flow", Title: "Flow", Description: "Standard flow with trigger"},
			{ID: "subflow", Title: "Subflow", Description: "Reusable flow with inputs/outputs"},
		}
		selected, err := tui.Pick("Select flow type:", items)
		if err != nil || selected == nil {
			return fmt.Errorf("flow type selection cancelled")
		}
		flags.flowType = selected.ID
	}

	// Description
	if flags.description == "" {
		fmt.Print("Description (optional): ")
		desc, _ := reader.ReadString('\n')
		flags.description = strings.TrimSpace(desc)
	}

	// Run as
	if flags.runAs == "user" {
		items := []tui.PickerItem{
			{ID: "user", Title: "User", Description: "Run as the user who triggered the flow"},
			{ID: "system", Title: "System", Description: "Run with system privileges"},
		}
		selected, err := tui.Pick("Run as:", items)
		if err == nil && selected != nil {
			flags.runAs = selected.ID
		}
	}

	// Active
	if !flags.active {
		items := []tui.PickerItem{
			{ID: "draft", Title: "Draft (inactive)", Description: "Create as draft, activate later"},
			{ID: "active", Title: "Active", Description: "Activate immediately"},
		}
		selected, err := tui.Pick("Status:", items)
		if err == nil && selected != nil {
			flags.active = selected.ID == "active"
		}
	}

	// Subflow inputs/outputs
	if flags.flowType == "subflow" {
		addInputs, _ := confirmPrompt("Would you like to add input variables?")
		for addInputs {
			input, err := interactiveVariableDef(reader, "input")
			if err != nil {
				break
			}
			def := fmt.Sprintf("%s:%s:%s:%v", input.Name, input.Type, input.Label, input.Mandatory)
			flags.inputs = append(flags.inputs, def)
			addInputs, _ = confirmPrompt("Add another input?")
		}

		addOutputs, _ := confirmPrompt("Would you like to add output variables?")
		for addOutputs {
			output, err := interactiveVariableDef(reader, "output")
			if err != nil {
				break
			}
			def := fmt.Sprintf("%s:%s:%s", output.Name, output.Type, output.Label)
			flags.outputs = append(flags.outputs, def)
			addOutputs, _ = confirmPrompt("Add another output?")
		}
	}

	return nil
}

// interactiveVariableDef prompts for a variable definition
func interactiveVariableDef(reader *bufio.Reader, direction string) (sdk.FlowVariableDef, error) {
	var def sdk.FlowVariableDef

	fmt.Printf("%s variable name: ", strings.Title(direction))
	name, _ := reader.ReadString('\n')
	def.Name = strings.TrimSpace(name)
	if def.Name == "" {
		return def, fmt.Errorf("name is required")
	}

	// Type selection
	typeItems := []tui.PickerItem{
		{ID: "string", Title: "String", Description: "Text value"},
		{ID: "integer", Title: "Integer", Description: "Whole number"},
		{ID: "boolean", Title: "Boolean", Description: "True/False"},
		{ID: "reference", Title: "Reference", Description: "Reference to a table record"},
		{ID: "choice", Title: "Choice", Description: "Selection from options"},
		{ID: "date", Title: "Date", Description: "Date only"},
		{ID: "datetime", Title: "Date/Time", Description: "Date and time"},
	}
	selected, err := tui.Pick("Variable type:", typeItems)
	if err != nil || selected == nil {
		return def, fmt.Errorf("type selection cancelled")
	}
	def.Type = selected.ID

	// Reference table
	if def.Type == "reference" {
		fmt.Print("Reference table name (e.g., incident): ")
		ref, _ := reader.ReadString('\n')
		def.Reference = strings.TrimSpace(ref)
	}

	// Label
	fmt.Printf("Display label [%s]: ", def.Name)
	label, _ := reader.ReadString('\n')
	def.Label = strings.TrimSpace(label)
	if def.Label == "" {
		def.Label = def.Name
	}

	// Required (only for inputs)
	if direction == "input" {
		items := []tui.PickerItem{
			{ID: "optional", Title: "Optional", Description: "Not required"},
			{ID: "required", Title: "Required", Description: "Must be provided"},
		}
		selected, _ := tui.Pick("Is this required?", items)
		if selected != nil {
			def.Mandatory = selected.ID == "required"
		}
	}

	return def, nil
}

// parseFlowVariableDef parses a variable definition string.
// Format for inputs: name:type:label:required
// Format for outputs: name:type:label
func parseFlowVariableDef(def string, isInput bool) (sdk.FlowVariableDef, error) {
	parts := strings.Split(def, ":")
	if len(parts) < 2 {
		return sdk.FlowVariableDef{}, fmt.Errorf("expected format: name:type[:label][:required]")
	}

	result := sdk.FlowVariableDef{
		Name: parts[0],
		Type: parts[1],
	}

	if len(parts) >= 3 {
		result.Label = parts[2]
	}
	if result.Label == "" {
		result.Label = result.Name
	}

	if isInput && len(parts) >= 4 {
		result.Mandatory = strings.ToLower(parts[3]) == "true"
	}

	return result, nil
}
