package sdk

import (
	"context"
	"encoding/base64"
	"fmt"
)

// AddFlowVariableOptions holds options for adding a flow variable via GraphQL.
type AddFlowVariableOptions struct {
	FlowID       string // Flow sys_id or name
	Name         string // Variable name (e.g., "day_of_week")
	Label        string // Display label (e.g., "Day of Week")
	Type         string // Variable type: string, integer, boolean, reference, choice
	Mandatory    bool   // Is the variable required
	DefaultValue string // Default value
}

// AddFlowVariable adds a variable to a flow using GraphQL.
// This creates both the flow variable and its label cache entry for pill references.
func (c *Client) AddFlowVariable(ctx context.Context, opts AddFlowVariableOptions) (*FlowVariable, error) {
	if opts.FlowID == "" {
		return nil, fmt.Errorf("flow ID is required")
	}
	if opts.Name == "" {
		return nil, fmt.Errorf("variable name is required")
	}
	if opts.Type == "" {
		return nil, fmt.Errorf("variable type is required")
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

	// Generate UI unique ID for this variable
	uiUniqueID := generateUIUniqueID()

	// Build label from name if not provided
	label := opts.Label
	if label == "" {
		label = opts.Name
	}

	// Build GraphQL mutation
	mutation := buildAddFlowVariableMutation(flowSysID, opts.Name, label, opts.Type, opts.Mandatory, opts.DefaultValue, uiUniqueID)

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

	return &FlowVariable{
		SysID: uiUniqueID, // Use UI unique ID as sys_id for now
		Name:  opts.Name,
		Label: label,
		Type:  opts.Type,
		Value: opts.DefaultValue,
	}, nil
}

// buildAddFlowVariableMutation builds the GraphQL mutation for adding a flow variable.
func buildAddFlowVariableMutation(flowSysID, name, label, varType string, mandatory bool, defaultValue, uiUniqueID string) string {
	mandatoryStr := "false"
	if mandatory {
		mandatoryStr = "true"
	}

	// Build label cache entry name
	labelCacheName := fmt.Sprintf("flow_variable.%s", name)

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", flowVariables: {insert: [{label: "%s", name: "%s", type: "%s", type_label: "%s", order: 1, mandatory: %s, readonly: false, defaultValue: "%s", attributes: "sourceUiUniqueId=,sourceType=,sourceId=,uiUniqueId=%s,", uiDisplayType: "%s", uiDisplayTypeLabel: "%s"}]}, labelCache: {insert: [{name: "%s", label: "Flow Variables➛%s", type: "%s", base_type: "%s", attributes: "sourceUiUniqueId=,sourceType=,sourceId=,uiUniqueId=%s,"}]}}) {
        id
        flowVariables {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, label, name, varType, varType, mandatoryStr, defaultValue, uiUniqueID, varType, varType, labelCacheName, label, varType, varType, uiUniqueID)
}

// AddSetFlowVariablesOptions holds options for adding a "Set Flow Variables" action.
type AddSetFlowVariablesOptions struct {
	FlowID   string            // Flow sys_id or name
	Variable string            // Variable name to set
	Script   string            // JavaScript to calculate the value
	Inputs   map[string]string // Additional inputs
	Order    string            // Execution order (1, 2, 3, etc.)
}

// AddSetFlowVariables adds a "Set Flow Variables" action to populate flow variables.
// This is the action type needed to calculate values like day of week.
func (c *Client) AddSetFlowVariables(ctx context.Context, opts AddSetFlowVariablesOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.Variable == "" {
		return fmt.Errorf("variable name is required")
	}

	// Resolve flow sys_id
	flowSysID, err := c.resolveFlowID(ctx, opts.FlowID)
	if err != nil {
		return fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Get current user for safe edit lock
	userSysID, err := c.getCurrentUserSysID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Acquire safe edit lock
	safeEditResp, err := c.Post(ctx, "sys_hub_flow_safe_edit", map[string]interface{}{
		"flow": flowSysID,
		"user": userSysID,
	})
	if err != nil {
		return fmt.Errorf("failed to acquire safe edit lock: %w", err)
	}
	safeEditID := getString(safeEditResp.Result, "sys_id")
	defer func() {
		if safeEditID != "" {
			_ = c.Delete(ctx, "sys_hub_flow_safe_edit", safeEditID)
		}
	}()

	// Generate UI unique ID
	uiUniqueID := generateUIUniqueID()

	// Encode script as base64 if provided
	encodedScript := ""
	if opts.Script != "" {
		encodedScript = base64.StdEncoding.EncodeToString([]byte(opts.Script))
	}

	// Build mutation
	mutation := buildSetFlowVariablesMutation(flowSysID, opts.Variable, encodedScript, uiUniqueID, opts.Order)

	body := map[string]interface{}{
		"variables": map[string]interface{}{},
		"query":     mutation,
	}

	result, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", body, nil)
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL mutation: %w", err)
	}
	if statusCode != 200 {
		return fmt.Errorf("GraphQL request failed with status %d", statusCode)
	}

	// Check for GraphQL errors
	if resultMap, ok := result.(map[string]interface{}); ok {
		if errors, hasErrors := resultMap["errors"]; hasErrors {
			if errList, ok := errors.([]interface{}); ok && len(errList) > 0 {
				if firstErr, ok := errList[0].(map[string]interface{}); ok {
					return fmt.Errorf("GraphQL error: %s", getString(firstErr, "message"))
				}
			}
		}
	}

	return nil
}

// buildSetFlowVariablesMutation builds the GraphQL mutation for Set Flow Variables action.
func buildSetFlowVariablesMutation(flowSysID, variable, encodedScript, uiUniqueID, order string) string {
	// Default order to "1" if not specified
	orderValue := order
	if orderValue == "" {
		orderValue = "1"
	}

	// This uses definitionId "4f787d1e0f9b0010ecf0cc52ff767ea0" for Set Flow Variables (updated from HAR)
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", flowLogics: {insert: [{order: "%s", uiUniqueIdentifier: "%s", parent: "", metadata: "{\"predicates\":[]}", flowSysId: "%s", generationSource: "", definitionId: "4f787d1e0f9b0010ecf0cc52ff767ea0", type: "flowlogic", parentUiId: "", inputs: [{id: "", name: "%s", children: [], displayValue: {value: ""}, value: {value: ""}}], flowVariables: [{id: "", name: "%s", scriptActive: true, children: [], displayValue: {value: ""}, value: {value: ""}, script: [{inputName: "%s", scriptActive: true, showScript: true, encodedScript: "%s"}]}]}]}}) {
        id
        flowLogics {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, orderValue, uiUniqueID, flowSysID, variable, variable, variable, encodedScript)
}

// PillReference creates a pill reference string for use in conditions.
// Example: PillReference("flow_variable", "day_of_week") returns "{{flow_variable.day_of_week}}"
func PillReference(source, name string) string {
	return fmt.Sprintf("{{%s.%s}}", source, name)
}

// FlowVariablePill creates a pill reference to a flow variable.
// Example: FlowVariablePill("day_of_week") returns "{{flow_variable.day_of_week}}"
func FlowVariablePill(name string) string {
	return PillReference("flow_variable", name)
}

// TriggerPill creates a pill reference to a trigger field.
// Example: TriggerPill("current", "priority") returns "{{trigger.current.priority}}"
func TriggerPill(record, field string) string {
	return fmt.Sprintf("{{trigger.%s.%s}}", record, field)
}
