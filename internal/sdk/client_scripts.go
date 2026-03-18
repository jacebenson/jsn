package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// ClientScript represents a ServiceNow Client Script (sys_script_client record).
type ClientScript struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Table       string `json:"table_name"`
	Type        string `json:"type"` // onLoad, onChange, onSubmit, onCellEdit
	FieldName   string `json:"field_name"`
	Order       int    `json:"order,string"`
	Script      string `json:"script"`
	Isolate     bool   `json:"isolate_script,string"`
	UiType      string `json:"ui_type"` // desktop, mobile, both
	Description string `json:"description"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListClientScriptsOptions holds options for listing client scripts.
type ListClientScriptsOptions struct {
	Limit     int
	Offset    int
	Table     string
	Type      string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListClientScripts retrieves client scripts from sys_script_client.
func (c *Client) ListClientScripts(ctx context.Context, opts *ListClientScriptsOptions) ([]ClientScript, error) {
	if opts == nil {
		opts = &ListClientScriptsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,table_name,type,field_name,order,isolate_script,ui_type,description,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "order"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	// Add table filter if provided
	if opts.Table != "" {
		sysparmQuery = sysparmQuery + "^table_name=" + opts.Table
	}

	// Add type filter if provided
	if opts.Type != "" {
		sysparmQuery = sysparmQuery + "^type=" + opts.Type
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_script_client", query)
	if err != nil {
		return nil, err
	}

	scripts := make([]ClientScript, len(resp.Result))
	for i, record := range resp.Result {
		scripts[i] = clientScriptFromRecord(record)
	}

	return scripts, nil
}

// GetClientScript retrieves a single client script by sys_id.
func (c *Client) GetClientScript(ctx context.Context, sysID string) (*ClientScript, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,table_name,type,field_name,order,script,isolate_script,ui_type,description,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_script_client", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("client script not found: %s", sysID)
	}

	script := clientScriptFromRecord(resp.Result[0])
	return &script, nil
}

// clientScriptFromRecord converts a record map to a ClientScript struct.
func clientScriptFromRecord(record map[string]interface{}) ClientScript {
	return ClientScript{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Table:       getString(record, "table_name"),
		Type:        getString(record, "type"),
		FieldName:   getString(record, "field_name"),
		Order:       getInt(record, "order"),
		Script:      getString(record, "script"),
		Isolate:     getBool(record, "isolate_script"),
		UiType:      getString(record, "ui_type"),
		Description: getString(record, "description"),
		Scope:       getString(record, "sys_scope"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}
