// Package sdk provides ServiceNow API helpers and utilities.
package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// FlowInfo holds high-level flow metadata.
type FlowInfo struct {
	Name    string `json:"name"`
	Active  bool   `json:"active"`
	Version string `json:"version"`
	Type    string `json:"type"`
	SysID   string `json:"sys_id"`
}

// FlowInspection holds comprehensive data about a flow for inspection output.
type FlowInspection struct {
	Flow               FlowInfo         `json:"flow"`
	Version            map[string]any   `json:"version,omitempty"`
	Payload            map[string]any   `json:"payload,omitempty"`
	TriggerInstances   []map[string]any `json:"trigger_instances,omitempty"`
	ActionInstances    []map[string]any `json:"action_instances,omitempty"`
	FlowLogicInstances []map[string]any `json:"flow_logic_instances,omitempty"`
	SubFlowInstances   []map[string]any `json:"subflow_instances,omitempty"`
	FlowInputs         []map[string]any `json:"flow_inputs,omitempty"`
	FlowOutputs        []map[string]any `json:"flow_outputs,omitempty"`
}

// RelatedQuery defines a related table to fetch
// nolint:unused
// RelatedQuery defines a related table to fetch.
type RelatedQuery struct {
	Table      string   // Table to query
	QueryField string   // Field to filter on (e.g., "request_item")
	QueryValue string   // Value to filter by (e.g., sys_id of parent)
	Fields     []string // Fields to fetch
	DisplayAs  string   // Key name in result (e.g., "variables")
}

// RecordWithRelated fetches a record and related data.
func (c *Client) RecordWithRelated(ctx context.Context, table string, query url.Values, related []RelatedQuery) (map[string]any, error) {
	// Fetch main record
	records, err := c.List(ctx, table, query)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch record: %w", err)
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("record not found")
	}

	result := map[string]any{
		"_record": records[0],
	}

	// Fetch related data concurrently
	for _, rel := range related {
		params := url.Values{}
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_fields", joinFields(rel.Fields))
		params.Set("sysparm_query", rel.QueryField+"="+rel.QueryValue)
		params.Set("sysparm_limit", "100")

		data, err := c.List(ctx, rel.Table, params)
		if err != nil {
			// Log error but continue
			result[rel.DisplayAs] = []map[string]any{}
			continue
		}
		result[rel.DisplayAs] = data
	}

	return result, nil
}

// FetchAttachments retrieves attachments for a record.
func (c *Client) FetchAttachments(ctx context.Context, tableName, tableSysID string) ([]map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "sys_id,file_name,sys_created_on,sys_created_by")
	params.Set("sysparm_query", "table_name="+tableName+"^table_sys_id="+tableSysID)

	return c.List(ctx, "sys_attachment", params)
}

// FetchCatalogVariables retrieves catalog variables for a request item.
// This follows the ServiceNow data model: sc_item_option stores values,
// item_option_new stores the question definitions.
func (c *Client) FetchCatalogVariables(ctx context.Context, ritmSysID string) ([]Variable, error) {
	// Query sc_item_option for values
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "item_option_new,value")
	params.Set("sysparm_query", "request_item="+ritmSysID)
	params.Set("sysparm_limit", "100")

	optRecords, err := c.List(ctx, "sc_item_option", params)
	if err != nil {
		return nil, err
	}

	var variables []Variable
	for _, opt := range optRecords {
		// Extract question name from item_option_new.display_value
		question := ""
		if itemOptNew, ok := opt["item_option_new"].(map[string]any); ok {
			if dv, ok := itemOptNew["display_value"].(string); ok {
				question = dv
			}
		}

		// Extract answer value
		value := ""
		if v, ok := opt["value"].(map[string]any); ok {
			if dv, ok := v["display_value"].(string); ok {
				value = dv
			} else if val, ok := v["value"].(string); ok {
				value = val
			}
		} else if v, ok := opt["value"].(string); ok {
			value = v
		}

		if question != "" {
			variables = append(variables, Variable{
				Question: question,
				Value:    value,
			})
		}
	}

	return variables, nil
}

