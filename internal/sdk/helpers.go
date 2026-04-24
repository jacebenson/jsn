// Package sdk provides ServiceNow API helpers and utilities.
package sdk

import (
	"context"
	"fmt"
	"net/url"
)

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
