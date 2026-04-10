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

// flowsAddActionFlags holds the flags for the flows add-action command.
type flowsAddActionFlags struct {
	actionType string
	table      string
	inputs     map[string]string
	listTypes  bool
	order      string
	parent     string
}

// newFlowsActionsCmd creates the flows actions subcommand group.
func newFlowsActionsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "actions",
		Short: "Manage flow actions",
		Long: `Add, list, and remove actions from Flow Designer flows.

Actions are the steps that execute when a flow runs:
  - Record actions: Create, update, delete, look up records
  - Utility actions: Log messages
  - Logic blocks: If/Else conditions, For Each loops

Examples:
  # List actions on a flow
  jsn flows actions list "My Flow"

  # Add an action (interactive)
  jsn flows actions add "My Flow"

  # Add specific action types
  jsn flows actions add "My Flow" --type create_record --table incident
  jsn flows actions add "My Flow" --type update_record --table incident \
    --input "record={{trigger.current}}" --input "fields=work_notes=Hello"
  jsn flows actions add "My Flow" --type log --input "message=Test"

  # Add logic blocks
  jsn flows actions add "My Flow" --type if --input "condition={{trigger.current.priority}}=1"
  jsn flows actions add "My Flow" --type else

  # Remove an action
  jsn flows actions remove "My Flow" <action_id>`,
	}

	cmd.AddCommand(
		newFlowsActionsListCmd(),
		newFlowsActionsAddCmd(),
		newFlowsActionsRemoveCmd(),
		newFlowsActionsMoveCmd(),
	)

	return cmd
}

// newFlowsActionsListCmd creates the flows actions list command.
func newFlowsActionsListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <flow_name_or_sys_id>",
		Short: "List actions on a flow",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsList(cmd, args[0])
		},
	}

	return cmd
}

// runFlowsActionsList lists actions on a flow.
func runFlowsActionsList(cmd *cobra.Command, flowID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Inspect flow to get actions
	inspection, err := sdkClient.InspectFlow(cmd.Context(), flowID)
	if err != nil {
		return fmt.Errorf("failed to inspect flow: %w", err)
	}

	// Display flow structure
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ffffff"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s %s\n", headerStyle.Render("Actions for:"), inspection.Flow.Name)
	fmt.Fprintln(cmd.OutOrStdout())

	// Show action instances
	actionCount := len(inspection.ActionInstances) + len(inspection.ActionInstancesV2) + len(inspection.FlowLogicInstances)

	if actionCount == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No actions configured"))
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  Add an action:"))
		fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render("jsn flows actions add \""+inspection.Flow.Name+"\""))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	stepNum := 1

	// Display logic blocks first
	for _, logic := range inspection.FlowLogicInstances {
		fmt.Fprintf(cmd.OutOrStdout(), "  %d. ", stepNum)
		if name, ok := logic["name"].(string); ok && name != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render(name))
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render("Logic Block"))
		}
		fmt.Fprintln(cmd.OutOrStdout())

		if sysID, ok := logic["sys_id"].(string); ok {
			fmt.Fprintf(cmd.OutOrStdout(), "     ID: %s\n", mutedStyle.Render(sysID))
		}
		fmt.Fprintln(cmd.OutOrStdout())
		stepNum++
	}

	// Display actions
	for _, action := range inspection.ActionInstances {
		fmt.Fprintf(cmd.OutOrStdout(), "  %d. ", stepNum)
		if name, ok := action["name"].(string); ok && name != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render(name))
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render("Action"))
		}
		fmt.Fprintln(cmd.OutOrStdout())

		if sysID, ok := action["sys_id"].(string); ok {
			fmt.Fprintf(cmd.OutOrStdout(), "     ID: %s\n", mutedStyle.Render(sysID))
		}
		fmt.Fprintln(cmd.OutOrStdout())
		stepNum++
	}

	return nil
}

