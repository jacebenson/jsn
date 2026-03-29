package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

// Flow represents a ServiceNow Flow Designer flow (sys_hub_flow record).
type Flow struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Active      bool   `json:"active,string"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	SysScope    string `json:"sys_scope"`
	Version     string `json:"version"`
	RunAs       string `json:"run_as"`
	RunAsUser   string `json:"run_as_user"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListFlowsOptions holds options for listing flows.
type ListFlowsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListFlows retrieves flows from sys_hub_flow.
func (c *Client) ListFlows(ctx context.Context, opts *ListFlowsOptions) ([]Flow, error) {
	if opts == nil {
		opts = &ListFlowsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,name,type,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_hub_flow", query)
	if err != nil {
		return nil, err
	}

	flows := make([]Flow, len(resp.Result))
	for i, record := range resp.Result {
		flows[i] = flowFromRecord(record)
	}

	return flows, nil
}

// GetFlow retrieves a single flow by name or sys_id.
func (c *Client) GetFlow(ctx context.Context, identifier string) (*Flow, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,type,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_hub_flow", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("flow not found: %s", identifier)
	}

	flow := flowFromRecord(resp.Result[0])
	return &flow, nil
}

// flowFromRecord converts a record map to a Flow struct.
func flowFromRecord(record map[string]interface{}) Flow {
	return Flow{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Type:        getString(record, "type"),
		Active:      getBool(record, "active"),
		Description: getString(record, "description"),
		Scope:       getString(record, "scope"),
		SysScope:    getString(record, "sys_scope"),
		Version:     getString(record, "version"),
		RunAs:       getString(record, "run_as"),
		RunAsUser:   getString(record, "run_as_user"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// FlowExecution represents a flow execution record from sys_hub_trigger_instance_v2.
type FlowExecution struct {
	SysID        string `json:"sys_id"`
	FlowID       string `json:"flow_id"`
	FlowName     string `json:"flow_name"`
	Status       string `json:"status"`
	Started      string `json:"started"`
	Ended        string `json:"ended"`
	Duration     string `json:"duration"`
	SysUpdatedOn string `json:"sys_updated_on"`
}

// ListFlowExecutionsOptions holds options for listing flow executions.
type ListFlowExecutionsOptions struct {
	FlowID    string
	Limit     int
	Offset    int
	OrderBy   string
	OrderDesc bool
}

// ListFlowExecutions retrieves flow execution history from sys_hub_trigger_instance_v2.
func (c *Client) ListFlowExecutions(ctx context.Context, opts *ListFlowExecutionsOptions) ([]FlowExecution, error) {
	if opts == nil {
		opts = &ListFlowExecutionsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,flow,flow.name,status,started,ended,duration,sys_updated_on")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_updated_on"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.FlowID != "" {
		sysparmQuery = sysparmQuery + "^flow=" + opts.FlowID
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_hub_trigger_instance_v2", query)
	if err != nil {
		return nil, err
	}

	executions := make([]FlowExecution, len(resp.Result))
	for i, record := range resp.Result {
		executions[i] = flowExecutionFromRecord(record)
	}

	return executions, nil
}

// flowExecutionFromRecord converts a record map to a FlowExecution struct.
func flowExecutionFromRecord(record map[string]interface{}) FlowExecution {
	// Handle flow.name which might be a display value object
	flowName := ""
	if flow, ok := record["flow"].(map[string]interface{}); ok {
		flowName = getString(flow, "display_value")
		if flowName == "" {
			flowName = getString(flow, "value")
		}
	}

	return FlowExecution{
		SysID:        getString(record, "sys_id"),
		FlowID:       getString(record, "flow"),
		FlowName:     flowName,
		Status:       getString(record, "status"),
		Started:      getString(record, "started"),
		Ended:        getString(record, "ended"),
		Duration:     getString(record, "duration"),
		SysUpdatedOn: getString(record, "sys_updated_on"),
	}
}

// FlowAction represents a flow action instance.
type FlowAction struct {
	SysID  string `json:"sys_id"`
	Name   string `json:"name"`
	Action string `json:"action"`
	Order  int    `json:"order"`
	Active bool   `json:"active"`
	FlowID string `json:"flow_id"`
}

// GetFlowActions retrieves actions for a flow from sys_hub_action_instance and sys_hub_action_instance_v2.
func (c *Client) GetFlowActions(ctx context.Context, flowID string) ([]FlowAction, error) {
	var allActions []FlowAction

	// Check V1 action instances
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,action_type,order,active,flow")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err == nil {
		for _, record := range resp.Result {
			allActions = append(allActions, flowActionFromRecord(record))
		}
	}

	// Check V2 action instances
	queryV2 := url.Values{}
	queryV2.Set("sysparm_limit", "100")
	queryV2.Set("sysparm_fields", "sys_id,action_type,order,flow,values")
	queryV2.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))

	respV2, err := c.Get(ctx, "sys_hub_action_instance_v2", queryV2)
	if err == nil {
		for _, record := range respV2.Result {
			allActions = append(allActions, flowActionFromRecordV2(record))
		}
	}

	return allActions, nil
}

// flowActionFromRecord converts a record map to a FlowAction struct.
func flowActionFromRecord(record map[string]interface{}) FlowAction {
	// Handle action_type which may be a reference field
	actionType := getDisplayValue(record, "action_type")
	if actionType == "" {
		// Try to extract from reference field value or link
		if at, ok := record["action_type"].(map[string]interface{}); ok {
			actionType = getString(at, "value")
			if actionType == "" {
				// Extract from link URL (e.g., .../sys_hub_action_type_base/core.log)
				link := getString(at, "link")
				if link != "" {
					// Parse the last part of the URL path
					for i := len(link) - 1; i >= 0; i-- {
						if link[i] == '/' {
							actionType = link[i+1:]
							break
						}
					}
				}
			}
		}
		if actionType == "" {
			actionType = getString(record, "action_type")
		}
	}

	return FlowAction{
		SysID:  getString(record, "sys_id"),
		Name:   getString(record, "name"),
		Action: actionType,
		Order:  getInt(record, "order"),
		Active: getBool(record, "active"),
		FlowID: getString(record, "flow"),
	}
}

// flowActionFromRecordV2 converts a V2 action record map to a FlowAction struct.
func flowActionFromRecordV2(record map[string]interface{}) FlowAction {
	// Handle action_type which may be a reference field
	actionType := getDisplayValue(record, "action_type")
	if actionType == "" {
		if at, ok := record["action_type"].(map[string]interface{}); ok {
			actionType = getString(at, "value")
		}
		if actionType == "" {
			actionType = getString(record, "action_type")
		}
	}

	return FlowAction{
		SysID:  getString(record, "sys_id"),
		Name:   "", // V2 doesn't have a name field directly
		Action: actionType,
		Order:  getInt(record, "order"),
		Active: true, // V2 actions are active by default
		FlowID: getString(record, "flow"),
	}
}

// FlowVariable represents a flow variable definition.
type FlowVariable struct {
	SysID string `json:"sys_id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Label string `json:"label"`
	Value string `json:"value"`
}

// GetFlowVariables retrieves variables for a flow.
func (c *Client) GetFlowVariables(ctx context.Context, flowID string) ([]FlowVariable, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,variable_type,label,default_value")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_flow_variable", query)
	if err != nil {
		return nil, err
	}

	variables := make([]FlowVariable, len(resp.Result))
	for i, record := range resp.Result {
		variables[i] = flowVariableFromRecord(record)
	}

	return variables, nil
}

// flowVariableFromRecord converts a record map to a FlowVariable struct.
func flowVariableFromRecord(record map[string]interface{}) FlowVariable {
	return FlowVariable{
		SysID: getString(record, "sys_id"),
		Name:  getString(record, "name"),
		Type:  getString(record, "variable_type"),
		Label: getString(record, "label"),
		Value: getString(record, "default_value"),
	}
}

// UpdateFlowStatus activates or deactivates a flow.
func (c *Client) UpdateFlowStatus(ctx context.Context, flowID string, active bool) error {
	updates := map[string]interface{}{
		"active": active,
	}
	_, err := c.Patch(ctx, "sys_hub_flow", flowID, updates)
	return err
}

// ExecuteFlowInput holds parameters for executing a flow.
type ExecuteFlowInput struct {
	Inputs map[string]interface{} // Flow input variables
}

// ExecuteFlow manually executes/triggers a flow.
// This creates a flow execution record and starts the flow.
func (c *Client) ExecuteFlow(ctx context.Context, flowID string, input ExecuteFlowInput) (*FlowExecution, error) {
	// Create a trigger instance to execute the flow
	data := map[string]interface{}{
		"flow":   flowID,
		"status": "waiting",
	}

	// Add any input variables if provided
	if len(input.Inputs) > 0 {
		inputJSON, _ := json.Marshal(input.Inputs)
		data["inputs"] = string(inputJSON)
	}

	resp, err := c.Post(ctx, "sys_hub_trigger_instance", data)
	if err != nil {
		return nil, fmt.Errorf("failed to execute flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from execute flow")
	}

	// Get the execution details
	exec := FlowExecution{
		SysID:        getString(resp.Result, "sys_id"),
		FlowID:       flowID,
		Status:       getString(resp.Result, "status"),
		Started:      getString(resp.Result, "sys_created_on"),
		SysUpdatedOn: getString(resp.Result, "sys_updated_on"),
	}

	return &exec, nil
}

// FlowInspection holds comprehensive data about a flow for debugging.
type FlowInspection struct {
	Flow               *Flow
	Version            map[string]interface{}
	Components         []map[string]interface{}
	TriggerInstances   []map[string]interface{}
	TimerTriggers      []map[string]interface{}
	RecordTriggers     []map[string]interface{}
	ActionInstances    []map[string]interface{}
	ActionInstancesV2  []map[string]interface{}
	FlowLogicInstances []map[string]interface{}
	SubFlowInstances   []map[string]interface{}
	StepInstances      []map[string]interface{}
	FlowInputs         []map[string]interface{}
	FlowOutputs        []map[string]interface{}
	FlowDataVars       []map[string]interface{}
	TriggerDefinitions []map[string]interface{}
}

// InspectFlow retrieves comprehensive information about a flow for debugging.
func (c *Client) InspectFlow(ctx context.Context, flowID string) (*FlowInspection, error) {
	inspection := &FlowInspection{}

	// Get the flow
	flow, err := c.GetFlow(ctx, flowID)
	if err != nil {
		return nil, err
	}
	inspection.Flow = flow

	// Get version record
	versionQuery := url.Values{}
	versionQuery.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYDESCsys_updated_on", flowID))
	versionQuery.Set("sysparm_limit", "1")
	if resp, err := c.Get(ctx, "sys_hub_flow_version", versionQuery); err == nil && len(resp.Result) > 0 {
		inspection.Version = resp.Result[0]

		// Parse payload to extract trigger configuration (time, name, etc.)
		if payload, ok := resp.Result[0]["payload"].(string); ok && payload != "" {
			var payloadData map[string]interface{}
			if err := json.Unmarshal([]byte(payload), &payloadData); err == nil {
				// Extract trigger info from triggerInstances
				if triggerInstances, ok := payloadData["triggerInstances"].([]interface{}); ok && len(triggerInstances) > 0 {
					if firstTrigger, ok := triggerInstances[0].(map[string]interface{}); ok {
						// Extract trigger name
						if triggerName, ok := firstTrigger["name"].(string); ok && triggerName != "" {
							resp.Result[0]["trigger_name"] = triggerName
						}
						// Extract trigger type
						if triggerType, ok := firstTrigger["type"].(string); ok && triggerType != "" {
							resp.Result[0]["trigger_type"] = triggerType
						}
						// Extract trigger table and time from inputs
						if inputs, ok := firstTrigger["inputs"].([]interface{}); ok {
							for _, input := range inputs {
								if inputMap, ok := input.(map[string]interface{}); ok {
									if name, ok := inputMap["name"].(string); ok {
										if name == "time" {
											if value, ok := inputMap["value"].(string); ok && value != "" {
												resp.Result[0]["trigger_time"] = value
											}
										}
										if name == "table" {
											if value, ok := inputMap["value"].(string); ok && value != "" {
												resp.Result[0]["trigger_table"] = value
											}
										}
									}
								}
							}
						}
					}
				}
				// Extract flow logic instances (If/Then/Else conditions)
				if flowLogic, ok := payloadData["flowLogicInstances"].([]interface{}); ok {
					inspection.FlowLogicInstances = make([]map[string]interface{}, 0, len(flowLogic))
					for _, logic := range flowLogic {
						if logicMap, ok := logic.(map[string]interface{}); ok {
							inspection.FlowLogicInstances = append(inspection.FlowLogicInstances, logicMap)
						}
					}
				}
				// Extract action instances from payload (they have parent references to logic)
				if actionInstances, ok := payloadData["actionInstances"].([]interface{}); ok {
					for _, action := range actionInstances {
						if actionMap, ok := action.(map[string]interface{}); ok {
							// Store action instances from payload for full structure
							// These have parent references showing the flow structure
							inspection.ActionInstances = append(inspection.ActionInstances, actionMap)
						}
					}
				}

				// Extract subflow instances from payload (calls to other flows)
				if subFlowInstances, ok := payloadData["subFlowInstances"].([]interface{}); ok {
					for _, subFlow := range subFlowInstances {
						if subFlowMap, ok := subFlow.(map[string]interface{}); ok {
							inspection.SubFlowInstances = append(inspection.SubFlowInstances, subFlowMap)
						}
					}
				}

				// Extract flow inputs from payload (for subflows)
				if inputs, ok := payloadData["inputs"].([]interface{}); ok {
					for _, input := range inputs {
						if inputMap, ok := input.(map[string]interface{}); ok {
							inspection.FlowInputs = append(inspection.FlowInputs, inputMap)
						}
					}
				}

				// Extract flow outputs from payload (for subflows)
				if outputs, ok := payloadData["outputs"].([]interface{}); ok {
					for _, output := range outputs {
						if outputMap, ok := output.(map[string]interface{}); ok {
							inspection.FlowOutputs = append(inspection.FlowOutputs, outputMap)
						}
					}
				}
			}
		}
	}

	// Get flow components
	compQuery := url.Values{}
	compQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	compQuery.Set("sysparm_fields", "sys_id,sys_class_name,order,display_text,ui_id,parent_ui_id,attributes")
	if resp, err := c.Get(ctx, "sys_hub_flow_component", compQuery); err == nil {
		inspection.Components = resp.Result
	}

	// Get trigger instances
	triggerQuery := url.Values{}
	triggerQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	triggerQuery.Set("sysparm_fields", "sys_id,name,trigger_definition,trigger_type,display_text,active")
	if resp, err := c.Get(ctx, "sys_hub_trigger_instance", triggerQuery); err == nil {
		inspection.TriggerInstances = resp.Result
	}

	// NOTE: sys_flow_timer_trigger, sys_flow_record_trigger, and sys_hub_trigger_definition
	// do NOT have a 'flow' field, so querying them with flow={id} returns all records.
	// Trigger info comes from the version payload's triggerInstances or sys_hub_trigger_instance.

	// Get action instances (V1) — skip if version payload already provided them
	if len(inspection.ActionInstances) == 0 {
		actionQuery := url.Values{}
		actionQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
		actionQuery.Set("sysparm_fields", "sys_id,action_type,order,active,comment,action_inputs,display_text,name")
		if resp, err := c.Get(ctx, "sys_hub_action_instance", actionQuery); err == nil {
			inspection.ActionInstances = resp.Result

			// Look up action type names for V1 actions
			actionTypeCache := make(map[string]string)
			for _, action := range inspection.ActionInstances {
				if at, ok := action["action_type"].(map[string]interface{}); ok {
					actionID := getString(at, "value")
					if actionID != "" {
						// Check cache first
						if name, found := actionTypeCache[actionID]; found {
							at["display_value"] = name
						} else {
							// Fetch action type name
							typeQuery := url.Values{}
							typeQuery.Set("sysparm_query", fmt.Sprintf("sys_id=%s", actionID))
							typeQuery.Set("sysparm_fields", "sys_id,name")
							typeQuery.Set("sysparm_limit", "1")
							if typeResp, err := c.Get(ctx, "sys_hub_action_type_base", typeQuery); err == nil && len(typeResp.Result) > 0 {
								name := getString(typeResp.Result[0], "name")
								if name != "" {
									at["display_value"] = name
									actionTypeCache[actionID] = name
								}
							}
						}
					}
				}
			}
		}
	}

	// Get action instances (V2)
	actionV2Query := url.Values{}
	actionV2Query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	actionV2Query.Set("sysparm_fields", "sys_id,action_type,order,values,display_text")
	if resp, err := c.Get(ctx, "sys_hub_action_instance_v2", actionV2Query); err == nil {
		inspection.ActionInstancesV2 = resp.Result

		// Look up action type names for V2 actions
		actionTypeCache := make(map[string]string)
		for _, action := range inspection.ActionInstancesV2 {
			if at, ok := action["action_type"].(map[string]interface{}); ok {
				actionID := getString(at, "value")
				if actionID != "" {
					// Check cache first
					if name, found := actionTypeCache[actionID]; found {
						at["display_value"] = name
					} else {
						// Fetch action type name
						typeQuery := url.Values{}
						typeQuery.Set("sysparm_query", fmt.Sprintf("sys_id=%s", actionID))
						typeQuery.Set("sysparm_fields", "sys_id,name")
						typeQuery.Set("sysparm_limit", "1")
						if typeResp, err := c.Get(ctx, "sys_hub_action_type_base", typeQuery); err == nil && len(typeResp.Result) > 0 {
							name := getString(typeResp.Result[0], "name")
							if name != "" {
								at["display_value"] = name
								actionTypeCache[actionID] = name
							}
						}
					}
				}
			}
		}
	}

	// Get flow logic instances — skip if version payload already provided them
	if len(inspection.FlowLogicInstances) == 0 {
		// Query both V1 and V2 flow logic tables
		for _, table := range []string{"sys_hub_flow_logic", "sys_hub_flow_logic_instance_v2"} {
			logicQuery := url.Values{}
			logicQuery.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))
			logicQuery.Set("sysparm_fields", "sys_id,order,logic_definition,display_text,parent_ui_id,comment")
			logicQuery.Set("sysparm_display_value", "all")
			logicQuery.Set("sysparm_limit", "50")
			if resp, err := c.Get(ctx, table, logicQuery); err == nil {
				for _, record := range resp.Result {
					// Normalize display_value fields for consistent downstream use
					logicMap := map[string]interface{}{
						"sys_id":       getDisplayOrValue(record, "sys_id"),
						"order":        getDisplayOrValue(record, "order"),
						"name":         getDisplayOrValue(record, "logic_definition"),
						"comment":      getDisplayOrValue(record, "comment"),
						"display_text": getDisplayOrValue(record, "display_text"),
						"parent_ui_id": getDisplayOrValue(record, "parent_ui_id"),
						"source_table": table,
					}
					inspection.FlowLogicInstances = append(inspection.FlowLogicInstances, logicMap)
				}
			}
		}
	}

	// Get subflow instances — skip if version payload already provided them
	if len(inspection.SubFlowInstances) == 0 {
		sfQuery := url.Values{}
		sfQuery.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))
		sfQuery.Set("sysparm_fields", "sys_id,order,sub_flow,display_text,parent_ui_id,comment")
		sfQuery.Set("sysparm_display_value", "all")
		sfQuery.Set("sysparm_limit", "50")
		if resp, err := c.Get(ctx, "sys_hub_sub_flow_instance", sfQuery); err == nil {
			for _, record := range resp.Result {
				sfMap := map[string]interface{}{
					"sys_id":       getDisplayOrValue(record, "sys_id"),
					"order":        getDisplayOrValue(record, "order"),
					"name":         getDisplayOrValue(record, "sub_flow"),
					"comment":      getDisplayOrValue(record, "comment"),
					"display_text": getDisplayOrValue(record, "display_text"),
					"parent_ui_id": getDisplayOrValue(record, "parent_ui_id"),
				}
				inspection.SubFlowInstances = append(inspection.SubFlowInstances, sfMap)
			}
		}
	}

	// Get step instances (limit to 50, filter to only include ones with matching flow)
	stepQuery := url.Values{}
	stepQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	stepQuery.Set("sysparm_fields", "sys_id,action,step_type,order,label,inputs,flow")
	stepQuery.Set("sysparm_limit", "50")
	if resp, err := c.Get(ctx, "sys_hub_step_instance", stepQuery); err == nil {
		// Filter to only include records where flow matches
		for _, record := range resp.Result {
			if flowRef, ok := record["flow"].(map[string]interface{}); ok {
				if getString(flowRef, "value") == flowID {
					inspection.StepInstances = append(inspection.StepInstances, record)
				}
			}
		}
	}

	// Get flow inputs — skip if version payload already provided them
	if len(inspection.FlowInputs) == 0 {
		inputQuery := url.Values{}
		inputQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
		inputQuery.Set("sysparm_fields", "sys_id,name,label,type,mandatory,flow")
		inputQuery.Set("sysparm_limit", "20")
		if resp, err := c.Get(ctx, "sys_hub_flow_input", inputQuery); err == nil {
			for _, record := range resp.Result {
				if flowRef, ok := record["flow"].(map[string]interface{}); ok {
					if getString(flowRef, "value") == flowID {
						inspection.FlowInputs = append(inspection.FlowInputs, record)
					}
				}
			}
		}
	}

	// Get flow outputs — skip if version payload already provided them
	if len(inspection.FlowOutputs) == 0 {
		outputQuery := url.Values{}
		outputQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
		outputQuery.Set("sysparm_fields", "sys_id,name,label,type,flow")
		outputQuery.Set("sysparm_limit", "20")
		if resp, err := c.Get(ctx, "sys_hub_flow_output", outputQuery); err == nil {
			for _, record := range resp.Result {
				if flowRef, ok := record["flow"].(map[string]interface{}); ok {
					if getString(flowRef, "value") == flowID {
						inspection.FlowOutputs = append(inspection.FlowOutputs, record)
					}
				}
			}
		}
	}

	// Get flow data vars (limit to 20, filter to only include ones with matching flow)
	varQuery := url.Values{}
	varQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	varQuery.Set("sysparm_fields", "sys_id,name,type,value,flow")
	varQuery.Set("sysparm_limit", "20")
	if resp, err := c.Get(ctx, "sys_flow_data_var", varQuery); err == nil {
		// Filter to only include records where flow matches
		for _, record := range resp.Result {
			if flowRef, ok := record["flow"].(map[string]interface{}); ok {
				if getString(flowRef, "value") == flowID {
					inspection.FlowDataVars = append(inspection.FlowDataVars, record)
				}
			}
		}
	}

	return inspection, nil
}

// getDisplayOrValue extracts the value from a field that may be a display_value/value
// pair (from sysparm_display_value=all) or a plain string.
func getDisplayOrValue(record map[string]interface{}, key string) string {
	val := record[key]
	if val == nil {
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	if m, ok := val.(map[string]interface{}); ok {
		if dv, ok := m["display_value"].(string); ok && dv != "" {
			return dv
		}
		if v, ok := m["value"].(string); ok {
			return v
		}
	}
	return ""
}
