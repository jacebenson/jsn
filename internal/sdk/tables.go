package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// Table represents a ServiceNow table (sys_db_object record).
type Table struct {
	Name         string `json:"name"`
	Label        string `json:"label"`
	SysID        string `json:"sys_id"`
	SuperClass   string `json:"super_class,omitempty"`
	Scope        string `json:"sys_scope,omitempty"`
	IsExtendable bool   `json:"is_extendable,string"`
}

// ListTablesOptions holds options for listing tables.
type ListTablesOptions struct {
	Limit       int
	Offset      int
	Query       string
	OrderBy     string
	OrderDesc   bool
	ShowExtends bool
}

// ListTables retrieves tables from sys_db_object with filtering options.
func (c *Client) ListTables(ctx context.Context, opts *ListTablesOptions) ([]Table, error) {
	if opts == nil {
		opts = &ListTablesOptions{}
	}

	query := url.Values{}

	// Set limit
	limit := opts.Limit
	if limit <= 0 {
		limit = 1000
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	// Set fields - always include scope, optionally include super_class.name
	fields := "name,label,sys_id,sys_scope,is_extendable"
	if opts.ShowExtends {
		fields = "name,label,sys_id,sys_scope,super_class.name,is_extendable"
	}
	query.Set("sysparm_fields", fields)

	// Build query with ORDERBY
	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	// Start with ORDERBY clause
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

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	tables := make([]Table, len(resp.Result))
	for i, record := range resp.Result {
		tables[i] = tableFromRecord(record)
	}

	return tables, nil
}

// GetTable retrieves a single table by name.
func (c *Client) GetTable(ctx context.Context, name string) (*Table, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "name,label,sys_id,sys_scope,super_class.name,is_extendable")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", name))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("table not found: %s", name)
	}

	table := tableFromRecord(resp.Result[0])
	return &table, nil
}

// GetChildTables retrieves tables that extend the given table.
func (c *Client) GetChildTables(ctx context.Context, tableName string) ([]Table, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "name,label,sys_id")
	query.Set("sysparm_orderby", "name")
	query.Set("sysparm_query", fmt.Sprintf("super_class.name=%s", tableName))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	tables := make([]Table, len(resp.Result))
	for i, record := range resp.Result {
		tables[i] = tableFromRecord(record)
	}

	return tables, nil
}

// GetTableDisplayColumn returns the display column for a table (e.g., "short_description" for incident).
func (c *Client) GetTableDisplayColumn(ctx context.Context, tableName string) (string, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "name,display_field")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", tableName))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return "", err
	}

	if len(resp.Result) == 0 {
		return "", fmt.Errorf("table not found: %s", tableName)
	}

	displayField := getString(resp.Result[0], "display_field")
	if displayField == "" {
		// Default fallback columns based on common patterns
		switch tableName {
		case "incident", "problem", "change_request", "sc_request", "sc_req_item":
			return "short_description", nil
		case "sys_user", "sys_user_group":
			return "name", nil
		default:
			return "name", nil
		}
	}

	return displayField, nil
}

// tableFromRecord converts a record map to a Table struct.
func tableFromRecord(record map[string]interface{}) Table {
	// super_class.name is returned when dot-walking the reference
	superClass := getString(record, "super_class.name")
	if superClass == "" {
		// Fallback to super_class field if it exists as a string
		superClass = getString(record, "super_class")
	}

	return Table{
		Name:         getString(record, "name"),
		Label:        getString(record, "label"),
		SysID:        getString(record, "sys_id"),
		SuperClass:   superClass,
		Scope:        getString(record, "sys_scope"),
		IsExtendable: getBool(record, "is_extendable"),
	}
}