// newFlowsActionsAddCmd creates the flows actions add command.
func newFlowsActionsAddCmd() *cobra.Command {
	var flags flowsAddActionFlags

	cmd := &cobra.Command{
		Use:   "add <flow_name_or_sys_id>",
		Short: "Add an action to a flow",
		Long: `Add an action or logic block to an existing flow.

Action Types:
  create_record     Create a new record
  update_record     Update fields on a record (use for comments)
  delete_record     Delete a record
  lookup_record     Query for records
  log               Write a log message
  if                Conditional logic block
  else              Else branch for If block
  foreach           Loop through records

Examples:
  # Interactive mode
  jsn flows actions add "My Flow"

  # Create record
  jsn flows actions add "My Flow" --type create_record --table incident

  # Update record (add work note)
  jsn flows actions add "My Flow" --type update_record --table incident \
    --input "record={{trigger.current}}" --input "fields=work_notes=Comment"

  # Log message
  jsn flows actions add "My Flow" --type log --input "message=Flow ran"

  # If logic block
  jsn flows actions add "My Flow" --type if \
    --input "condition={{trigger.current.priority}}=1" \
    --input "label=High Priority"

  # List available types
  jsn flows actions add --list-types`,
		Args: func(cmd *cobra.Command, args []string) error {
			if flags.listTypes {
				return nil
			}
			if len(args) < 1 {
				return fmt.Errorf("requires flow name or sys_id argument")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsAdd(cmd, args, flags)
		},
	}

	cmd.Flags().StringVar(&flags.actionType, "type", "", "Action type")
	cmd.Flags().StringVar(&flags.table, "table", "", "Table name")
	cmd.Flags().StringToStringVar(&flags.inputs, "input", nil, "Input values as key=value pairs")
	cmd.Flags().BoolVar(&flags.listTypes, "list-types", false, "List available action types")

	return cmd
}

// runFlowsActionsAdd adds an action to a flow.
func runFlowsActionsAdd(cmd *cobra.Command, args []string, flags flowsAddActionFlags) error {
	// Handle --list-types
	if flags.listTypes {
		return printActionTypes(cmd)
	}

	if len(args) < 1 {
		return output.ErrUsage("flow name or sys_id is required")
	}

	// Delegate to existing add-action logic
	return runFlowsAddAction(cmd, args, flags)
}

// newFlowsActionsRemoveCmd creates the flows actions remove command.
func newFlowsActionsRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <flow_name_or_sys_id> <action_id>",
		Short: "Remove an action from a flow",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsRemove(cmd, args[0], args[1])
		},
	}

	return cmd
}

// runFlowsActionsRemove removes an action from a flow.
func runFlowsActionsRemove(cmd *cobra.Command, flowID, actionID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	opts := sdk.RemoveFlowActionOptions{
		FlowID:   flowID,
		ActionID: actionID,
	}

	if err := sdkClient.RemoveFlowAction(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to remove action: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":   flowID,
		"action": actionID,
	}, output.WithSummary("Removed action from flow"))
}

// newFlowsActionsMoveCmd creates the flows actions move command.
func newFlowsActionsMoveCmd() *cobra.Command {
	var parentID string
	var order string

	cmd := &cobra.Command{
		Use:   "move <flow_name_or_sys_id> <action_id>",
		Short: "Move an action to a different position or parent",
		Long: `Move an action within a flow, either to change its order or parent.

This is useful for:
  - Moving an action inside an If/Else block
  - Reordering actions
  - Organizing flow structure

Examples:
  # Move action inside an If block
  jsn flows actions move "My Flow" <action_id> --parent <if_block_id>

  # Change order
  jsn flows actions move "My Flow" <action_id> --order 3`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsActionsMove(cmd, args[0], args[1], parentID, order)
		},
	}

	cmd.Flags().StringVar(&parentID, "parent", "", "Parent logic block ID (for nesting inside If/Else)")
	cmd.Flags().StringVar(&order, "order", "", "Order position (e.g., 1, 2, 3)")

	return cmd
}

