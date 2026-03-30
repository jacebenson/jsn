package sdk

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// ListRecordsOptions holds options for listing records from any table.
type ListRecordsOptions struct {
	Limit     int
	Offset    int
	Query     string
	Fields    []string
	OrderBy   string
	OrderDesc bool
}

// ListRecords retrieves records from any table.
func (c *Client) ListRecords(ctx context.Context, table string, opts *ListRecordsOptions) ([]map[string]interface{}, error) {
	if opts == nil {
		opts = &ListRecordsOptions{}
	}

	query := url.Values{}

	// Set limit
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	// Set fields - always include sys_id
	fields := opts.Fields
	if len(fields) == 0 {
		// Default fields: sys_id, number, and display value fields
		fields = []string{"sys_id", "number", "name", "short_description", "sys_updated_on"}
	}
	// Ensure sys_id is always included
	hasSysID := false
	for _, f := range fields {
		if f == "sys_id" {
			hasSysID = true
			break
		}
	}
	if !hasSysID {
		fields = append([]string{"sys_id"}, fields...)
	}
	query.Set("sysparm_fields", strings.Join(fields, ","))

	// Build query with ORDERBY
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

	// Append user query if provided
	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	// Add display value parameter to get reference field display values
	query.Set("sysparm_display_value", "true")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	return resp.Result, nil
}

// GetRecord retrieves a single record by sys_id.
func (c *Client) GetRecord(ctx context.Context, table, sysID string) (map[string]interface{}, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))
	query.Set("sysparm_display_value", "all")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("record not found: %s", sysID)
	}

	return resp.Result[0], nil
}

// CreateRecord creates a new record in the specified table.
func (c *Client) CreateRecord(ctx context.Context, table string, data map[string]interface{}) (map[string]interface{}, error) {
	resp, err := c.Post(ctx, table, data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	return resp.Result, nil
}

// UpdateRecord updates an existing record by sys_id.
func (c *Client) UpdateRecord(ctx context.Context, table, sysID string, data map[string]interface{}) (map[string]interface{}, error) {
	resp, err := c.Patch(ctx, table, sysID, data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update")
	}

	return resp.Result, nil
}

// DeleteRecord deletes a record by sys_id.
func (c *Client) DeleteRecord(ctx context.Context, table, sysID string) error {
	return c.Delete(ctx, table, sysID)
}

// GetRecordNumber retrieves a record by its number field (e.g., INC0010001).
func (c *Client) GetRecordByNumber(ctx context.Context, table, number string) (map[string]interface{}, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("number=%s", number))
	query.Set("sysparm_display_value", "true")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("record not found: %s", number)
	}

	return resp.Result[0], nil
}
