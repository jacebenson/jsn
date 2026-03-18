package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// ACL represents a ServiceNow Access Control List (sys_security_acl record).
type ACL struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Operation   string `json:"operation"`
	Type        string `json:"type"`
	Field       string `json:"field_name"` // For field ACLs
	Advanced    bool   `json:"advanced,string"`
	Condition   string `json:"condition"`
	Script      string `json:"script"`
	Description string `json:"description"`
	AdminOver   bool   `json:"admin_overrides,string"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ACLRole represents an ACL role assignment (sys_security_acl_role record).
type ACLRole struct {
	SysID    string `json:"sys_id"`
	ACL      string `json:"sys_security_acl"`
	Role     string `json:"sys_user_role"`
	RoleName string `json:"sys_user_role.name"`
	Active   bool   `json:"active,string"`
}

// ListACLOptions holds options for listing ACLs.
type ListACLOptions struct {
	Limit     int
	Offset    int
	Table     string
	Operation string
	Type      string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListACLs retrieves ACLs from sys_security_acl.
func (c *Client) ListACLs(ctx context.Context, opts *ListACLOptions) ([]ACL, error) {
	if opts == nil {
		opts = &ListACLOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,operation,type,field_name,advanced,condition,description,admin_overrides,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	// Use display_value to get string values for reference fields (operation, type)
	query.Set("sysparm_display_value", "true")

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

	// Add table filter if provided (ACL name typically contains table.field)
	if opts.Table != "" {
		sysparmQuery = sysparmQuery + "^nameSTARTSWITH" + opts.Table + "."
	}

	// Add operation filter if provided
	if opts.Operation != "" {
		sysparmQuery = sysparmQuery + "^operation=" + opts.Operation
	}

	// Add type filter if provided
	if opts.Type != "" {
		sysparmQuery = sysparmQuery + "^type=" + opts.Type
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_security_acl", query)
	if err != nil {
		return nil, err
	}

	acls := make([]ACL, len(resp.Result))
	for i, record := range resp.Result {
		acls[i] = aclFromRecord(record)
	}

	return acls, nil
}

// GetACL retrieves a single ACL by sys_id.
func (c *Client) GetACL(ctx context.Context, sysID string) (*ACL, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,operation,type,field_name,advanced,condition,script,description,admin_overrides,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "true")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_security_acl", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("ACL not found: %s", sysID)
	}

	acl := aclFromRecord(resp.Result[0])
	return &acl, nil
}

// GetACLRoles retrieves roles assigned to an ACL.
func (c *Client) GetACLRoles(ctx context.Context, aclSysID string) ([]ACLRole, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,sys_security_acl,sys_user_role,sys_user_role.name,active")
	query.Set("sysparm_query", fmt.Sprintf("sys_security_acl=%s", aclSysID))

	resp, err := c.Get(ctx, "sys_security_acl_role", query)
	if err != nil {
		return nil, err
	}

	roles := make([]ACLRole, len(resp.Result))
	for i, record := range resp.Result {
		roles[i] = aclRoleFromRecord(record)
	}

	return roles, nil
}

// aclFromRecord converts a record map to an ACL struct.
func aclFromRecord(record map[string]interface{}) ACL {
	return ACL{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Operation:   getDisplayValue(record, "operation"),
		Type:        getDisplayValue(record, "type"),
		Field:       getString(record, "field_name"),
		Advanced:    getBool(record, "advanced"),
		Condition:   getString(record, "condition"),
		Script:      getString(record, "script"),
		Description: getString(record, "description"),
		AdminOver:   getBool(record, "admin_overrides"),
		Scope:       getString(record, "sys_scope"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// aclRoleFromRecord converts a record map to an ACLRole struct.
func aclRoleFromRecord(record map[string]interface{}) ACLRole {
	return ACLRole{
		SysID:    getString(record, "sys_id"),
		ACL:      getString(record, "sys_security_acl"),
		Role:     getString(record, "sys_user_role"),
		RoleName: getString(record, "sys_user_role.name"),
		Active:   getBool(record, "active"),
	}
}