// runFlowsActionsMove moves an action within a flow.
func runFlowsActionsMove(cmd *cobra.Command, flowID, actionID, parentID, order string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	opts := sdk.MoveFlowActionOptions{
		FlowID:   flowID,
		ActionID: actionID,
		ParentID: parentID,
		Order:    order,
	}

	if err := sdkClient.MoveFlowAction(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to move action: %w", err)
	}

	// Build summary
	summary := "Moved action"
	if parentID != "" {
		summary += fmt.Sprintf(" inside parent %s", parentID)
	}
	if order != "" {
		summary += fmt.Sprintf(" to position %s", order)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":   flowID,
		"action": actionID,
		"parent": parentID,
		"order":  order,
	}, output.WithSummary(summary))
}

// newFlowsAddActionCmd creates the flows add-action command.
func newFlowsAddActionCmd() *cobra.Command {
	var flags flowsAddActionFlags

	cmd := &cobra.Command{
		Use:   "add-action [<flow_name_or_sys_id>]",
		Short: "Add an action to an existing flow",
		Long: `Add an action to an existing flow.

The order of actions matters. Actions inside logic blocks (If, For Each) must use
the --parent flag with the logic block's UI ID, and must use a higher order number
than the logic block itself.

Order is global across the flow:
- Set Flow Variables typically: order 1
- If / For Each typically: order 2
- Actions inside logic blocks: order 3+ (higher than the enclosing logic)

To find a logic block's UI ID, run: jsn flows save <flow> --agent
Then check the output for the logic block UI ID.

Examples:
  # List available action types
  jsn flows add-action --list-types

  # Interactive mode (in TTY)
  jsn flows add-action "My Flow"

  # Create Record action
  jsn flows add-action "My Flow" --type create_record --table incident

  # Update Record action (use for adding comments/work notes)
  jsn flows add-action "My Flow" --type update_record --table incident \
    --input "record={{trigger.current}}" --input "values=work_notes=My comment"

  # Log action
  jsn flows add-action "My Flow" --type log --input "message=Flow executed"

  # Add action inside an If block (after saving to get the If's UI ID)
  IF_UI_ID=$(jsn flows save "My Flow" --agent | jq -r '.flow')
  jsn flows add-action "My Flow" --type update_record --table incident \
    --input "record={{trigger.current}}" \
    --input "values=work_notes=My comment" \
    --order 3 --parent "$IF_UI_ID"`,
		Args: func(cmd *cobra.Command, args []string) error {
			// If --list-types is set, no flow ID required
			if flags.listTypes {
				return nil
			}
			if len(args) < 1 {
				return fmt.Errorf("requires flow name or sys_id argument (or use --list-types)")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsAddAction(cmd, args, flags)
		},
	}

	cmd.Flags().StringVar(&flags.actionType, "type", "", "Action type (e.g., create_record, update_record, log)")
	cmd.Flags().StringVar(&flags.table, "table", "", "Table name (e.g., incident, change_request)")
	cmd.Flags().StringToStringVar(&flags.inputs, "input", nil, "Input values as key=value pairs (e.g., record={{trigger.current}}, values=work_notes=Hello)")
	cmd.Flags().BoolVar(&flags.listTypes, "list-types", false, "List available action types")
	cmd.Flags().StringVar(&flags.order, "order", "", "Execution order - must be higher than parent logic block (e.g., 3 for actions inside an If block with order 2)")
	cmd.Flags().StringVar(&flags.parent, "parent", "", "Parent logic block UI ID - required for actions inside If/For Each blocks")

	return cmd
}

// runFlowsAddAction executes the flows add-action command.
func runFlowsAddAction(cmd *cobra.Command, args []string, flags flowsAddActionFlags) error {
	// Handle --list-types flag
	if flags.listTypes {
		return printActionTypes(cmd)
	}

	// Get flow ID from args
	if len(args) < 1 {
		return output.ErrUsage("flow name or sys_id is required (or use --list-types)")
	}
	flowID := args[0]

	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Validate action type if provided
	if flags.actionType != "" {
		validTypes := map[string]bool{
			// Record actions
			"create_record": true,
			"update_record": true,
			"delete_record": true,
			"lookup_record": true,
			// Utility actions
			"log": true,
			// Logic blocks
			"if":           true,
			"else":         true,
			"elseif":       true,
			"foreach":      true,
			"set_variable": true, // Set Flow Variables
		}
		if !validTypes[flags.actionType] {
			return output.ErrUsage(fmt.Sprintf("invalid action type: %s (use --list-types to see available types)", flags.actionType))
		}
	}

	// Interactive mode if not all required flags provided and in TTY
	if isTerminal && flags.actionType == "" {
		_, err := interactiveAddActionOrLogicToFlow(cmd, sdkClient, flowID, "")
		return err
	}

	// Validate required flags
	if flags.actionType == "" {
		return output.ErrUsage("action type is required (use --type or run interactively)")
	}

	// Check if this is a logic block type
	logicTypes := map[string]bool{
		"if":           true,
		"else":         true,
		"elseif":       true,
		"foreach":      true,
		"set_variable": true,
	}

	if logicTypes[flags.actionType] {
		// Handle logic blocks
		return runFlowsAddLogic(cmd, sdkClient, flowID, flags)
	}

	// Create the action
	opts := sdk.AddFlowActionOptions{
		FlowID:     flowID,
		ActionType: flags.actionType,
		Table:      flags.table,
		Inputs:     flags.inputs,
		Order:      flags.order,
		ParentUIID: flags.parent,
	}

	if err := sdkClient.AddFlowAction(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to add action: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":   flowID,
		"action": flags.actionType,
		"table":  flags.table,
	}, output.WithSummary(fmt.Sprintf("Added %s action to flow", flags.actionType)))
}

