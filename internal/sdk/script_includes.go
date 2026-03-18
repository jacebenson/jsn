package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// ScriptInclude represents a ServiceNow script include (sys_script_include record).
type ScriptInclude struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Scope       string `json:"scope"`
	SysScope    string `json:"sys_scope"`
	Description string `json:"description"`
	Script      string `json:"script"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListScriptIncludesOptions holds options for listing script includes.
type ListScriptIncludesOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListScriptIncludes retrieves script includes from sys_script_include.
func (c *Client) ListScriptIncludes(ctx context.Context, opts *ListScriptIncludesOptions) ([]ScriptInclude, error) {
	if opts == nil {
		opts = &ListScriptIncludesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,scope,sys_scope,description,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	resp, err := c.Get(ctx, "sys_script_include", query)
	if err != nil {
		return nil, err
	}

	scripts := make([]ScriptInclude, len(resp.Result))
	for i, record := range resp.Result {
		scripts[i] = scriptIncludeFromRecord(record)
	}

	return scripts, nil
}

// GetScriptInclude retrieves a single script include by name or sys_id.
func (c *Client) GetScriptInclude(ctx context.Context, identifier string) (*ScriptInclude, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,scope,sys_scope,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_script_include", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("script include not found: %s", identifier)
	}

	script := scriptIncludeFromRecord(resp.Result[0])
	return &script, nil
}

// scriptIncludeFromRecord converts a record map to a ScriptInclude struct.
func scriptIncludeFromRecord(record map[string]interface{}) ScriptInclude {
	return ScriptInclude{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Scope:       getString(record, "scope"),
		SysScope:    getString(record, "sys_scope"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}
