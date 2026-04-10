package commands

import (
	"fmt"
	"strings"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// flowsListFlags holds the flags for the flows command.
type flowsListFlags struct {
	limit  int
	active bool
	search string
	query  string
	order  string
	desc   bool
	all    bool
	debug  bool
}

// NewFlowsCmd creates the flows command.
func NewFlowsCmd() *cobra.Command {
	var flags flowsListFlags

	cmd := &cobra.Command{
		Use:   "flows [<name_or_sys_id>] [variables]",
		Short: "Manage Flow Designer flows",
		Long: `List, inspect, and create ServiceNow Flow Designer flows.

Usage:
  jsn flows <name_or_sys_id>                    Show flow details
  jsn flows <name_or_sys_id> variables         Show flow variables only
  jsn flows create [flags]                      Create a new flow or subflow
  jsn flows --search <term>                    Fuzzy search on name (LIKE match)
  jsn flows --query <encoded_query>            Raw ServiceNow encoded query filter

IMPORTANT - Order and Parent for nested actions:
  When adding actions inside If/For Each blocks, use --order and --parent flags.
  - Use "jsn flows save <flow>" to get the logic block's UI ID
  - Actions inside logic blocks need order higher than the logic block
  - Example: If block is order 2, action inside it should be order 3

Filtering:
  --search <term>   Fuzzy search on name (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering
  --active          Show only active flows

Subcommands:
  create            Create a new flow or subflow
  execute           Execute/test a flow
  executions        Show flow execution history

Examples:
  jsn flows "Approval Flow"
  jsn flows --search approval
  jsn flows --active --json
  jsn flows --query "nameLIKEapproval^active=true" --limit 50
  jsn flows create --name "My Flow" --type flow
  jsn flows create --name "My Helper" --type subflow --input "id:string:ID:true"`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct lookup by name or sys_id
			if len(args) > 0 {
				name := args[0]
				showVariables := len(args) > 1 && args[1] == "variables"
				return runFlowsShow(cmd, name, showVariables)
			}

			// Mode 2 & 3: Search/list (handles interactive picker when no filters)
			return runFlowsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of flows to fetch")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active flows")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on name")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all flows (no limit)")
	cmd.Flags().BoolVar(&flags.debug, "debug", false, "Show debug info including raw gzipped values")

	cmd.AddCommand(
		newFlowsExecutionsCmd(),
		newFlowsExecuteCmd(),
		newFlowsCreateCmd(),
		newFlowsTriggersCmd(),
		newFlowsActionsCmd(),
		newFlowsVariablesCmd(),
		newFlowsSaveCmd(),
		// Legacy commands (deprecated in favor of triggers/actions subcommands)
		newFlowsAddTriggerCmd(),
		newFlowsAddActionCmd(),
	)

	return cmd
}

// --- Shared helpers used across flows_*.go files ---

// formatTriggerCondition formats a ServiceNow encoded query condition for display.
func formatTriggerCondition(condition string) string {
	if condition == "" {
		return ""
	}

	// Simple formatting: replace encoded operators with readable ones
	result := condition

	// Replace OR operator
	result = strings.ReplaceAll(result, "^OR", " OR ")

	// Replace AND operator
	result = strings.ReplaceAll(result, "^", " AND ")

	// Replace comparison operators
	result = strings.ReplaceAll(result, "=", " = ")
	result = strings.ReplaceAll(result, "!=", " != ")
	result = strings.ReplaceAll(result, ">=", " >= ")
	result = strings.ReplaceAll(result, "<=", " <= ")
	result = strings.ReplaceAll(result, ">", " > ")
	result = strings.ReplaceAll(result, "<", " < ")
	result = strings.ReplaceAll(result, "LIKE", " LIKE ")

	// Clean up field names (convert sys_class_name to Event Type for common patterns)
	if strings.Contains(result, "sys_class_name") {
		result = strings.ReplaceAll(result, "sys_class_name", "Event Type")
	}

	// Clean up multiple spaces
	for strings.Contains(result, "  ") {
		result = strings.ReplaceAll(result, "  ", " ")
	}

	return strings.TrimSpace(result)
}

// titleCase converts a string to title case.
func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// getString extracts a string value from a map, handling both plain strings
// and ServiceNow-style {display_value, value} objects.
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

// confirmPrompt shows a yes/no interactive picker.
func confirmPrompt(question string) (bool, error) {
	items := []tui.PickerItem{
		{ID: "yes", Title: "Yes", Description: ""},
		{ID: "no", Title: "No", Description: ""},
	}
	selected, err := tui.Pick(question, items, tui.WithAutoSelectSingle())
	if err != nil || selected == nil {
		return false, nil
	}
	return selected.ID == "yes", nil
}

// newFlowsSaveCmd creates the flows save command.
func newFlowsSaveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "save <flow_name_or_sys_id>",
		Short: "Save/regenerate flow version payload",
		Long: `Regenerate the flow version payload after making structural changes.

Flow Designer reads from a version payload snapshot. After adding variables,
triggers, or actions via CLI, you must save the flow to make changes visible
in Flow Designer.

Examples:
  # Save/regenerate flow payload
  jsn flows save "My Flow"

  # Save by sys_id
  jsn flows save <sys_id>

This command acquires a safe edit lock, regenerates the version payload from
the current flow structure, and releases the lock.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsSave(cmd, args[0])
		},
	}

	return cmd
}

// runFlowsSave executes the flows save command.
func runFlowsSave(cmd *cobra.Command, flowID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Save/regenerate the flow
	if err := sdkClient.SaveFlow(cmd.Context(), flowID); err != nil {
		return fmt.Errorf("failed to save flow: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow": flowID,
	}, output.WithSummary("Flow saved successfully"))
}