// validateCondition checks if condition uses inline logic and suggests flow variables
func validateCondition(condition string) error {
	if condition == "" {
		return nil
	}

	// Check for inline function calls (not using flow variables)
	inlinePatterns := []struct {
		pattern string
		suggest string
	}{
		{"dayOfWeek()", "Create a flow variable with: jsn flows variables add <flow> --name day_of_week --type integer"},
		{"dayofweek()", "Create a flow variable with: jsn flows variables add <flow> --name day_of_week --type integer"},
		{"new Date()", "Create a flow variable and use set_variable action to calculate the value"},
		{"getDay()", "Create a flow variable and use set_variable action to calculate the value"},
		{"now()", "Create a flow variable with current timestamp using set_variable action"},
		{"today()", "Create a flow variable with current date using set_variable action"},
	}

	lowerCond := strings.ToLower(condition)
	for _, p := range inlinePatterns {
		if strings.Contains(lowerCond, strings.ToLower(p.pattern)) {
			return fmt.Errorf("inline logic not allowed: '%s'\n\nFlow Designer requires flow variables for logic conditions.\n\nTo fix this:\n1. Create a flow variable:\n   %s\n\n2. Set its value using set_variable action:\n   jsn flows actions add <flow> --type set_variable --variable <name> --script \"<script>\"\n\n3. Reference the variable in your condition:\n   --input \"condition={{flow_variable.<name>}}=<value>\"\n\nSee FLOWS_VARIABLES.md for examples", p.pattern, p.suggest)
		}
	}

	// Check for raw expressions without pill references
	if !strings.Contains(condition, "{{") && !strings.Contains(condition, "}}") {
		// This looks like a raw value comparison (e.g., "priority=1")
		// This is OK for simple field comparisons
		return nil
	}

	return nil
}

// runFlowsAddLogic handles adding logic blocks (if, else, foreach, set_variable)
func runFlowsAddLogic(cmd *cobra.Command, sdkClient *sdk.Client, flowID string, flags flowsAddActionFlags) error {
	appCtx := appctx.FromContext(cmd.Context())

	// Handle set_variable separately
	if flags.actionType == "set_variable" {
		return runFlowsAddSetVariable(cmd, sdkClient, flowID, flags)
	}

	var opts sdk.AddFlowLogicOptions
	opts.FlowID = flowID
	opts.LogicType = flags.actionType
	opts.Order = flags.order

	// Extract condition and label from inputs
	if flags.inputs != nil {
		opts.Condition = flags.inputs["condition"]
		opts.Label = flags.inputs["label"]
	}

	// Validate condition for inline logic
	if opts.LogicType == "if" || opts.LogicType == "elseif" {
		if err := validateCondition(opts.Condition); err != nil {
			return err
		}
	}

	_, err := sdkClient.AddFlowLogic(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to add logic block: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":  flowID,
		"logic": flags.actionType,
	}, output.WithSummary(fmt.Sprintf("Added %s logic block to flow", flags.actionType)))
}

