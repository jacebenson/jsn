// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
)

// flowDefaultColumns are the default columns to show for flows
var flowDefaultColumns = []string{"name", "active", "description", "sys_created_by", "sys_updated_on"}

// NewFlowsCmd creates the flows command.
func NewFlowsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "flows",
		Aliases: []string{"flow"},
		Short:   "Manage Flow Designer flows",
		Args:    cobra.NoArgs,
		Long: `Manage Flow Designer flows.

Flows automate business processes with a visual designer.

Read operations (list, show) use the Table API on sys_hub_flow.
Create/update/delete operations require the Flow Designer GraphQL API
which is not yet implemented.

Examples:
  # Show this help
  jsn dev flows

  # List flows
  jsn dev flows list

  # List with a filter
  jsn dev flows list --query "active=true"

  # Show a flow
  jsn dev flows show "My Flow"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newFlowsListCmd(),
		newFlowsShowCmd(),
		newFlowsCreateCmd(),
		newFlowsUpdateCmd(),
		newFlowsDeleteCmd(),
	)

	return cmd
}

func newFlowsListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List flows",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			// Compatibility: if query flag is empty but one positional argument was
			// provided, treat it as the filter query. This supports usage like:
			//   jsn dev flows list -q "nameLIKEtest"
			// where -q may be consumed by the global quiet flag.
			effectiveQuery := query
			queryFromPositional := false
			if effectiveQuery == "" && len(args) == 1 {
				effectiveQuery = args[0]
				queryFromPositional = true
			}

			// list subcommand should open picker when interactive and no filter
			// also force picker if query came from positional fallback (likely -q collision)
			if output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin) {
				if app.Output.GetFormat() == output.FormatAuto || queryFromPositional {
					return listFlowsInteractive(ctx, app, effectiveQuery, 20)
				}
			}

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = flowDefaultColumns
			}

			return listFlows(ctx, app, effectiveQuery, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string (e.g., 'active=true^nameLIKEApproval')")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newFlowsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show flow details",
		Long: `Show details for a specific flow by name or sys_id.

Uses the Table API on sys_hub_flow to retrieve flow metadata.
For full flow definitions (actions, connections), the Flow Designer
GraphQL API would be required.

Examples:
  jsn dev flows show "My Flow"
  jsn dev flows show abc123def456abc123def456abc12345`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showFlowRecord(ctx, app, args[0])
		},
	}
}

// showFlowRecord shows a minimal flow record payload (sys_id + name).
func showFlowRecord(ctx context.Context, app *appctx.App, identifier string) error {
	var query string
	if len(identifier) == 32 && isHexString(identifier) {
		query = "sys_id=" + identifier
	} else {
		query = "name=" + identifier
	}

	params := url.Values{}
	params.Set("sysparm_query", query)
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,name")

	records, err := app.SDK.List(ctx, "sys_hub_flow", params)
	if err != nil {
		return fmt.Errorf("failed to find flow: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("flow not found: %s", identifier)
	}

	record := map[string]any{
		"sys_id": getFlowStringField(records[0], "sys_id"),
		"name":   getFlowStringField(records[0], "name"),
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Flow: %s", record["name"])),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev flows list",
				Description: "Back to all flows",
			},
		),
	)
}

func newFlowsCreateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "create",
		Short: "Create a new flow (not yet implemented)",
		Long: `Flow creation requires the Flow Designer GraphQL API.

The Table API does not support creating or modifying flows - these
operations require the Flow Designer GraphQL endpoints which are
not yet implemented in this CLI.

To create flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to view your flows

Planned implementation: POST /api/sn_fnd/flow/v1/flows with GraphQL mutation`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow creation requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to create flows, then use 'jsn dev flows list' to view them")
		},
	}
}

func newFlowsUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update [name|sys_id]",
		Short: "Update an existing flow (not yet implemented)",
		Long: `Flow updates require the Flow Designer GraphQL API.

The Table API does not support modifying flows - these operations
require the Flow Designer GraphQL endpoints for:
  - Flow versioning and state management
  - Action configuration and connections
  - Draft/published state transitions

