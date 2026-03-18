package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// BusinessRule represents a ServiceNow business rule (sys_script record).
type BusinessRule struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Collection  string `json:"collection"`
	When        string `json:"when"`
	Order       int    `json:"order,string"`
	Filter      string `json:"filter_condition"`
	Condition   string `json:"condition"`
	Description string `json:"description"`
	Script      string `json:"script"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListRulesOptions holds options for listing business rules.
type ListRulesOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListRules retrieves business rules from sys_script.
func (c *Client) ListRules(ctx context.Context, opts *ListRulesOptions) ([]BusinessRule, error) {
	if opts == nil {
		opts = &ListRulesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,collection,when,order,filter_condition,condition,description,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	resp, err := c.Get(ctx, "sys_script", query)
	if err != nil {
		return nil, err
	}

	rules := make([]BusinessRule, len(resp.Result))
	for i, record := range resp.Result {
		rules[i] = ruleFromRecord(record)
	}

	return rules, nil
}

// GetRule retrieves a single business rule by sys_id.
func (c *Client) GetRule(ctx context.Context, sysID string) (*BusinessRule, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,collection,when,order,filter_condition,condition,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_script", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("business rule not found: %s", sysID)
	}

	rule := ruleFromRecord(resp.Result[0])
	return &rule, nil
}

// ruleFromRecord converts a record map to a BusinessRule struct.
func ruleFromRecord(record map[string]interface{}) BusinessRule {
	return BusinessRule{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Collection:  getString(record, "collection"),
		When:        getString(record, "when"),
		Order:       getInt(record, "order"),
		Filter:      getString(record, "filter_condition"),
		Condition:   getString(record, "condition"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}