// runFlowsAddSetVariable handles adding a Set Flow Variables logic block
func runFlowsAddSetVariable(cmd *cobra.Command, sdkClient *sdk.Client, flowID string, flags flowsAddActionFlags) error {
	appCtx := appctx.FromContext(cmd.Context())

	// Extract variable name and script from inputs
	var variableName, script string
	if flags.inputs != nil {
		variableName = flags.inputs["variable"]
		script = flags.inputs["script"]
	}

	if variableName == "" {
		return fmt.Errorf("variable name is required for set_variable. Use: --input \"variable=<name>\" --input \"script=<script>\"")
	}

	opts := sdk.AddSetFlowVariablesOptions{
		FlowID:   flowID,
		Variable: variableName,
		Script:   script,
		Order:    flags.order,
	}

	if err := sdkClient.AddSetFlowVariables(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to add set_variable action: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":     flowID,
		"action":   "set_variable",
		"variable": variableName,
	}, output.WithSummary(fmt.Sprintf("Added set_variable action for '%s'", variableName)))
}

// printActionTypes prints the available action types
func printActionTypes(cmd *cobra.Command) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	nameStyle := lipgloss.NewStyle().Bold(true)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Available Action Types"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Record Actions:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("create_record"), mutedStyle.Render("Insert a new record"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("update_record"), mutedStyle.Render("Update fields (use for comments/work_notes)"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("delete_record"), mutedStyle.Render("Remove a record"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("lookup_record"), mutedStyle.Render("Query for records"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Utility Actions:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("log"), mutedStyle.Render("Write a log message"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Logic Blocks:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("if"), mutedStyle.Render("Conditional execution"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("else"), mutedStyle.Render("Else branch"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("foreach"), mutedStyle.Render("Loop through records"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-18s %s\n", nameStyle.Render("set_variable"), mutedStyle.Render("Set flow variable values with scripts"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Usage: jsn flows add-action <flow> --type <action_type>"))
	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("       jsn flows add-action <flow>  (for interactive mode)"))
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// interactiveAddActionOrLogicToFlow interactively adds an action or logic block.
// Returns the UI ID of any newly created logic block for nesting.
func interactiveAddActionOrLogicToFlow(cmd *cobra.Command, sdkClient *sdk.Client, flowID, parentID string) (string, error) {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println()
	if parentID != "" {
		fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Add Step Inside Logic Block"))
	} else {
		fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Add Step to Flow"))
	}
	fmt.Println()

	// Build step items based on context
	var stepItems []tui.PickerItem
	if parentID != "" {
		// Inside a logic block - only show actions
		stepItems = []tui.PickerItem{
			{ID: "create_record", Title: "Create Record", Description: "Insert a new record"},
			{ID: "update_record", Title: "Update Record", Description: "Modify a record (add comments)"},
			{ID: "delete_record", Title: "Delete Record", Description: "Remove a record"},
			{ID: "lookup_record", Title: "Look Up Record", Description: "Query records"},
			{ID: "log", Title: "Log", Description: "Write a log"},
		}
	} else {
		// Top level - show actions and logic
		stepItems = []tui.PickerItem{
			{ID: "create_record", Title: "Create Record", Description: "Insert a new record"},
			{ID: "update_record", Title: "Update Record", Description: "Modify a record (add comments)"},
			{ID: "delete_record", Title: "Delete Record", Description: "Remove a record"},
			{ID: "lookup_record", Title: "Look Up Record", Description: "Query records"},
			{ID: "log", Title: "Log", Description: "Write a log"},
			{ID: "if", Title: "If", Description: "Conditional logic block"},
			{ID: "else", Title: "Else", Description: "Else branch"},
		}
	}

	stepType, err := tui.Pick("Select step type:", stepItems)
	if err != nil || stepType == nil {
		return "", nil
	}

	// Handle logic blocks
	switch stepType.ID {
	case "if":
		return interactiveAddIfLogic(cmd, reader, sdkClient, flowID)
	case "else":
		return "", interactiveAddElseLogic(cmd, sdkClient, flowID)
	}

	// Handle regular actions
	return "", interactiveAddRegularAction(cmd, reader, sdkClient, flowID, stepType.ID, parentID)
}