// InspectFlow retrieves full flow inspection data for styled flow output.
func (c *Client) InspectFlow(ctx context.Context, identifier string) (*FlowInspection, error) {
	inspection := &FlowInspection{}

	// 1) Resolve the flow from sys_hub_flow by sys_id or name.
	flowQuery := url.Values{}
	flowQuery.Set("sysparm_display_value", "all")
	flowQuery.Set("sysparm_limit", "1")
	if isSysID(identifier) {
		flowQuery.Set("sysparm_query", "sys_id="+identifier)
	} else {
		flowQuery.Set("sysparm_query", "name="+identifier)
	}
	flowQuery.Set("sysparm_fields", "sys_id,name,active,version,type")

	flowRecords, err := c.List(ctx, "sys_hub_flow", flowQuery)
	if err != nil {
		return nil, fmt.Errorf("failed to find flow: %w", err)
	}
	if len(flowRecords) == 0 {
		return nil, fmt.Errorf("flow not found: %s", identifier)
	}

	flow := flowRecords[0]
	flowSysID := getString(flow, "sys_id")
	flowVersion := getString(flow, "version")

	inspection.Flow = FlowInfo{
		Name:    getString(flow, "name"),
		Active:  getBoolField(flow, "active"),
		Version: flowVersion,
		Type:    getString(flow, "type"),
		SysID:   flowSysID,
	}

	// 2) Fetch latest flow version (includes payload with full structure).
	versionQuery := url.Values{}
	versionQuery.Set("sysparm_display_value", "all")
	versionQuery.Set("sysparm_limit", "1")
	versionQuery.Set("sysparm_query", "flow="+flowSysID+"^ORDERBYDESCsys_updated_on")
	versionQuery.Set("sysparm_fields", "sys_id,flow,version,payload,sys_updated_on")
	if versionRecords, err := c.List(ctx, "sys_hub_flow_version", versionQuery); err == nil && len(versionRecords) > 0 {
		inspection.Version = versionRecords[0]
		if inspection.Flow.Version == "" {
			inspection.Flow.Version = getString(versionRecords[0], "version")
		}

		payload := getString(versionRecords[0], "payload")
		if payload != "" {
			var payloadData map[string]any
			if json.Unmarshal([]byte(payload), &payloadData) == nil {
				inspection.Payload = payloadData
				extractPayloadData(inspection, payloadData)
			}
		}
	}

	// 3) Fetch trigger instances table data (used directly + fallback).
	triggerQuery := url.Values{}
	triggerQuery.Set("sysparm_display_value", "all")
	triggerQuery.Set("sysparm_query", "flow="+flowSysID)
	triggerQuery.Set("sysparm_fields", "sys_id,name,trigger_type,display_text,active")
	triggerQuery.Set("sysparm_limit", "20")
	if triggerRecords, err := c.List(ctx, "sys_hub_trigger_instance", triggerQuery); err == nil {
		inspection.TriggerInstances = triggerRecords
	}

	// 4) Fallbacks when payload did not provide structure arrays.
	if len(inspection.ActionInstances) == 0 {
		actionQuery := url.Values{}
		actionQuery.Set("sysparm_display_value", "all")
		actionQuery.Set("sysparm_query", "flow="+flowSysID+"^ORDERBYorder")
		actionQuery.Set("sysparm_fields", "sys_id,order,name,display_text,comment,action_type")
		actionQuery.Set("sysparm_limit", "200")
		if records, err := c.List(ctx, "sys_hub_action_instance", actionQuery); err == nil {
			inspection.ActionInstances = records
		}
	}

	if len(inspection.FlowLogicInstances) == 0 {
		logicTables := []string{"sys_hub_flow_logic", "sys_hub_flow_logic_instance_v2"}
		for _, table := range logicTables {
			logicQuery := url.Values{}
			logicQuery.Set("sysparm_display_value", "all")
			logicQuery.Set("sysparm_query", "flow="+flowSysID+"^ORDERBYorder")
			logicQuery.Set("sysparm_fields", "sys_id,order,name,display_text,comment,parent_ui_id")
			logicQuery.Set("sysparm_limit", "200")
			if records, err := c.List(ctx, table, logicQuery); err == nil {
				inspection.FlowLogicInstances = append(inspection.FlowLogicInstances, records...)
			}
		}
		sort.Slice(inspection.FlowLogicInstances, func(i, j int) bool {
			return parseOrder(inspection.FlowLogicInstances[i]) < parseOrder(inspection.FlowLogicInstances[j])
		})
	}

	if len(inspection.SubFlowInstances) == 0 {
		subflowQuery := url.Values{}
		subflowQuery.Set("sysparm_display_value", "all")
		subflowQuery.Set("sysparm_query", "flow="+flowSysID+"^ORDERBYorder")
		subflowQuery.Set("sysparm_fields", "sys_id,order,sub_flow,name,display_text,comment,parent_ui_id")
		subflowQuery.Set("sysparm_limit", "200")
		if records, err := c.List(ctx, "sys_hub_sub_flow_instance", subflowQuery); err == nil {
			inspection.SubFlowInstances = records
		}
	}

	// Inputs/Outputs are primarily in payload for subflows.
	// Fallback to dedicated tables if available.
	// Note: sys_hub_flow_input/output use "model" field to reference the flow.
	if len(inspection.FlowInputs) == 0 {
		inputsQuery := url.Values{}
		inputsQuery.Set("sysparm_display_value", "all")
		inputsQuery.Set("sysparm_query", "model="+flowSysID+"^ORDERBYorder")
		inputsQuery.Set("sysparm_fields", "sys_id,name,label,type,mandatory,order")
		inputsQuery.Set("sysparm_limit", "200")
		if records, err := c.List(ctx, "sys_hub_flow_input", inputsQuery); err == nil {
			inspection.FlowInputs = records
		}
	}

	if len(inspection.FlowOutputs) == 0 {
		outputsQuery := url.Values{}
		outputsQuery.Set("sysparm_display_value", "all")
		outputsQuery.Set("sysparm_query", "model="+flowSysID+"^ORDERBYorder")
		outputsQuery.Set("sysparm_fields", "sys_id,name,label,type,order")
		outputsQuery.Set("sysparm_limit", "200")
		if records, err := c.List(ctx, "sys_hub_flow_output", outputsQuery); err == nil {
			inspection.FlowOutputs = records
		}
	}

	return inspection, nil
}

