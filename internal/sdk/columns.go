package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// TableColumn represents a column from sys_dictionary.
type TableColumn struct {
	Name         string `json:"element"`
	Label        string `json:"column_label"`
	Type         string `json:"internal_type"`
	Reference    string `json:"reference"`
	Mandatory    bool   `json:"mandatory,string"`
	MaxLength    int    `json:"max_length,string"`
	DefaultValue string `json:"default_value"`
	Comments     string `json:"comments"`
}

// GetTableColumns retrieves columns for a table from sys_dictionary.
func (c *Client) GetTableColumns(ctx context.Context, tableName string) ([]TableColumn, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1000")
	query.Set("sysparm_fields", "element,column_label,internal_type,reference,mandatory,max_length,default_value,comments")
	query.Set("sysparm_orderby", "column_label")
	query.Set("sysparm_query", fmt.Sprintf("name=%s^elementISNOTEMPTY", tableName))

	resp, err := c.Get(ctx, "sys_dictionary", query)
	if err != nil {
		return nil, err
	}

	columns := make([]TableColumn, len(resp.Result))
	for i, record := range resp.Result {
		columns[i] = columnFromRecord(record)
	}

	return columns, nil
}

// columnFromRecord converts a record map to a TableColumn struct.
func columnFromRecord(record map[string]interface{}) TableColumn {
	return TableColumn{
		Name:         getString(record, "element"),
		Label:        getString(record, "column_label"),
		Type:         getString(record, "internal_type"),
		Reference:    getString(record, "reference"),
		Mandatory:    getBool(record, "mandatory"),
		DefaultValue: getString(record, "default_value"),
		Comments:     getString(record, "comments"),
	}
}