// interactiveAddIfLogic adds an If logic block and returns its UI ID.
func interactiveAddIfLogic(cmd *cobra.Command, reader *bufio.Reader, sdkClient *sdk.Client, flowID string) (string, error) {
	fmt.Print("Condition (e.g., {{trigger.current.priority}}=1): ")
	condition, _ := reader.ReadString('\n')
	condition = strings.TrimSpace(condition)

	fmt.Print("Label (optional): ")
	label, _ := reader.ReadString('\n')
	label = strings.TrimSpace(label)

	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Adding If logic..."))

	opts := sdk.AddFlowLogicOptions{
		FlowID:    flowID,
		LogicType: "if",
		Condition: condition,
		Label:     label,
	}

	result, err := sdkClient.AddFlowLogic(cmd.Context(), opts)
	if err != nil {
		return "", fmt.Errorf("failed to add If logic: %w", err)
	}

	fmt.Println()
	fmt.Print(lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00")).Render("✓ If logic added"))
	if condition != "" {
		fmt.Printf(" with condition: %s", condition)
	}
	fmt.Println()
	fmt.Println()

	return result.UIUniqueIdentifier, nil
}

// interactiveAddElseLogic adds an Else logic block.
func interactiveAddElseLogic(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Adding Else logic..."))

	opts := sdk.AddFlowLogicOptions{
		FlowID:    flowID,
		LogicType: "else",
	}

	_, err := sdkClient.AddFlowLogic(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to add Else logic: %w", err)
	}

	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00")).Render("✓ Else logic added"))
	fmt.Println()

	return nil
}

// interactiveAddRegularAction adds a regular action.
func interactiveAddRegularAction(cmd *cobra.Command, reader *bufio.Reader, sdkClient *sdk.Client, flowID, actionType, parentID string) error {
	table := ""
	if actionType != "log" {
		fmt.Print("Table name (e.g., incident): ")
		tableInput, _ := reader.ReadString('\n')
		table = strings.TrimSpace(tableInput)
		if table == "" {
			return fmt.Errorf("table name is required")
		}
	}

	inputs := make(map[string]string)

	switch actionType {
	case "update_record":
		fmt.Print("Record to update (e.g., {{trigger.current}}): ")
		record, _ := reader.ReadString('\n')
		record = strings.TrimSpace(record)
		if record != "" {
			inputs["record"] = record
		}
		fmt.Print("Fields to update (e.g., work_notes=Comment text): ")
		fields, _ := reader.ReadString('\n')
		fields = strings.TrimSpace(fields)
		if fields != "" {
			inputs["fields"] = fields
		}
	case "log":
		fmt.Print("Message: ")
		message, _ := reader.ReadString('\n')
		message = strings.TrimSpace(message)
		if message != "" {
			inputs["message"] = message
		}
	}

	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Adding action..."))

	opts := sdk.AddFlowActionOptions{
		FlowID:     flowID,
		ActionType: actionType,
		Table:      table,
		Inputs:     inputs,
		ParentUIID: parentID,
	}

	if err := sdkClient.AddFlowAction(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to add action: %w", err)
	}

	fmt.Println()
	actionTitle := strings.ReplaceAll(actionType, "_", " ")
	fmt.Print(lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00")).Render("✓ Action added: "))
	fmt.Print(actionTitle)
	if table != "" {
		fmt.Printf(" on %s", table)
	}
	fmt.Println()
	fmt.Println()

	return nil
}
