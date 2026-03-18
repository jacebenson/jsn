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

// GetFlowActions retrieves actions for a flow from sys_hub_action_instance.
func (c *Client) GetFlowActions(ctx context.Context, flowID string) ([]FlowAction, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,action_type,order,active,flow")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err != nil {
		return nil, err
	}

	actions := make([]FlowAction, len(resp.Result))
	for i, record := range resp.Result {
		actions[i] = flowActionFromRecord(record)
	}

	return actions, nil
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
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err != nil {
		return err
	}

	for _, record := range resp.Result {
		sysID := getString(record, "sys_id")
		if sysID != "" {
			if err := c.Delete(ctx, "sys_hub_action_instance", sysID); err != nil {
				// Log but continue - some actions might already be deleted
				continue
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
