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

	query.Set("sysparm_fields", "sys_id,name,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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
	query.Set("sysparm_fields", "sys_id,name,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

// CreateFlowInput holds parameters for creating a new flow.
type CreateFlowInput struct {
	Name        string
	Description string
	Scope       string // Scope name or sys_id
	Active      bool
	RunAs       string // "system", "user", or sys_id of a user
}

// CreateFlow creates a new flow with basic configuration.
func (c *Client) CreateFlow(ctx context.Context, input CreateFlowInput) (*Flow, error) {
	data := map[string]interface{}{
		"name":        input.Name,
		"description": input.Description,
		"active":      input.Active,
	}

	// Handle scope - resolve scope name to sys_id if needed
	if input.Scope != "" {
		if len(input.Scope) == 32 {
			// Looks like a sys_id
			data["sys_scope"] = input.Scope
		}
		// TODO: Add scope name resolution when GetApplication is available
	}

	// Handle run_as
	if input.RunAs != "" {
		data["run_as"] = input.RunAs
	}

	resp, err := c.Post(ctx, "sys_hub_flow", data)
	if err != nil {
		return nil, fmt.Errorf("failed to create flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create flow")
	}

	flow := flowFromRecord(resp.Result)
	return &flow, nil
}

// UpdateFlow updates flow properties (name, description, run_as, etc.).
func (c *Client) UpdateFlow(ctx context.Context, identifier string, updates map[string]interface{}) (*Flow, error) {
	// First, get the flow to resolve name to sys_id
	flow, err := c.GetFlow(ctx, identifier)
	if err != nil {
		return nil, err
	}

	// Handle scope resolution if scope is being updated
	if scope, ok := updates["scope"]; ok {
		scopeStr := fmt.Sprintf("%v", scope)
		if scopeStr != "" && len(scopeStr) == 32 {
			// Looks like a sys_id
			updates["sys_scope"] = scopeStr
			delete(updates, "scope")
		}
		// TODO: Add scope name resolution when GetApplication is available
	}

	resp, err := c.Patch(ctx, "sys_hub_flow", flow.SysID, updates)
	if err != nil {
		return nil, fmt.Errorf("failed to update flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update flow")
	}

	updatedFlow := flowFromRecord(resp.Result)
	return &updatedFlow, nil
}

// UpdateFlowStatus activates or deactivates a flow.
func (c *Client) UpdateFlowStatus(ctx context.Context, flowID string, active bool) error {
	updates := map[string]interface{}{
		"active": active,
	}
	_, err := c.Patch(ctx, "sys_hub_flow", flowID, updates)
	return err
}

// DeleteFlow deletes a flow by sys_id or name.
// If cascade is true, it will also delete related records (actions, variables, etc.)
func (c *Client) DeleteFlow(ctx context.Context, identifier string, cascade bool) error {
	// First, get the flow to resolve name to sys_id
	flow, err := c.GetFlow(ctx, identifier)
	if err != nil {
		return err
	}

	// If cascade, delete related records first
	if cascade {
		// Delete action instances
		if err := c.deleteFlowActions(ctx, flow.SysID); err != nil {
			return fmt.Errorf("failed to delete flow actions: %w", err)
		}

		// Delete variables
		if err := c.deleteFlowVariables(ctx, flow.SysID); err != nil {
			return fmt.Errorf("failed to delete flow variables: %w", err)
		}
	}

	// Delete the flow itself
	return c.Delete(ctx, "sys_hub_flow", flow.SysID)
}

// deleteFlowActions deletes all action instances for a flow.
func (c *Client) deleteFlowActions(ctx context.Context, flowID string) error {
	// Delete V1 action instances
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err == nil {
		for _, record := range resp.Result {
			sysID := getString(record, "sys_id")
			if sysID != "" {
				_ = c.Delete(ctx, "sys_hub_action_instance", sysID)
			}
		}
	}

	// Delete V2 action instances
	respV2, err := c.Get(ctx, "sys_hub_action_instance_v2", query)
	if err == nil {
		for _, record := range respV2.Result {
			sysID := getString(record, "sys_id")
			if sysID != "" {
				_ = c.Delete(ctx, "sys_hub_action_instance_v2", sysID)
			}
		}
	}

	// Delete flow components (triggers and actions)
	respComp, err := c.Get(ctx, "sys_hub_flow_component", query)
	if err == nil {
		for _, record := range respComp.Result {
			sysID := getString(record, "sys_id")
			if sysID != "" {
				_ = c.Delete(ctx, "sys_hub_flow_component", sysID)
			}
		}
	}

	return nil
}

// deleteFlowVariables deletes all variables for a flow.
func (c *Client) deleteFlowVariables(ctx context.Context, flowID string) error {
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_flow_variable", query)
	if err != nil {
		return err
	}

	for _, record := range resp.Result {
		sysID := getString(record, "sys_id")
		if sysID != "" {
			if err := c.Delete(ctx, "sys_hub_flow_variable", sysID); err != nil {
				// Log but continue
				continue
			}
		}
	}

	return nil
}

// Flow Action Types - Common action types for flows
const (
	ActionCreateRecord     = "core.createRecord"
	ActionUpdateRecord     = "core.updateRecord"
	ActionDeleteRecord     = "core.deleteRecord"
	ActionLog              = "core.log"
	ActionSendEmail        = "core.sendEmail"
	ActionSendNotification = "core.sendNotification"
	ActionAskForApproval   = "core.askForApproval"
	ActionCreateTask       = "core.createTask"
	ActionWaitForCondition = "core.waitForCondition"
	ActionLookUpRecord     = "core.lookUpRecord"
)

// CreateFlowActionInput holds parameters for creating a flow action.
type CreateFlowActionInput struct {
	Name       string
	ActionType string // e.g., "core.createRecord", "core.updateRecord", "core.log"
	Order      int
	Inputs     map[string]interface{} // Action configuration (table, field values, etc.)
}

// CreateFlowAction creates a new action instance in a flow.
func (c *Client) CreateFlowAction(ctx context.Context, flowID string, input CreateFlowActionInput) (*FlowAction, error) {
	data := map[string]interface{}{
		"flow":        flowID,
		"name":        input.Name,
		"action_type": input.ActionType,
		"order":       input.Order,
		"active":      true,
	}

	// Add action inputs if provided
	if len(input.Inputs) > 0 {
		// The inputs are stored as JSON in the input_values field
		inputJSON, _ := json.Marshal(input.Inputs)
		data["input_values"] = string(inputJSON)
	}

	resp, err := c.Post(ctx, "sys_hub_action_instance", data)
	if err != nil {
		return nil, fmt.Errorf("failed to create flow action: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create flow action")
	}

	action := flowActionFromRecord(resp.Result)
	return &action, nil
}

// FlowTrigger represents a flow trigger (record-based or scheduled).
type FlowTrigger struct {
	SysID    string `json:"sys_id"`
	FlowID   string `json:"flow_id"`
	Type     string `json:"type"` // "record", "timer", "manual"
	Active   bool   `json:"active"`
	Table    string `json:"table"`    // For record triggers
	Schedule string `json:"schedule"` // For timer triggers (e.g., "0 * * * *" for hourly)
}

// CreateFlowTimerTrigger creates a scheduled/timer trigger for a flow.
// The schedule uses cron format: "0 * * * *" = every hour, "0 0 * * *" = daily at midnight
func (c *Client) CreateFlowTimerTrigger(ctx context.Context, flowID string, schedule string, active bool) (*FlowTrigger, error) {
	data := map[string]interface{}{
		"flow":     flowID,
		"schedule": schedule,
		"active":   active,
	}

	resp, err := c.Post(ctx, "sys_flow_timer_trigger", data)
	if err != nil {
		return nil, fmt.Errorf("failed to create timer trigger: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create timer trigger")
	}

	trigger := flowTriggerFromRecord(resp.Result, "timer")
	return &trigger, nil
}

// CreateFlowRecordTrigger creates a record-based trigger for a flow.
func (c *Client) CreateFlowRecordTrigger(ctx context.Context, flowID string, table string, when string, active bool) (*FlowTrigger, error) {
	data := map[string]interface{}{
		"flow":   flowID,
		"table":  table,
		"when":   when, // "insert", "update", "delete"
		"active": active,
	}

	resp, err := c.Post(ctx, "sys_flow_record_trigger", data)
	if err != nil {
		return nil, fmt.Errorf("failed to create record trigger: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create record trigger")
	}

	trigger := flowTriggerFromRecord(resp.Result, "record")
	return &trigger, nil
}

// flowTriggerFromRecord converts a record map to a FlowTrigger struct.
func flowTriggerFromRecord(record map[string]interface{}, triggerType string) FlowTrigger {
	return FlowTrigger{
		SysID:    getString(record, "sys_id"),
		FlowID:   getString(record, "flow"),
		Type:     triggerType,
		Active:   getBool(record, "active"),
		Table:    getString(record, "table"),
		Schedule: getString(record, "schedule"),
	}
}

// PublishFlow creates a snapshot and publishes the flow to make it usable in Flow Designer.
func (c *Client) PublishFlow(ctx context.Context, flowID string) error {
	// First, get the flow to ensure it exists
	flow, err := c.GetFlow(ctx, flowID)
	if err != nil {
		return err
	}

	// Get existing actions to build the snapshot
	actions, err := c.GetFlowActions(ctx, flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to get flow actions: %w", err)
	}

	// Get triggers
	triggers, err := c.getFlowTriggers(ctx, flow.SysID)
	if err != nil {
		return fmt.Errorf("failed to get flow triggers: %w", err)
	}

	// Build a basic flow snapshot
	snapshot := buildFlowSnapshot(flow, actions, triggers)

	// Create the snapshot record
	snapshotData := map[string]interface{}{
		"flow":     flow.SysID,
		"name":     flow.Name,
		"snapshot": snapshot,
	}

	resp, err := c.Post(ctx, "sys_hub_flow_snapshot", snapshotData)
	if err != nil {
		return fmt.Errorf("failed to create flow snapshot: %w", err)
	}

	if resp.Result == nil {
		return fmt.Errorf("no response from create snapshot")
	}

	snapshotID := getString(resp.Result, "sys_id")

	// Update the flow to point to the snapshot and mark as published
	updates := map[string]interface{}{
		"latest_snapshot": snapshotID,
		"master_snapshot": snapshotID,
		"status":          "Published",
	}

	_, err = c.Patch(ctx, "sys_hub_flow", flow.SysID, updates)
	if err != nil {
		return fmt.Errorf("failed to publish flow: %w", err)
	}

	return nil
}

// getFlowTriggers retrieves all triggers for a flow.
func (c *Client) getFlowTriggers(ctx context.Context, flowID string) ([]FlowTrigger, error) {
	var triggers []FlowTrigger

	// Check for timer triggers
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id,flow,active,schedule")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_flow_timer_trigger", query)
	if err == nil {
		for _, record := range resp.Result {
			triggers = append(triggers, flowTriggerFromRecord(record, "timer"))
		}
	}

	// Check for record triggers
	resp, err = c.Get(ctx, "sys_flow_record_trigger", query)
	if err == nil {
		for _, record := range resp.Result {
			triggers = append(triggers, flowTriggerFromRecord(record, "record"))
		}
	}

	return triggers, nil
}

// buildFlowSnapshot creates a JSON snapshot of the flow definition.
func buildFlowSnapshot(flow *Flow, actions []FlowAction, triggers []FlowTrigger) string {
	type flowNode struct {
		ID       string                 `json:"id"`
		Type     string                 `json:"type"`
		Name     string                 `json:"name"`
		ActionID string                 `json:"actionId,omitempty"`
		Config   map[string]interface{} `json:"config,omitempty"`
	}

	type flowConnection struct {
		Source string `json:"source"`
		Target string `json:"target"`
	}

	type flowSnapshot struct {
		FlowID      string           `json:"flowId"`
		Name        string           `json:"name"`
		Version     string           `json:"version"`
		Nodes       []flowNode       `json:"nodes"`
		Connections []flowConnection `json:"connections"`
	}

	snapshot := flowSnapshot{
		FlowID:  flow.SysID,
		Name:    flow.Name,
		Version: "1",
		Nodes:   []flowNode{},
	}

	// Add trigger nodes
	for _, trigger := range triggers {
		node := flowNode{
			ID:   trigger.SysID,
			Type: trigger.Type,
			Name: trigger.Type,
		}
		if trigger.Type == "timer" {
			node.Config = map[string]interface{}{"schedule": trigger.Schedule}
		}
		snapshot.Nodes = append(snapshot.Nodes, node)
	}

	// Add action nodes
	for _, action := range actions {
		node := flowNode{
			ID:       action.SysID,
			Type:     "action",
			Name:     action.Name,
			ActionID: action.Action,
		}
		snapshot.Nodes = append(snapshot.Nodes, node)
	}

	// Create simple linear connections
	for i := 0; i < len(snapshot.Nodes)-1; i++ {
		snapshot.Connections = append(snapshot.Connections, flowConnection{
			Source: snapshot.Nodes[i].ID,
			Target: snapshot.Nodes[i+1].ID,
		})
	}

	snapshotJSON, _ := json.Marshal(snapshot)
	return string(snapshotJSON)
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
	StepInstances      []map[string]interface{}
	FlowInputs         []map[string]interface{}
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
	versionQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	versionQuery.Set("sysparm_limit", "1")
	if resp, err := c.Get(ctx, "sys_hub_flow_version", versionQuery); err == nil && len(resp.Result) > 0 {
		inspection.Version = resp.Result[0]
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

	// Get timer triggers
	timerQuery := url.Values{}
	timerQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	timerQuery.Set("sysparm_fields", "sys_id,active,timer_type,time,run_start")
	if resp, err := c.Get(ctx, "sys_flow_timer_trigger", timerQuery); err == nil {
		inspection.TimerTriggers = resp.Result
	}

	// Get record triggers (limit to 10, filter to only include ones with matching flow)
	recordQuery := url.Values{}
	recordQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	recordQuery.Set("sysparm_fields", "sys_id,active,table,when,flow")
	recordQuery.Set("sysparm_limit", "10")
	if resp, err := c.Get(ctx, "sys_flow_record_trigger", recordQuery); err == nil {
		// Filter to only include records where flow matches
		for _, record := range resp.Result {
			if flowRef, ok := record["flow"].(map[string]interface{}); ok {
				if getString(flowRef, "value") == flowID {
					inspection.RecordTriggers = append(inspection.RecordTriggers, record)
				}
			}
		}
	}

	// Get action instances (V1)
	actionQuery := url.Values{}
	actionQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	actionQuery.Set("sysparm_fields", "sys_id,action_type,order,active,comment,action_inputs,display_text")
	if resp, err := c.Get(ctx, "sys_hub_action_instance", actionQuery); err == nil {
		inspection.ActionInstances = resp.Result
	}

	// Get action instances (V2)
	actionV2Query := url.Values{}
	actionV2Query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	actionV2Query.Set("sysparm_fields", "sys_id,action_type,order,values,display_text")
	if resp, err := c.Get(ctx, "sys_hub_action_instance_v2", actionV2Query); err == nil {
		inspection.ActionInstancesV2 = resp.Result
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

	// Get flow inputs (limit to 20, filter to only include ones with matching flow)
	inputQuery := url.Values{}
	inputQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	inputQuery.Set("sysparm_fields", "sys_id,name,type,value,flow")
	inputQuery.Set("sysparm_limit", "20")
	if resp, err := c.Get(ctx, "sys_hub_flow_input", inputQuery); err == nil {
		// Filter to only include records where flow matches
		for _, record := range resp.Result {
			if flowRef, ok := record["flow"].(map[string]interface{}); ok {
				if getString(flowRef, "value") == flowID {
					inspection.FlowInputs = append(inspection.FlowInputs, record)
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

	// Get trigger definitions
	triggerDefQuery := url.Values{}
	triggerDefQuery.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	triggerDefQuery.Set("sysparm_fields", "sys_id,name,type,active")
	triggerDefQuery.Set("sysparm_limit", "10")
	if resp, err := c.Get(ctx, "sys_hub_trigger_definition", triggerDefQuery); err == nil {
		inspection.TriggerDefinitions = resp.Result
	}

	return inspection, nil
}
