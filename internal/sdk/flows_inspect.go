package sdk

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
)

// FlowInspection holds comprehensive data about a flow for debugging.
type FlowInspection struct {
	Flow               *Flow
	Version            map[string]interface{}
	Components         []map[string]interface{}
	TriggerInstances   []map[string]interface{}
	ActionInstances    []map[string]interface{}
	ActionInstancesV2  []map[string]interface{}
	FlowLogicInstances []map[string]interface{}
	SubFlowInstances   []map[string]interface{}
	FlowInputs         []map[string]interface{}
	FlowOutputs        []map[string]interface{}
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
			c.resolveActionTypeNames(ctx, inspection.ActionInstances)
		}
	}

	// Get action instances (V2)
	actionV2Query := url.Values{}
	actionV2Query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))
	actionV2Query.Set("sysparm_fields", "sys_id,action_type,order,values,display_text")
	actionV2Query.Set("sysparm_display_value", "all")
	if resp, err := c.Get(ctx, "sys_hub_action_instance_v2", actionV2Query); err == nil {
		inspection.ActionInstancesV2 = resp.Result
		c.resolveActionTypeNames(ctx, inspection.ActionInstancesV2)
		// Decompress values field for each action instance
		for _, action := range inspection.ActionInstancesV2 {
			// Try to get values as a display_value/value map first
			var valueStr string
			if valuesField, ok := action["values"].(map[string]interface{}); ok {
				valueStr = getDisplayOrValue(valuesField, "value")
			} else if strValue, ok := action["values"].(string); ok {
				// Direct string value
				valueStr = strValue
			}
			if valueStr != "" {
				if decompressed, err := decompressFlowValues(valueStr); err == nil && decompressed != nil {
					action["values_decompressed"] = decompressed
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
			logicQuery.Set("sysparm_fields", "sys_id,order,logic_definition,display_text,parent_ui_id,comment,values")
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
					// Decompress values field for V2 logic instances
					if table == "sys_hub_flow_logic_instance_v2" {
						if valuesField, ok := record["values"].(map[string]interface{}); ok {
							if valueStr := getDisplayOrValue(valuesField, "value"); valueStr != "" {
								if decompressed, err := decompressFlowValues(valueStr); err == nil && decompressed != nil {
									logicMap["values_decompressed"] = decompressed
								}
							}
						}
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

	return inspection, nil
}

// resolveActionTypeNames looks up display names for action_type references
// and sets the display_value on each action's action_type map.
func (c *Client) resolveActionTypeNames(ctx context.Context, actions []map[string]interface{}) {
	cache := make(map[string]string)
	for _, action := range actions {
		if at, ok := action["action_type"].(map[string]interface{}); ok {
			actionID := getString(at, "value")
			if actionID == "" {
				continue
			}
			if name, found := cache[actionID]; found {
				at["display_value"] = name
				continue
			}
			typeQuery := url.Values{}
			typeQuery.Set("sysparm_query", fmt.Sprintf("sys_id=%s", actionID))
			typeQuery.Set("sysparm_fields", "sys_id,name")
			typeQuery.Set("sysparm_limit", "1")
			if typeResp, err := c.Get(ctx, "sys_hub_action_type_base", typeQuery); err == nil && len(typeResp.Result) > 0 {
				if name := getString(typeResp.Result[0], "name"); name != "" {
					at["display_value"] = name
					cache[actionID] = name
				}
			}
		}
	}
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

// decompressFlowValues decompresses gzipped, base64-encoded flow data.
// This handles the values field from sys_hub_action_instance_v2 and
// sys_hub_flow_logic_instance_v2 tables.
// Note: ServiceNow sometimes returns corrupted gzip data that cannot be
// fully decompressed. In these cases, we return nil and the caller should
// fall back to the flow version payload which contains the same data in plain JSON.
func decompressFlowValues(value string) ([]map[string]interface{}, error) {
	if value == "" {
		return nil, nil
	}

	// Check if it looks like base64 (starts with common gzip magic bytes in base64)
	// H4sI = gzip magic bytes in base64
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		// Not base64, try parsing as plain JSON
		var result map[string]interface{}
		if jsonErr := json.Unmarshal([]byte(value), &result); jsonErr == nil {
			return []map[string]interface{}{result}, nil
		}
		return nil, fmt.Errorf("failed to decode value: %w", err)
	}

	// Try gzip decompress
	reader, err := gzip.NewReader(bytes.NewReader(decoded))
	if err != nil {
		// Not gzipped, try parsing decoded bytes as JSON
		var result []map[string]interface{}
		if jsonErr := json.Unmarshal(decoded, &result); jsonErr == nil {
			return result, nil
		}
		// Try as single object
		var objResult map[string]interface{}
		if jsonErr := json.Unmarshal(decoded, &objResult); jsonErr == nil {
			return []map[string]interface{}{objResult}, nil
		}
		return nil, fmt.Errorf("failed to decompress value: %w", err)
	}
	defer reader.Close()

	// Read decompressed data - ignore errors as ServiceNow sometimes sends
	// corrupted gzip data with invalid checksums
	decompressed, _ := io.ReadAll(reader)
	if len(decompressed) == 0 {
		return nil, fmt.Errorf("no data decompressed")
	}

	// Try to parse as JSON array
	var result []map[string]interface{}
	if err := json.Unmarshal(decompressed, &result); err == nil {
		return result, nil
	}

	// Try as single object
	var objResult map[string]interface{}
	if err := json.Unmarshal(decompressed, &objResult); err == nil {
		return []map[string]interface{}{objResult}, nil
	}

	return nil, fmt.Errorf("failed to parse decompressed JSON: %w", err)
}
