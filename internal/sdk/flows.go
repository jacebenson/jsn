package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

// Trigger definition IDs from sys_hub_trigger_definition table.
// These are standard ServiceNow sys_ids that map trigger types to their definitions.
var triggerDefinitionIDs = map[string]string{
	"record_create":           "798916a0c31322002841b63b12d3ae7c",
	"record_update":           "bb695e60c31322002841b63b12d3aea5",
	"record_create_or_update": "a45d9180c32222002841b63b12d3aea7",
	"daily":                   "89142dc0c32222002841b63b12d3ae8a",
	"weekly":                  "cf352104c32222002841b63b12d3ae1f",
	"monthly":                 "2ca52504c32222002841b63b12d3ae4a",
	"once":                    "0a76e504c32222002841b63b12d3aeac",
	"repeat":                  "f63f0d94c32222002841b63b12d3aeed",
	"service_catalog":         "c43a1011c36813002841b63b12d3ae15",
}

// Action type sys_ids from sys_hub_action_type_base table.
// These are standard ServiceNow sys_ids that map action types to their definitions.
var actionTypeSysIDs = map[string]string{
	"create_record": "ab575ae253b3230034c6ddeeff7b12f1",
	"update_record": "f9d01dd2c31332002841b63b12d3aea1", // Updated from HAR - Update Record
	"delete_record": "c3e09916c31332002841b63b12d3aedf",
	"lookup_record": "43400a1587003300663ca1bb36cb0b4b",
	"ask_approval":  "f8f2e9920b10030085c083eb37673abd",
	"log":           "5bc1bcc6531003003bf1d9109ec587d4",
}

// Flow logic definition IDs from sys_hub_flow_logic_definition table.
// These are standard ServiceNow sys_ids for logic blocks like If, Else, For Each.
var flowLogicDefinitionIDs = map[string]string{
	"if":           "af4e1945c3e232002841b63b12d3ae3e",
	"elseif":       "666e5545c3e232002841b63b12d3ae99",
	"else":         "1f781bf3c32232002841b63b12d3aee6",
	"foreach":      "098e1dc5c3e232002841b63b12d3ae33",
	"set_variable": "4f787d1e0f9b0010ecf0cc52ff767ea0", // Set Flow Variables (updated from HAR)
}

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

// resolveFlowID takes a flow identifier (sys_id or name) and returns the sys_id.
func (c *Client) resolveFlowID(ctx context.Context, flowID string) (string, error) {
	// Try by sys_id first if it looks like one (32 hex chars)
	if len(flowID) == 32 {
		resp, err := c.Get(ctx, "sys_hub_flow", url.Values{
			"sysparm_query":  []string{fmt.Sprintf("sys_id=%s", flowID)},
			"sysparm_limit":  []string{"1"},
			"sysparm_fields": []string{"sys_id"},
		})
		if err == nil && len(resp.Result) > 0 {
			return getString(resp.Result[0], "sys_id"), nil
		}
	}

	// Try by name
	resp, err := c.Get(ctx, "sys_hub_flow", url.Values{
		"sysparm_query":  []string{fmt.Sprintf("name=%s", flowID)},
		"sysparm_limit":  []string{"1"},
		"sysparm_fields": []string{"sys_id"},
	})
	if err != nil {
		return "", fmt.Errorf("failed to query flow: %w", err)
	}
	if len(resp.Result) == 0 {
		return "", fmt.Errorf("flow not found: %s", flowID)
	}
	return getString(resp.Result[0], "sys_id"), nil
}

// getCurrentUserSysID returns the sys_id of the currently authenticated user.
func (c *Client) getCurrentUserSysID(ctx context.Context) (string, error) {
	resp, err := c.Get(ctx, "sys_user", url.Values{
		"sysparm_query":  []string{"sys_id=javascript:gs.getUserID()"},
		"sysparm_limit":  []string{"1"},
		"sysparm_fields": []string{"sys_id"},
	})
	if err != nil {
		return "", fmt.Errorf("failed to query current user: %w", err)
	}
	if len(resp.Result) == 0 {
		return "", fmt.Errorf("could not determine current user")
	}
	return getString(resp.Result[0], "sys_id"), nil
}

// SaveFlow regenerates the flow version payload after structural changes.
// This triggers ServiceNow to rebuild the payload from the current flow structure.
// It calls the same endpoint the Flow Designer UI uses: /api/now/processflow/versioning/create_version
func (c *Client) SaveFlow(ctx context.Context, flowID string) error {
	// Resolve flow sys_id
	flowSysID, err := c.resolveFlowID(ctx, flowID)
	if err != nil {
		return fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Call the versioning create_version endpoint (same as Flow Designer UI)
	// This regenerates the payload from the current flow structure
	body := map[string]interface{}{
		"item_sys_id": flowSysID,
		"type":        "Autosave",
		"annotation":  "",
		"favorite":    false,
	}

	_, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/processflow/versioning/create_version", body, nil)
	if err != nil {
		return fmt.Errorf("failed to save flow: %w", err)
	}
	if statusCode != 200 {
		return fmt.Errorf("flow save request failed with status %d", statusCode)
	}

	return nil
}