// Variable represents a catalog variable.
type Variable struct {
	Question string `json:"question"`
	Value    string `json:"value"`
}

// Attachment represents a ServiceNow attachment.
type Attachment struct {
	SysID      string `json:"sys_id"`
	FileName   string `json:"file_name"`
	CreatedOn  string `json:"sys_created_on"`
	CreatedBy  string `json:"sys_created_by"`
	TableName  string `json:"table_name"`
	TableSysID string `json:"table_sys_id"`
}

func extractPayloadData(inspection *FlowInspection, payload map[string]any) {
	if actions, ok := toMapSlice(payload["actionInstances"]); ok {
		inspection.ActionInstances = actions
	}
	if logic, ok := toMapSlice(payload["flowLogicInstances"]); ok {
		inspection.FlowLogicInstances = logic
	}
	if subflows, ok := toMapSlice(payload["subFlowInstances"]); ok {
		inspection.SubFlowInstances = subflows
	}
	if inputs, ok := toMapSlice(payload["inputs"]); ok {
		inspection.FlowInputs = inputs
	}
	if outputs, ok := toMapSlice(payload["outputs"]); ok {
		inspection.FlowOutputs = outputs
	}

	// Promote trigger details from payload triggerInstances for simpler rendering.
	triggerInstances, ok := payload["triggerInstances"].([]any)
	if !ok || len(triggerInstances) == 0 {
		return
	}
	first, ok := triggerInstances[0].(map[string]any)
	if !ok {
		return
	}

	if inspection.Version == nil {
		inspection.Version = map[string]any{}
	}

	if name := getString(first, "name"); name != "" {
		inspection.Version["trigger_name"] = name
	}
	if t := getString(first, "type"); t != "" {
		inspection.Version["trigger_type"] = t
	}

	if inputs, ok := first["inputs"].([]any); ok {
		for _, raw := range inputs {
			input, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name := getString(input, "name")
			value := getString(input, "value")
			if name == "table" && value != "" {
				inspection.Version["trigger_table"] = value
			}
			if name == "time" && value != "" {
				inspection.Version["trigger_time"] = value
			}
		}
	}
}

func toMapSlice(v any) ([]map[string]any, bool) {
	raw, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, true
}

func getBoolField(record map[string]any, field string) bool {
	v, ok := record[field]
	if !ok || v == nil {
		return false
	}
	switch val := v.(type) {
	case bool:
		return val
	case string:
		return strings.EqualFold(val, "true") || val == "1"
	case map[string]any:
		if display, ok := val["display_value"].(string); ok {
			return strings.EqualFold(display, "true") || display == "1"
		}
		if value, ok := val["value"].(string); ok {
			return strings.EqualFold(value, "true") || value == "1"
		}
	}
	return false
}

func parseOrder(record map[string]any) int {
	order := getString(record, "order")
	n, _ := strconv.Atoi(order)
	return n
}

func isSysID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, ch := range value {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') {
			continue
		}
		return false
	}
	return true
}

// joinFields joins field names with commas.
func joinFields(fields []string) string {
	if len(fields) == 0 {
		return "sys_id"
	}
	result := ""
	for i, f := range fields {
		if i > 0 {
			result += ","
		}
		result += f
	}
	return result
}

// GetDisplayValue extracts display value from a ServiceNow field.
func GetDisplayValue(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			if display, ok := v["display_value"].(string); ok && display != "" {
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
