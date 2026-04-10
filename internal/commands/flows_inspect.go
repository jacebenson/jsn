package commands

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

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

	// Infer version if not set
	versionDisplay := inspection.Flow.Version
	if versionDisplay == "" {
		// Infer based on action instance types
		hasV1 := len(inspection.ActionInstances) > 0
		hasV2 := len(inspection.ActionInstancesV2) > 0
		if hasV2 && !hasV1 {
			versionDisplay = "Unset (Assumed V2)"
		} else if hasV1 && !hasV2 {
			versionDisplay = "Unset (Assumed V1)"
		} else if hasV1 && hasV2 {
			versionDisplay = "Unset (Mixed V1/V2)"
		} else {
			versionDisplay = "Unset"
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  Status: %s | Version: %s\n", valueStyle.Render(status), mutedStyle.Render(versionDisplay))
	fmt.Fprintf(cmd.OutOrStdout(), "  Sys ID: %s\n", mutedStyle.Render(inspection.Flow.SysID))

	// Show link if available
	if instanceURL != "" {
		flowURL := fmt.Sprintf("%s/sys_hub_flow.do?sys_id=%s", instanceURL, inspection.Flow.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "  Link: %s\n", linkStyle.Render(flowURL))
	}

	// Show Inputs/Outputs section only for subflows
	isSubflow := strings.EqualFold(inspection.Flow.Type, "subflow")
	if isSubflow {
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
		if len(inspection.FlowOutputs) > 0 {
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

		// Display trigger condition from payload if available
		if len(inspection.Version) > 0 {
			if payload, ok := inspection.Version["payload"].(string); ok && payload != "" {
				var payloadData map[string]interface{}
				if err := json.Unmarshal([]byte(payload), &payloadData); err == nil {
					if triggerInstances, ok := payloadData["triggerInstances"].([]interface{}); ok && len(triggerInstances) > 0 {
						if trigger, ok := triggerInstances[0].(map[string]interface{}); ok {
							if inputs, ok := trigger["inputs"].([]interface{}); ok {
								for _, input := range inputs {
									if inputMap, ok := input.(map[string]interface{}); ok {
										if name := getString(inputMap, "name"); name == "condition" {
											conditionValue := getString(inputMap, "value")
											if conditionValue != "" {
												// Format the condition for display
												formattedCondition := formatTriggerCondition(conditionValue)
												fmt.Fprintf(cmd.OutOrStdout(), "  %s: %s\n", mutedStyle.Render("Condition"), valueStyle.Render(formattedCondition))
											}
											break
										}
									}
								}
							}
						}
					}
				}
			}
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
					fmt.Fprintf(cmd.OutOrStdout(), "   %s\n", mutedStyle.Render(fmt.Sprintf("jsn flows \"%s\"", step.name)))
				}
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

	// Strip flow name prefix from action names (e.g., "Software Procurement Flow : Add work notes" -> "Add work notes")
	if idx := strings.Index(actionName, " : "); idx > 0 {
		actionName = strings.TrimSpace(actionName[idx+3:])
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

	// Print input mappings if available (from V1 payload)
	if inputs, ok := action["inputs"].([]interface{}); ok && len(inputs) > 0 {
		for _, input := range inputs {
			if inputMap, ok := input.(map[string]interface{}); ok {
				inputName := getString(inputMap, "name")
				inputValue := getString(inputMap, "value")
				inputDisplay := getString(inputMap, "displayValue")

				// Skip empty values or template variables that aren't set
				if inputValue == "" && inputDisplay == "" {
					continue
				}

				// Get the label from parameter if available
				label := inputName
				if param, ok := inputMap["parameter"].(map[string]interface{}); ok {
					if paramLabel := getString(param, "label"); paramLabel != "" {
						label = paramLabel
					}
				}

				// Format the value for display
				displayValue := inputDisplay
				if displayValue == "" {
					displayValue = inputValue
				}

				// Truncate if too long
				if len(displayValue) > 50 {
					displayValue = displayValue[:47] + "..."
				}

				// Skip table_name as it's already shown in the action header
				if inputName == "table_name" {
					continue
				}

				// Print the input mapping with extra indentation
				fmt.Fprintf(cmd.OutOrStdout(), "%s    %s: %s\n", pad, mutedStyle.Render(label), valueStyle.Render(displayValue))
			}
		}
	}

	// Print input mappings from V2 values_decompressed if available
	if valuesDecompressed, ok := action["values_decompressed"].([]map[string]interface{}); ok && len(valuesDecompressed) > 0 {
		for _, inputMap := range valuesDecompressed {
			inputName := getString(inputMap, "name")
			inputValue := getString(inputMap, "value")
			inputDisplay := getString(inputMap, "displayValue")

			// Skip empty values
			if inputValue == "" && inputDisplay == "" {
				continue
			}

			// Get the label from parameter if available
			label := inputName
			if param, ok := inputMap["parameter"].(map[string]interface{}); ok {
				if paramLabel := getString(param, "label"); paramLabel != "" {
					label = paramLabel
				}
			}

			// Format the value for display
			displayValue := inputDisplay
			if displayValue == "" {
				displayValue = inputValue
			}

			// Truncate if too long
			if len(displayValue) > 50 {
				displayValue = displayValue[:47] + "..."
			}

			// Skip certain internal fields
			if inputName == "table_name" || inputName == "request_item_id" {
				continue
			}

			// Print the input mapping with extra indentation
			fmt.Fprintf(cmd.OutOrStdout(), "%s    %s: %s\n", pad, mutedStyle.Render(label), valueStyle.Render(displayValue))
		}
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
	fmt.Fprintf(cmd.OutOrStdout(), "%s   %s\n", pad, mutedStyle.Render(fmt.Sprintf("jsn flows \"%s\"", subFlowName)))
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

	if isSubflow && len(inspection.FlowOutputs) > 0 {
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
