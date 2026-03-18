package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// UIPolicy represents a ServiceNow UI Policy (sys_ui_policy record).
type UIPolicy struct {
	SysID          string `json:"sys_id"`
	Name           string `json:"name"`
	Active         bool   `json:"active,string"`
	Table          string `json:"table"`
	ShortDesc      string `json:"short_description"`
	Order          int    `json:"order,string"`
	RunScripts     bool   `json:"run_scripts,string"`
	IsolateScript  bool   `json:"isolate_script,string"`
	OnLoad         bool   `json:"onload,string"`
	OnChange       bool   `json:"onchange,string"`
	Conditions     string `json:"conditions"`
	ScriptTrue     string `json:"script_true"`
	ScriptFalse    string `json:"script_false"`
	ReverseIfFalse bool   `json:"reverse_if_false,string"`
	Inherited      bool   `json:"sys_policy_inherited,string"`
	Scope          string `json:"sys_scope"`
	CreatedOn      string `json:"sys_created_on"`
	CreatedBy      string `json:"sys_created_by"`
	UpdatedOn      string `json:"sys_updated_on"`
	UpdatedBy      string `json:"sys_updated_by"`
}

// ListUIPoliciesOptions holds options for listing UI policies.
type ListUIPoliciesOptions struct {
	Limit     int
	Offset    int
	Table     string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListUIPolicies retrieves UI policies from sys_ui_policy.
func (c *Client) ListUIPolicies(ctx context.Context, opts *ListUIPoliciesOptions) ([]UIPolicy, error) {
	if opts == nil {
		opts = &ListUIPoliciesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,table,short_description,order,run_scripts,isolate_script,onload,onchange,conditions,reverse_if_false,sys_policy_inherited,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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
		sysparmQuery = sysparmQuery + "^table=" + opts.Table
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_policy", query)
	if err != nil {
		return nil, err
	}

	policies := make([]UIPolicy, len(resp.Result))
	for i, record := range resp.Result {
		policies[i] = uiPolicyFromRecord(record)
	}

	return policies, nil
}

// GetUIPolicy retrieves a single UI policy by sys_id.
func (c *Client) GetUIPolicy(ctx context.Context, sysID string) (*UIPolicy, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,table,short_description,order,run_scripts,isolate_script,onload,onchange,conditions,script_true,script_false,reverse_if_false,sys_policy_inherited,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_ui_policy", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("UI policy not found: %s", sysID)
	}

	policy := uiPolicyFromRecord(resp.Result[0])
	return &policy, nil
}

// uiPolicyFromRecord converts a record map to a UIPolicy struct.
func uiPolicyFromRecord(record map[string]interface{}) UIPolicy {
	return UIPolicy{
		SysID:          getString(record, "sys_id"),
		Name:           getString(record, "name"),
		Active:         getBool(record, "active"),
		Table:          getString(record, "table"),
		ShortDesc:      getString(record, "short_description"),
		Order:          getInt(record, "order"),
		RunScripts:     getBool(record, "run_scripts"),
		IsolateScript:  getBool(record, "isolate_script"),
		OnLoad:         getBool(record, "onload"),
		OnChange:       getBool(record, "onchange"),
		Conditions:     getString(record, "conditions"),
		ScriptTrue:     getString(record, "script_true"),
		ScriptFalse:    getString(record, "script_false"),
		ReverseIfFalse: getBool(record, "reverse_if_false"),
		Inherited:      getBool(record, "sys_policy_inherited"),
		Scope:          getString(record, "sys_scope"),
		CreatedOn:      getString(record, "sys_created_on"),
		CreatedBy:      getString(record, "sys_created_by"),
		UpdatedOn:      getString(record, "sys_updated_on"),
		UpdatedBy:      getString(record, "sys_updated_by"),
	}
}