To update flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to view your flows

Planned implementation: PUT /api/sn_fnd/flow/v1/flows/{sys_id} with GraphQL mutation`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow updates require Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to update flows, then use 'jsn dev flows list' to view them")
		},
	}
}

func newFlowsDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete [name|sys_id]",
		Short: "Delete a flow (not yet implemented)",
		Long: `Flow deletion requires the Flow Designer GraphQL API.

While the Table API could delete the sys_hub_flow record directly,
this may leave orphaned flow versions and related data in supporting
tables (sys_hub_flow_input, sys_hub_action_instance, etc.).

The Flow Designer GraphQL API provides proper cleanup.

To delete flows:
  1. Use the ServiceNow web UI Flow Designer
  2. Then use 'jsn dev flows list' to confirm deletion

Planned implementation: DELETE /api/sn_fnd/flow/v1/flows/{sys_id}`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("flow deletion requires Flow Designer GraphQL API - not yet implemented\n" +
				"Use the ServiceNow web UI to delete flows, then use 'jsn dev flows list' to confirm")
		},
	}
}

// listFlows lists flows using the Table API on sys_hub_flow
func listFlows(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = flowDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listFlowsInteractive(ctx, app, query, 20)
	}

	params := url.Values{}
	params.Set("sysparm_limit", "20")
	params.Set("sysparm_display_value", "all")
	// Always include sys_id for hyperlinks and identification
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Default ordering: most recently updated first
	// Append ORDERBYDESC to any existing query
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "sys_hub_flow", params)
	if err != nil {
		return fmt.Errorf("failed to list flows: %w", err)
	}

	// Format for display
	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatFlowForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_hub_flow",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d flow(s)", len(records))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "filter",
				Cmd:         "jsn dev flows list --query \"active=true\"",
				Description: "Show only active flows",
			},
		),
	)
}

// listFlowsInteractive shows an interactive picker for flows with pagination
func listFlowsInteractive(ctx context.Context, app *appctx.App, baseQuery string, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_hub_flow").
		WithColumns("name", "active", "description", "sys_created_by").
		WithBaseQuery(baseQuery).
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			active := getStringField(record, "active")
			sysID := getStringField(record, "sys_id")

			statusIcon := "🟢"
			if active != "true" {
				statusIcon = "⚪"
			}

			title := fmt.Sprintf("%s %s", statusIcon, name)

			return tui.PickerItem{
				ID:    sysID,
				Title: title,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		return showFlowInspectionStyled(ctx, app, selected.ID)
	}

	return nil
}

// showFlowInspectionStyled renders flow inspection in styled format.
// Used by interactive list picker to match legacy jsn flows UX.
func showFlowInspectionStyled(ctx context.Context, app *appctx.App, identifier string) error {
	inspection, err := app.SDK.InspectFlow(ctx, identifier)
	if err != nil {
		return err
	}

	return printStyledFlowInspection(inspection, app.Config.GetEffectiveInstance())
}

// printStyledFlowInspection outputs styled flow inspection details.
func printStyledFlowInspection(inspection *sdk.FlowInspection, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	triggerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00FF66"))
	actionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#FFAA00"))
	linkStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00AAFF"))

	fmt.Println()
	fmt.Println(headerStyle.Render(fmt.Sprintf("Flow: %s", inspection.Flow.Name)))
	fmt.Println()

	status := "Inactive"
	if inspection.Flow.Active {
		status = "Active"
	}
	version := inspection.Flow.Version
	if version == "" {
		version = inferFlowVersion(inspection)
	}

	fmt.Printf("  Status: %s | Version: %s\n", valueStyle.Render(status), mutedStyle.Render(version))
	fmt.Printf("  Sys ID: %s\n", mutedStyle.Render(inspection.Flow.SysID))
	if instanceURL != "" && inspection.Flow.SysID != "" {
		flowURL := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, inspection.Flow.SysID)
		fmt.Printf("  Link: %s\n", linkStyle.Render(flowURL))
	}

	// Subflow I/O section
	if strings.EqualFold(inspection.Flow.Type, "subflow") {
		fmt.Println()
		fmt.Println(triggerStyle.Render("▶ SUBFLOW"))
		fmt.Println(strings.Repeat("─", 50))

		if len(inspection.FlowInputs) > 0 {
			fmt.Printf("  %s (%d)\n", valueStyle.Render("Inputs"), len(inspection.FlowInputs))
			for _, input := range inspection.FlowInputs {
				name := firstNonEmpty(getStringField(input, "label"), getStringField(input, "name"), "Input")
				typeName := getStringField(input, "type")
				if typeName != "" {
					fmt.Printf("    • %s: %s\n", mutedStyle.Render(name), valueStyle.Render(typeName))
				} else {
					fmt.Printf("    • %s\n", mutedStyle.Render(name))
				}
			}
		}

		if len(inspection.FlowOutputs) > 0 {
			if len(inspection.FlowInputs) > 0 {
				fmt.Println()
			}
			fmt.Printf("  %s (%d)\n", valueStyle.Render("Outputs"), len(inspection.FlowOutputs))
			for _, out := range inspection.FlowOutputs {
				name := firstNonEmpty(getStringField(out, "label"), getStringField(out, "name"), "Output")
				typeName := getStringField(out, "type")
				if typeName != "" {
					fmt.Printf("    • %s: %s\n", mutedStyle.Render(name), valueStyle.Render(typeName))
				} else {
					fmt.Printf("    • %s\n", mutedStyle.Render(name))
				}
			}
		}
	}

	// Trigger section
	triggerName, triggerType, triggerTable, triggerTime, triggerCondition := extractTriggerDetails(inspection)
	if triggerName != "" || triggerType != "" || triggerTable != "" || triggerTime != "" || triggerCondition != "" {
		fmt.Println()
		fmt.Println(triggerStyle.Render("▶ TRIGGER"))
		fmt.Println(strings.Repeat("─", 50))
		if triggerName != "" {
			fmt.Printf("  Name: %s\n", valueStyle.Render(triggerName))
		}
		if triggerType != "" {
			fmt.Printf("  Type: %s\n", mutedStyle.Render(titleCase(strings.ReplaceAll(triggerType, "_", " "))))
		}
		if triggerTable != "" {
			fmt.Printf("  Table: %s\n", valueStyle.Render(triggerTable))
		}
		if triggerTime != "" {
			fmt.Printf("  Time: %s\n", mutedStyle.Render(triggerTime))
		}
		if triggerCondition != "" {
			fmt.Printf("  Condition: %s\n", valueStyle.Render(formatTriggerCondition(triggerCondition)))
		}
	}

	// Flow structure section
	fmt.Println()
	fmt.Println(actionStyle.Render("⚡ FLOW STRUCTURE"))
	fmt.Println(strings.Repeat("─", 50))
	printFlowStructure(inspection, valueStyle, mutedStyle)

	fmt.Println()
	return nil
}

type flowStep struct {
	stepType string
	data     map[string]any
	order    int
}

func printFlowStructure(inspection *sdk.FlowInspection, valueStyle, mutedStyle lipgloss.Style) {
	payload := inspection.Payload
	if len(payload) > 0 {
		printFlowStructureFromPayload(payload, valueStyle, mutedStyle)
		return
	}
	printFlowStructureFallback(inspection, valueStyle)
}

func printFlowStructureFromPayload(payload map[string]any, valueStyle, mutedStyle lipgloss.Style) {
	childUIDs := make(map[string]bool)
	var markChildren func(items []any)
	markChildren = func(items []any) {
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			uid := getStringField(item, "uiUniqueIdentifier")
			if uid != "" {
				childUIDs[uid] = true
			}
			if block, ok := item["flowBlock"].([]any); ok && len(block) > 0 {
				markChildren(block)
			}
		}
	}

	if logicRaw, ok := payload["flowLogicInstances"].([]any); ok {
		for _, raw := range logicRaw {
			logic, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if block, ok := logic["flowBlock"].([]any); ok {
				markChildren(block)
			}
		}
	}

	var roots []flowStep
	for _, item := range mapSliceFromPayload(payload["actionInstances"]) {
		uid := getStringField(item, "uiUniqueIdentifier")
		if uid != "" && childUIDs[uid] {
			continue
		}
		roots = append(roots, flowStep{stepType: "action", data: item, order: parseOrderField(item)})
	}
	for _, item := range mapSliceFromPayload(payload["subFlowInstances"]) {
		uid := getStringField(item, "uiUniqueIdentifier")
		if uid != "" && childUIDs[uid] {
			continue
		}
		roots = append(roots, flowStep{stepType: "subflow", data: item, order: parseOrderField(item)})
	}
	for _, item := range mapSliceFromPayload(payload["flowLogicInstances"]) {
		uid := getStringField(item, "uiUniqueIdentifier")
		if uid != "" && childUIDs[uid] {
			continue
		}
		roots = append(roots, flowStep{stepType: "logic", data: item, order: parseOrderField(item)})
	}

	sort.Slice(roots, func(i, j int) bool { return roots[i].order < roots[j].order })

	stepNum := 1
	var walk func(steps []flowStep, indent int)
	walk = func(steps []flowStep, indent int) {
		for _, step := range steps {
			printStepLine(stepNum, indent, step, valueStyle, mutedStyle)
			stepNum++

			if step.stepType != "logic" {
				continue
			}
			block, ok := step.data["flowBlock"].([]any)
			if !ok || len(block) == 0 {
				continue
			}

			children := make([]flowStep, 0, len(block))
			for _, raw := range block {
				m, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				children = append(children, flowStep{
					stepType: classifyPayloadItem(m),
					data:     m,
					order:    parseOrderField(m),
				})
			}
			sort.Slice(children, func(i, j int) bool { return children[i].order < children[j].order })
			walk(children, indent+1)
		}
	}

	if len(roots) == 0 {
		fmt.Println("  (no steps found)")
		return
	}
	walk(roots, 0)
}

func printFlowStructureFallback(inspection *sdk.FlowInspection, valueStyle lipgloss.Style) {
	type simpleStep struct {
		order int
		text  string
	}

	steps := make([]simpleStep, 0, len(inspection.ActionInstances)+len(inspection.FlowLogicInstances)+len(inspection.SubFlowInstances))
	for _, action := range inspection.ActionInstances {
		name := firstNonEmpty(getNestedString(action, "action_type", "display_value"), getStringField(action, "name"), getStringField(action, "display_text"), "Action")
		steps = append(steps, simpleStep{order: parseOrderField(action), text: name})
	}
	for _, logic := range inspection.FlowLogicInstances {
		name := firstNonEmpty(getStringField(logic, "name"), getStringField(logic, "display_text"), "Logic")
		steps = append(steps, simpleStep{order: parseOrderField(logic), text: name})
	}
	for _, sf := range inspection.SubFlowInstances {
		name := firstNonEmpty(getStringField(sf, "name"), getStringField(sf, "display_text"), "Subflow")
		steps = append(steps, simpleStep{order: parseOrderField(sf), text: "↪ " + name})
	}

	sort.Slice(steps, func(i, j int) bool { return steps[i].order < steps[j].order })
	if len(steps) == 0 {
		fmt.Println("  (no steps found)")
		return
	}
	for i, step := range steps {
		fmt.Printf("%d. %s\n", i+1, valueStyle.Render(step.text))
	}
}

func printStepLine(stepNum, indent int, step flowStep, valueStyle, mutedStyle lipgloss.Style) {
	pad := strings.Repeat("    ", indent)
	switch step.stepType {
	case "logic":
		printLogicStepDetailed(stepNum, pad, step.data, valueStyle, mutedStyle)
	case "subflow":
		printSubFlowStepDetailed(stepNum, pad, step.data, valueStyle, mutedStyle)
	default:
		printActionStepDetailed(stepNum, pad, step.data, valueStyle, mutedStyle)
	}
}

func printActionStepDetailed(stepNum int, pad string, action map[string]any, valueStyle, mutedStyle lipgloss.Style) {
	actionName := firstNonEmpty(
		getNestedString(action, "actionType", "fName"),
		getStringField(action, "actionName"),
		getStringField(action, "actionInternalName"),
		getStringField(action, "name"),
		"Unknown Action",
	)

	if idx := strings.Index(actionName, " : "); idx > 0 {
		actionName = strings.TrimSpace(actionName[idx+3:])
	}

	tableName := ""
	if inputs, ok := action["inputs"].([]any); ok {
		for _, raw := range inputs {
			input, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if getStringField(input, "name") == "table_name" {
				tableName = firstNonEmpty(getStringField(input, "displayValue"), getStringField(input, "value"))
				break
			}
		}
	}

	actionDisplay := actionName
	if tableName != "" && actionName == "Update Record" {
		actionDisplay = actionName + " - " + tableName
	}

	comment := firstNonEmpty(getStringField(action, "comment"), getStringField(action, "displayText"))
	if comment != "" {
		fmt.Printf("%s%d. %s (%s)\n", pad, stepNum, valueStyle.Render(actionDisplay), mutedStyle.Render(comment))
	} else {
		fmt.Printf("%s%d. %s\n", pad, stepNum, valueStyle.Render(actionDisplay))
	}

	if inputs, ok := action["inputs"].([]any); ok {
		for _, raw := range inputs {
			input, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			inputName := getStringField(input, "name")
			if inputName == "table_name" {
				continue
			}

			inputValue := firstNonEmpty(getStringField(input, "displayValue"), getStringField(input, "value"))
			if inputValue == "" {
				continue
			}
			if len(inputValue) > 50 {
				inputValue = inputValue[:47] + "..."
			}

			label := inputName
			if param, ok := input["parameter"].(map[string]any); ok {
				label = firstNonEmpty(getStringField(param, "label"), label)
			}

			fmt.Printf("%s    %s: %s\n", pad, mutedStyle.Render(label), valueStyle.Render(inputValue))
		}
	}
}

func printSubFlowStepDetailed(stepNum int, pad string, subFlow map[string]any, valueStyle, mutedStyle lipgloss.Style) {
	subFlowName := firstNonEmpty(
		getNestedString(subFlow, "subFlowType", "fName"),
		getStringField(subFlow, "subFlowName"),
		getStringField(subFlow, "subFlowInternalName"),
		getNestedString(subFlow, "subFlow", "name"),
		getStringField(subFlow, "name"),
		"Unknown Subflow",
	)

	comment := getStringField(subFlow, "comment")
	if comment != "" {
		fmt.Printf("%s%d. %s (%s)\n", pad, stepNum, valueStyle.Render("↪ "+subFlowName), mutedStyle.Render(comment))
	} else {
		fmt.Printf("%s%d. %s\n", pad, stepNum, valueStyle.Render("↪ "+subFlowName))
	}

	fmt.Printf("%s   %s\n", pad, mutedStyle.Render(fmt.Sprintf("jsn flows \"%s\"", subFlowName)))
}

func printLogicStepDetailed(stepNum int, pad string, logic map[string]any, valueStyle, mutedStyle lipgloss.Style) {
	logicType := firstNonEmpty(getNestedString(logic, "flowLogicDefinition", "name"), getStringField(logic, "name"), "Logic Step")

	comment := getStringField(logic, "comment")
	condition := ""
	conditionLabel := ""
	if logicType == "If" || logicType == "Else If" {
		if inputs, ok := logic["inputs"].([]any); ok {
			for _, raw := range inputs {
				input, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				inputName := getStringField(input, "name")
				if inputName == "condition" {
					condition = firstNonEmpty(getStringField(input, "displayValue"), getStringField(input, "value"))
				}
				if inputName == "condition_name" {
					conditionLabel = firstNonEmpty(getStringField(input, "displayValue"), getStringField(input, "value"))
				}
			}
		}
	}

	displayText := logicType
	if conditionLabel != "" {
		displayText = logicType + ": " + conditionLabel
	} else if condition != "" && len(condition) < 60 {
		displayText = logicType + ": " + condition
	}

	fmt.Printf("%s%d. %s\n", pad, stepNum, valueStyle.Render(displayText))

	if condition != "" && len(condition) >= 60 && conditionLabel == "" {
		fmt.Printf("%s   %s: %s\n", pad, mutedStyle.Render("Condition"), valueStyle.Render(condition))
	}
	if comment != "" {
		fmt.Printf("%s   %s: %s\n", pad, mutedStyle.Render("Annotation"), valueStyle.Render(comment))
	}

	if logicType == "Set Flow Variables" {
		if flowVars, ok := logic["flowVariables"].([]any); ok && len(flowVars) > 0 {
			fmt.Printf("%s   %s:\n", pad, mutedStyle.Render("Variables Set"))
			for _, raw := range flowVars {
				fvMap, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				varName := getStringField(fvMap, "name")
				varValue := firstNonEmpty(getStringField(fvMap, "displayValue"), getStringField(fvMap, "value"))
				if varName == "" {
					continue
				}
				if varValue != "" {
					fmt.Printf("%s     • %s = %s\n", pad, varName, valueStyle.Render(varValue))
				} else {
					fmt.Printf("%s     • %s\n", pad, varName)
				}
			}
		}
	}
}

func classifyPayloadItem(m map[string]any) string {
	if _, ok := m["flowLogicDefinition"]; ok {
		return "logic"
	}
	if _, ok := m["subFlowType"]; ok {
		return "subflow"
	}
	if _, ok := m["subflowSysId"]; ok {
		return "subflow"
	}
	if _, ok := m["subFlow"]; ok {
		return "subflow"
	}
	return "action"
}

func extractTriggerDetails(inspection *sdk.FlowInspection) (name, triggerType, table, timeValue, condition string) {
	if inspection.Version != nil {
		name = getStringField(inspection.Version, "trigger_name")
		triggerType = getStringField(inspection.Version, "trigger_type")
		table = getStringField(inspection.Version, "trigger_table")
		timeValue = getStringField(inspection.Version, "trigger_time")
	}

	if (name == "" || triggerType == "" || table == "" || timeValue == "" || condition == "") && len(inspection.Payload) > 0 {
		if triggers, ok := inspection.Payload["triggerInstances"].([]any); ok && len(triggers) > 0 {
			if trigger, ok := triggers[0].(map[string]any); ok {
				name = firstNonEmpty(name, getStringField(trigger, "name"))
				triggerType = firstNonEmpty(triggerType, getStringField(trigger, "type"))
				for _, in := range mapSliceFromPayload(trigger["inputs"]) {
					k := getStringField(in, "name")
					v := firstNonEmpty(getStringField(in, "displayValue"), getStringField(in, "value"))
					switch k {
					case "table":
						table = firstNonEmpty(table, v)
					case "time":
						timeValue = firstNonEmpty(timeValue, v)
					case "condition":
						condition = firstNonEmpty(condition, v)
					}
				}
			}
		}
	}

	if name == "" && len(inspection.TriggerInstances) > 0 {
		first := inspection.TriggerInstances[0]
		name = firstNonEmpty(name, getStringField(first, "name"), getStringField(first, "display_text"))
		triggerType = firstNonEmpty(triggerType, getStringField(first, "trigger_type"))
	}

	if strings.Contains(timeValue, " ") {
		parts := strings.Split(timeValue, " ")
		if len(parts) == 2 {
			timeValue = parts[1]
		}
	}

	return
}

func inferFlowVersion(inspection *sdk.FlowInspection) string {
	if len(inspection.Payload) > 0 {
		return "Unset (Assumed V1)"
	}
	if len(inspection.ActionInstances) > 0 {
		return "Unset (Assumed V1)"
	}
	return "Unset"
}

func mapSliceFromPayload(v any) []map[string]any {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func parseOrderField(record map[string]any) int {
	order := getStringField(record, "order")
	n, _ := strconv.Atoi(order)
	return n
}

func getNestedString(record map[string]any, parent, field string) string {
	node, ok := record[parent].(map[string]any)
	if !ok {
		return ""
	}
	return getStringField(node, field)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		if len(w) == 0 {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

func formatTriggerCondition(condition string) string {
	if condition == "" {
		return ""
	}

	result := condition
	result = strings.ReplaceAll(result, "^OR", " OR ")
	result = strings.ReplaceAll(result, "^", " AND ")
	result = strings.ReplaceAll(result, "!=", " != ")
	result = strings.ReplaceAll(result, ">=", " >= ")
	result = strings.ReplaceAll(result, "<=", " <= ")
	result = strings.ReplaceAll(result, "=", " = ")
	result = strings.ReplaceAll(result, ">", " > ")
	result = strings.ReplaceAll(result, "<", " < ")
	result = strings.ReplaceAll(result, "LIKE", " LIKE ")

	for strings.Contains(result, "  ") {
		result = strings.ReplaceAll(result, "  ", " ")
	}

	return strings.TrimSpace(result)
}

// formatFlowForDisplay formats a flow record for display
func formatFlowForDisplay(record map[string]any, columns []string) map[string]string {
	result := make(map[string]string)

	// Always include sys_id for hyperlinks
	if sysID, ok := record["sys_id"]; ok && sysID != nil {
		switch v := sysID.(type) {
		case string:
			result["sys_id"] = v
		case map[string]any:
			if value, ok := v["value"].(string); ok && value != "" {
				result["sys_id"] = value
			} else if display, ok := v["display_value"].(string); ok {
				result["sys_id"] = display
			} else {
				result["sys_id"] = fmt.Sprintf("%v", v)
			}
		default:
			result["sys_id"] = fmt.Sprintf("%v", sysID)
		}
	}

	for _, col := range columns {
		if val, ok := record[col]; ok && val != nil {
			switch v := val.(type) {
			case string:
				result[col] = v
			case map[string]any:
				// Handle display value objects from sysparm_display_value=true
				if display, ok := v["display_value"].(string); ok {
					result[col] = display
				} else if value, ok := v["value"].(string); ok {
					result[col] = value
				} else {
					result[col] = fmt.Sprintf("%v", v)
				}
			case bool:
				result[col] = fmt.Sprintf("%t", v)
			default:
				result[col] = fmt.Sprintf("%v", v)
			}
		} else {
			result[col] = ""
		}
	}
	return result
}

// getFlowStringField safely extracts a string field from a flow record
func getFlowStringField(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects
			if display, ok := v["display_value"].(string); ok {
				return display
			}
			if value, ok := v["value"].(string); ok {
				return value
			}
		}
		return fmt.Sprintf("%v", val)
	}
	return ""
}

// --- Stub functions for future Flow Designer API integration ---

// GetFlowDefinition retrieves the full flow definition including actions and connections
// TODO: Implement using Flow Designer API when available
func GetFlowDefinition(ctx context.Context, app *appctx.App, flowSysID string) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	// This will use the dedicated Flow Designer API endpoints instead of Table API
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// PublishFlow publishes a flow from draft to published state
// TODO: Implement using Flow Designer API when available
func PublishFlow(ctx context.Context, app *appctx.App, flowSysID string) error {
	// Placeholder for Flow Designer API integration
	return fmt.Errorf("Flow Designer API integration not yet implemented")
}

// CreateFlow creates a new flow from a definition
// TODO: Implement using Flow Designer API when available
func CreateFlow(ctx context.Context, app *appctx.App, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// UpdateFlow updates an existing flow's definition
// TODO: Implement using Flow Designer API when available
func UpdateFlow(ctx context.Context, app *appctx.App, flowSysID string, definition map[string]any) (map[string]any, error) {
	// Placeholder for Flow Designer API integration
	return nil, fmt.Errorf("Flow Designer API integration not yet implemented")
}

// DeleteFlow deletes a flow by sys_id
// TODO: Implement using Flow Designer API when available
func DeleteFlow(ctx context.Context, app *appctx.App, flowSysID string) error {
	// Placeholder for Flow Designer API integration
	return fmt.Errorf("Flow Designer API integration not yet implemented")
}
