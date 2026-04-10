package sdk

import (
	"context"
	"fmt"
	"time"
)

// AddFlowActionOptions holds options for adding an action to a flow.
type AddFlowActionOptions struct {
	FlowID     string            // Flow sys_id or name
	ActionType string            // Action type: create_record, update_record, delete_record, lookup_record, log
	Table      string            // Table name (for create, update, delete, lookup)
	Inputs     map[string]string // Additional input values (field=value pairs)
	ParentUIID string            // Parent logic block UI ID for nested actions
	Order      string            // Execution order (1, 2, 3, etc.)
}

// AddFlowAction adds an action to a flow using the GraphQL API.
// This follows the same pattern as triggers - acquire safe edit lock, execute mutation, release lock.
func (c *Client) AddFlowAction(ctx context.Context, opts AddFlowActionOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.ActionType == "" {
		return fmt.Errorf("action type is required")
	}

	// Get action type sys_id
	actionTypeSysID, ok := actionTypeSysIDs[opts.ActionType]
	if !ok {
		return fmt.Errorf("unsupported action type: %s", opts.ActionType)
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

	// Build and execute GraphQL mutation
	mutation := buildActionInsertMutation(flowSysID, actionTypeSysID, opts.ActionType, opts.Table, opts.Inputs, opts.ParentUIID, opts.Order)

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

	// If inputs were provided, do a separate UPDATE mutation to set the values
	// (The UI does this in two steps - INSERT empty, then UPDATE with values)
	if len(opts.Inputs) > 0 {
		// Extract the new action's UI ID from the insert result
		if actionResult, ok := result.(map[string]interface{}); ok {
			if data, ok := actionResult["data"].(map[string]interface{}); ok {
				if global, ok := data["global"].(map[string]interface{}); ok {
					if snFD, ok := global["snFlowDesigner"].(map[string]interface{}); ok {
						if flow, ok := snFD["flow"].(map[string]interface{}); ok {
							if actions, ok := flow["actions"].(map[string]interface{}); ok {
								if inserts, ok := actions["inserts"].([]interface{}); ok && len(inserts) > 0 {
									if firstInsert, ok := inserts[0].(map[string]interface{}); ok {
										uiUniqueID := getString(firstInsert, "uiUniqueIdentifier")
										if uiUniqueID != "" {
											// Now UPDATE the action with the actual values
											updateMutation := buildActionUpdateMutation(flowSysID, uiUniqueID, opts.ActionType, opts.Table, opts.Inputs)
											updateBody := map[string]interface{}{
												"variables": map[string]interface{}{},
												"query":     updateMutation,
											}
											_, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", updateBody, nil)
											if err != nil {
												return fmt.Errorf("failed to update action values: %w", err)
											}
											if statusCode != 200 {
												return fmt.Errorf("action update request failed with status %d", statusCode)
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
	}

	return nil
}

// buildActionUpdateMutation builds a GraphQL mutation to UPDATE action input values.
// This is called after INSERT to set the actual values (UI pattern: INSERT empty, then UPDATE with values).
func buildActionUpdateMutation(flowSysID, uiUniqueIdentifier, actionType, table string, inputs map[string]string) string {
	// Build inputs array based on action type
	var inputsJSON string
	switch actionType {
	case "update_record":
		inputsJSON = buildUpdateRecordInputsUpdate(table, inputs)
	case "create_record":
		inputsJSON = buildCreateRecordInputsUpdate(inputs)
	case "log":
		inputsJSON = buildLogInputsUpdate(inputs)
	default:
		inputsJSON = "[]"
	}

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", actions: {update: [{uiUniqueIdentifier: "%s", type: "action", inputs: %s}]}}) {
        id
        actions {
          updates
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, uiUniqueIdentifier, inputsJSON)
}

// buildUpdateRecordInputsUpdate builds the inputs JSON for updating an Update Record action.
func buildUpdateRecordInputsUpdate(table string, inputs map[string]string) string {
	tableValue := table
	if tableValue == "" {
		tableValue = "incident"
	}

	recordValue := ""
	if rv, ok := inputs["record"]; ok {
		recordValue = rv
	}

	valuesValue := ""
	if vv, ok := inputs["values"]; ok {
		valuesValue = vv
	}

	// Also check for "fields" as alternative (common mistake)
	if valuesValue == "" {
		if fv, ok := inputs["fields"]; ok {
			valuesValue = fv
		}
	}

	// Get display values (table name capitalized)
	tableDisplay := tableValue
	if tableDisplay == "incident" {
		tableDisplay = "Incident"
	}

	return fmt.Sprintf(`[{name: "record", value: {schemaless: false, schemalessValue: "", value: "%s"}}, {name: "table_name", displayValue: {schemaless: false, schemalessValue: "", value: "%s"}, value: {schemaless: false, schemalessValue: "", value: "%s"}}, {name: "values", value: {schemaless: false, schemalessValue: "", value: "%s"}}]`, recordValue, tableDisplay, tableValue, valuesValue)
}

// buildCreateRecordInputsUpdate builds inputs for updating a Create Record action
func buildCreateRecordInputsUpdate(inputs map[string]string) string {
	valuesValue := ""
	if vv, ok := inputs["values"]; ok {
		valuesValue = vv
	}
	if valuesValue == "" {
		if fv, ok := inputs["fields"]; ok {
			valuesValue = fv
		}
	}
	return fmt.Sprintf(`[{name: "values", value: {schemaless: false, schemalessValue: "", value: "%s"}}]`, valuesValue)
}

// buildLogInputsUpdate builds inputs for updating a Log action
func buildLogInputsUpdate(inputs map[string]string) string {
	messageValue := ""
	if mv, ok := inputs["message"]; ok {
		messageValue = mv
	}
	levelValue := "info"
	if lv, ok := inputs["level"]; ok {
		levelValue = lv
	}
	return fmt.Sprintf(`[{name: "log_level", value: "%s"}, {name: "log_message", value: {schemaless: false, schemalessValue: "", value: "%s"}}]`, levelValue, messageValue)
}

// buildActionInsertMutation builds the GraphQL mutation for inserting an action.
// This is a simplified mutation that inserts the action with basic configuration.
func buildActionInsertMutation(flowSysID, actionTypeSysID, actionType, table string, inputs map[string]string, parentUIID string, order string) string {
	// Generate a unique UI identifier for this action instance
	uiUniqueID := generateUIUniqueID()

	// Build inputs array based on action type
	var inputsJSON string
	switch actionType {
	case "create_record":
		inputsJSON = buildCreateRecordInputs(table, inputs)
	case "update_record":
		inputsJSON = buildUpdateRecordInputs(table, inputs)
	case "delete_record":
		inputsJSON = buildDeleteRecordInputs(table, inputs)
	case "lookup_record":
		inputsJSON = buildLookupRecordInputs(table, inputs)
	case "log":
		inputsJSON = buildLogInputs(inputs)
	default:
		inputsJSON = "[]"
	}

	// Use parent UI ID if provided for nested actions
	parentUIIDValue := ""
	if parentUIID != "" {
		parentUIIDValue = parentUIID
	}

	// Default order to "1" if not specified
	orderValue := order
	if orderValue == "" {
		orderValue = "1"
	}

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", actions: {insert: [{actionTypeSysId: "%s", metadata: "{\"predicates\":[]}", flowSysId: "%s", generationSource: "", order: "%s", parent: "%s", uiUniqueIdentifier: "%s", type: "action", parentUiId: "%s", inputs: %s}]}}) {
        id
        actions {
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
}`, flowSysID, actionTypeSysID, flowSysID, orderValue, parentUIIDValue, uiUniqueID, parentUIIDValue, inputsJSON)
}

// buildCreateRecordInputs builds the inputs JSON for a Create Record action.
func buildCreateRecordInputs(table string, inputs map[string]string) string {
	tableValue := table
	if tableValue == "" {
		tableValue = "incident"
	}

	fieldsValue := ""
	if fv, ok := inputs["fields"]; ok {
		fieldsValue = fv
	}

	return fmt.Sprintf(`[{id: "27575ae253b3230034c6ddeeff7b12f4", name: "table_name", children: [], displayValue: {schemaless: false, schemalessValue: "", value: "%s"}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "27575ae253b3230034c6ddeeff7b12f4", label: "Table Name", name: "table_name", type: "table_name", type_label: "Table Name", hint: "", order: 0, extended: false, mandatory: true, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "uiTypeLabel=true,element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,uiType=table_name,", sys_class_name: "", children: [], dynamic: null}}, {id: "2b575ae253b3230034c6ddeeff7b12fa", name: "fields", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "2b575ae253b3230034c6ddeeff7b12fa", label: "Fields", name: "fields", type: "template_value", type_label: "Template Value", hint: "", order: 1, extended: false, mandatory: true, readonly: false, maxsize: 65000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table_name", show_ref_finder: false, local: false, attributes: "uiTypeLabel=true,element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,upsert_action=true,uiType=template_value,", sys_class_name: "", children: [], dynamic: null}}]`, tableValue, tableValue, fieldsValue)
}

// buildUpdateRecordInputs builds the inputs JSON for an Update Record action.
// Values are set EMPTY on insert - the UPDATE mutation sets the actual values.
func buildUpdateRecordInputs(table string, inputs map[string]string) string {
	tableValue := table
	if tableValue == "" {
		tableValue = "incident"
	}

	// Insert with empty values - the actual values are set via UPDATE mutation
	return fmt.Sprintf(`[{id: "4ed01916c31332002841b63b12d3aee1", name: "record", children: [], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "4ed01916c31332002841b63b12d3aee1", label: "Record", name: "record", type: "document_id", type_label: "Document ID", hint: "", order: 10, extended: false, mandatory: true, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table_name", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}, {id: "b5d01916c31332002841b63b12d3aec9", name: "table_name", children: [], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "b5d01916c31332002841b63b12d3aec9", label: "Table", name: "table_name", type: "table_name", type_label: "Table Name", hint: "", order: 50, extended: false, mandatory: true, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}, {id: "02d01916c31332002841b63b12d3aeee", name: "values", children: [], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "02d01916c31332002841b63b12d3aeee", label: "Fields", name: "values", type: "template_value", type_label: "Template Value", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 16000000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table_name", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}]`)
}

// buildDeleteRecordInputs builds the inputs JSON for a Delete Record action.
func buildDeleteRecordInputs(table string, inputs map[string]string) string {
	tableValue := table
	if tableValue == "" {
		tableValue = "incident"
	}

	recordValue := ""
	if rv, ok := inputs["record"]; ok {
		recordValue = rv
	}

	return fmt.Sprintf(`[{id: "0be09916c31332002841b63b12d3aee1", name: "record", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "0be09916c31332002841b63b12d3aee1", label: "Record", name: "record", type: "document_id", type_label: "Document ID", hint: "", order: 0, extended: false, mandatory: true, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table_name", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}]`, recordValue)
}

// buildLookupRecordInputs builds the inputs JSON for a Look Up Record action.
func buildLookupRecordInputs(table string, inputs map[string]string) string {
	tableValue := table
	if tableValue == "" {
		tableValue = "incident"
	}

	conditionsValue := ""
	if cv, ok := inputs["conditions"]; ok {
		conditionsValue = cv
	}

	return fmt.Sprintf(`[{id: "8f400a1587003300663ca1bb36cb0b4b", name: "table", children: [], displayValue: {schemaless: false, schemalessValue: "", value: "%s"}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "8f400a1587003300663ca1bb36cb0b4b", label: "Table", name: "table", type: "table_name", type_label: "Table Name", hint: "", order: 0, extended: false, mandatory: false, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,filter_table_source=v_cluster_transaction,", sys_class_name: "", children: [], dynamic: null}}, {id: "8f400a1587003300663ca1bb36cb0b50", name: "conditions", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "8f400a1587003300663ca1bb36cb0b50", label: "Conditions", name: "conditions", type: "conditions", type_label: "Conditions", hint: "", order: 1, extended: false, mandatory: false, readonly: false, maxsize: 4000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}]`, tableValue, tableValue, conditionsValue)
}

// buildLogInputs builds the inputs JSON for a Log action.
func buildLogInputs(inputs map[string]string) string {
	messageValue := ""
	if mv, ok := inputs["message"]; ok {
		messageValue = mv
	}

	return fmt.Sprintf(`[{id: "80a30edeff30311077a95dac793bf19c", name: "message", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "80a30edeff30311077a95dac793bf19c", label: "Message", name: "message", type: "string", type_label: "String", hint: "", order: 0, extended: false, mandatory: true, readonly: false, maxsize: 4000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: [], dynamic: null}}]`, messageValue)
}

// generateUIUniqueID generates a UUID-like string for UI unique identifiers.
func generateUIUniqueID() string {
	// Simple UUID v4-like generator
	chars := "abcdef0123456789"
	result := make([]byte, 36)
	for i := 0; i < 36; i++ {
		switch i {
		case 8, 13, 18, 23:
			result[i] = '-'
		case 14:
			result[i] = '4'
		case 19:
			result[i] = chars[8+int(time.Now().UnixNano())%4]
		default:
			result[i] = chars[int(time.Now().UnixNano())%len(chars)]
		}
	}
	return string(result)
}

// RemoveFlowActionOptions holds options for removing an action from a flow.
type RemoveFlowActionOptions struct {
	FlowID   string // Flow sys_id or name
	ActionID string // Action sys_id to remove
}

// RemoveFlowAction removes an action from a flow using the GraphQL API.
func (c *Client) RemoveFlowAction(ctx context.Context, opts RemoveFlowActionOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.ActionID == "" {
		return fmt.Errorf("action ID is required")
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

	// Build and execute GraphQL mutation for deletion
	mutation := buildActionDeleteMutation(flowSysID, opts.ActionID)

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

// buildActionDeleteMutation builds the GraphQL mutation for deleting an action.
func buildActionDeleteMutation(flowSysID, actionID string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", actions: {delete: ["%s"]}}) {
        id
        actions {
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, actionID)
}

// MoveFlowActionOptions holds options for moving an action within a flow.
type MoveFlowActionOptions struct {
	FlowID   string // Flow sys_id or name
	ActionID string // Action sys_id to move
	ParentID string // Parent logic block ID (empty for top-level)
	Order    string // Order position (optional)
}

// MoveFlowAction moves an action to a different position or parent in a flow.
func (c *Client) MoveFlowAction(ctx context.Context, opts MoveFlowActionOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.ActionID == "" {
		return fmt.Errorf("action ID is required")
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

	// Build and execute GraphQL mutation for move
	mutation := buildActionMoveMutation(flowSysID, opts.ActionID, opts.ParentID, opts.Order)

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

// buildActionMoveMutation builds the GraphQL mutation for moving an action.
func buildActionMoveMutation(flowSysID, actionID, parentID, order string) string {
	// Build update object
	updateObj := fmt.Sprintf(`{uiUniqueIdentifier: "%s", type: "action"`, actionID)

	if parentID != "" {
		updateObj += fmt.Sprintf(`, parent: "%s", parentUiId: "%s"`, parentID, parentID)
	}

	if order != "" {
		updateObj += fmt.Sprintf(`, order: "%s"`, order)
	}

	updateObj += "}"

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", actions: {update: [%s]}}) {
        id
        actions {
          updates
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, updateObj)
}
