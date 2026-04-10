package sdk

import (
	"context"
	"fmt"
	"strings"
)

// AddFlowLogicOptions holds options for adding a logic block to a flow.
type AddFlowLogicOptions struct {
	FlowID    string // Flow sys_id or name
	LogicType string // Logic type: if, else, foreach
	Condition string // Condition for If blocks
	Label     string // Label/Name for the condition
	Order     string // Execution order (1, 2, 3, etc.)
}

// AddFlowLogicResult holds the result of adding a logic block.
type AddFlowLogicResult struct {
	UIUniqueIdentifier string // The UI unique ID of the created logic block
	SysID              string // The sys_id of the created logic block
}

// AddFlowLogic adds a logic block (If, Else, For Each) to a flow using the GraphQL API.
// Returns the UI unique identifier of the created logic block, which can be used as parentUiId for nested actions.
func (c *Client) AddFlowLogic(ctx context.Context, opts AddFlowLogicOptions) (*AddFlowLogicResult, error) {
	if opts.FlowID == "" {
		return nil, fmt.Errorf("flow ID is required")
	}
	if opts.LogicType == "" {
		return nil, fmt.Errorf("logic type is required")
	}

	// Get logic definition ID
	logicDefID, ok := flowLogicDefinitionIDs[opts.LogicType]
	if !ok {
		return nil, fmt.Errorf("unsupported logic type: %s", opts.LogicType)
	}

	// Resolve flow sys_id
	flowSysID, err := c.resolveFlowID(ctx, opts.FlowID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Get current user for safe edit lock
	userSysID, err := c.getCurrentUserSysID(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get current user: %w", err)
	}

	// Acquire safe edit lock
	safeEditResp, err := c.Post(ctx, "sys_hub_flow_safe_edit", map[string]interface{}{
		"flow": flowSysID,
		"user": userSysID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to acquire safe edit lock: %w", err)
	}
	safeEditID := getString(safeEditResp.Result, "sys_id")
	defer func() {
		if safeEditID != "" {
			_ = c.Delete(ctx, "sys_hub_flow_safe_edit", safeEditID)
		}
	}()

	// Generate UI unique ID for this logic instance
	uiUniqueID := generateUIUniqueID()

	// Build and execute GraphQL mutation based on logic type
	var mutation string
	switch opts.LogicType {
	case "if":
		mutation = buildIfLogicInsertMutation(flowSysID, logicDefID, opts.Condition, opts.Label, uiUniqueID, opts.Order)
	case "else":
		mutation = buildElseLogicInsertMutation(flowSysID, logicDefID, uiUniqueID, opts.Order)
	case "foreach":
		return nil, fmt.Errorf("foreach logic not yet implemented")
	default:
		return nil, fmt.Errorf("unsupported logic type: %s", opts.LogicType)
	}

	body := map[string]interface{}{
		"variables": map[string]interface{}{},
		"query":     mutation,
	}

	result, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", body, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to execute GraphQL mutation: %w", err)
	}
	if statusCode != 200 {
		return nil, fmt.Errorf("GraphQL request failed with status %d", statusCode)
	}

	// Check for GraphQL errors
	if resultMap, ok := result.(map[string]interface{}); ok {
		if errors, hasErrors := resultMap["errors"]; hasErrors {
			if errList, ok := errors.([]interface{}); ok && len(errList) > 0 {
				if firstErr, ok := errList[0].(map[string]interface{}); ok {
					return nil, fmt.Errorf("GraphQL error: %s", getString(firstErr, "message"))
				}
			}
		}
	}

	return &AddFlowLogicResult{
		UIUniqueIdentifier: uiUniqueID,
	}, nil
}

// buildIfLogicInsertMutation builds the GraphQL mutation for inserting an If logic block.
func buildIfLogicInsertMutation(flowSysID, logicDefID, condition, label, uiUniqueID, order string) string {
	// Escape special characters in condition for GraphQL
	conditionEscaped := strings.ReplaceAll(condition, `"`, `\"`)
	labelEscaped := strings.ReplaceAll(label, `"`, `\"`)

	// Default order to "1" if not specified
	orderValue := order
	if orderValue == "" {
		orderValue = "1"
	}

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", flowLogics: {insert: [{order: "%s", uiUniqueIdentifier: "%s", parent: "", metadata: "{\"predicates\":[]}", flowSysId: "%s", generationSource: "", definitionId: "%s", type: "flowlogic", parentUiId: "", inputs: [{id: "f0af19c1c32632002841b63b12d3aea3", name: "condition_name", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "f0af19c1c32632002841b63b12d3aea3", label: "Condition Label", name: "condition_name", type: "string", type_label: "String", hint: "", order: 10, extended: false, mandatory: false, readonly: false, maxsize: 255, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,use_basic_input=true,", sys_class_name: "", children: []}}, {id: "9a5f5105c32632002841b63b12d3ae46", name: "condition", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "9a5f5105c32632002841b63b12d3ae46", label: "Condition", name: "condition", type: "string", type_label: "String", hint: "", order: 20, extended: false, mandatory: true, readonly: false, maxsize: 2000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,is_scriptable=false,", sys_class_name: "", children: []}}], outputsToAssign: [], flowLogicDefinition: {id: "%s", name: "If", description: "Selectively apply one or more actions only when a list of conditions is met.", connectedTo: "", quiescence: "never", compilationClass: "com.glide.flow.compiler.logic_block.IfCompiler", order: 1, type: "IF", visible: true, attributes: "allow_children=true,allow_siblings=true,icon_class=if-icon,line_type=q_if_curve,pills_draggable_outside_block=false,", userCanRead: true, category: "", inputs: [{id: "f0af19c1c32632002841b63b12d3aea3", label: "Condition Label", name: "condition_name", type: "string", type_label: "String", hint: "", order: 10, extended: false, mandatory: false, readonly: false, maxsize: 255, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,use_basic_input=true,", sys_class_name: "", children: []}, {id: "9a5f5105c32632002841b63b12d3ae46", label: "Condition", name: "condition", type: "string", type_label: "String", hint: "", order: 20, extended: false, mandatory: true, readonly: false, maxsize: 2000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,is_scriptable=false,", sys_class_name: "", children: []}], variables: "[]"}}]}}) {
        id
        flowLogics {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, orderValue, uiUniqueID, flowSysID, logicDefID, labelEscaped, conditionEscaped, logicDefID)
}

// buildElseLogicInsertMutation builds the GraphQL mutation for inserting an Else logic block.
func buildElseLogicInsertMutation(flowSysID, logicDefID, uiUniqueID, order string) string {
	// Default order to "1" if not specified
	orderValue := order
	if orderValue == "" {
		orderValue = "1"
	}

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", flowLogics: {insert: [{order: "%s", uiUniqueIdentifier: "%s", parent: "", metadata: "{\"predicates\":[]}", flowSysId: "%s", generationSource: "", definitionId: "%s", type: "flowlogic", parentUiId: "", inputs: [], outputsToAssign: [], flowLogicDefinition: {id: "%s", name: "Else", description: "Else statement", connectedTo: "", quiescence: "never", compilationClass: "com.glide.flow.compiler.logic_block.ElseCompiler", order: 3, type: "ELSE", visible: true, attributes: "allow_children=true,allow_siblings=true,disable_opening=true,icon_class=else-icon,line_type=q_if_curve,pills_draggable_outside_block=false,", userCanRead: true, category: "", inputs: [], variables: "[]"}}]}}) {
        id
        flowLogics {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, orderValue, uiUniqueID, flowSysID, logicDefID, logicDefID)
}
