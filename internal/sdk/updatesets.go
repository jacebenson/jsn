package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// UpdateSet represents a ServiceNow update set (sys_update_set record).
type UpdateSet struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	State       string `json:"state"`
	Application string `json:"application"`
	AppName     string `json:"application.name"`
	Description string `json:"description"`
	Parent      string `json:"parent"`
	ParentName  string `json:"parent.name"`
	CreatedBy   string `json:"sys_created_by"`
	CreatedOn   string `json:"sys_created_on"`
	UpdatedBy   string `json:"sys_updated_by"`
	UpdatedOn   string `json:"sys_updated_on"`
}

// ListUpdateSetsOptions holds options for listing update sets.
type ListUpdateSetsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListUpdateSets retrieves update sets from sys_update_set.
func (c *Client) ListUpdateSets(ctx context.Context, opts *ListUpdateSetsOptions) ([]UpdateSet, error) {
	if opts == nil {
		opts = &ListUpdateSetsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")

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

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	updateSets := make([]UpdateSet, len(resp.Result))
	for i, record := range resp.Result {
		updateSets[i] = updateSetFromRecord(record)
	}

	return updateSets, nil
}

// GetUpdateSet retrieves a single update set by name or sys_id.
func (c *Client) GetUpdateSet(ctx context.Context, identifier string) (*UpdateSet, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("update set not found: %s", identifier)
	}

	updateSet := updateSetFromRecord(resp.Result[0])
	return &updateSet, nil
}

// GetChildUpdateSets retrieves update sets that have this one as a parent.
func (c *Client) GetChildUpdateSets(ctx context.Context, parentSysID string) ([]UpdateSet, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")
	query.Set("sysparm_orderby", "name")
	query.Set("sysparm_query", fmt.Sprintf("parent=%s", parentSysID))

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	updateSets := make([]UpdateSet, len(resp.Result))
	for i, record := range resp.Result {
		updateSets[i] = updateSetFromRecord(record)
	}

	return updateSets, nil
}

// CreateUpdateSet creates a new update set.
func (c *Client) CreateUpdateSet(ctx context.Context, name, scope, description, parent string) (*UpdateSet, error) {
	data := map[string]interface{}{
		"name": name,
	}

	if description != "" {
		data["description"] = description
	}

	if scope != "" {
		data["application"] = scope
	}

	if parent != "" {
		data["parent"] = parent
	}

	resp, err := c.Post(ctx, "sys_update_set", data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	updateSet := updateSetFromRecord(resp.Result)
	return &updateSet, nil
}

// UpdateUpdateSet updates an existing update set.
func (c *Client) UpdateUpdateSet(ctx context.Context, sysID string, updates map[string]interface{}) (*UpdateSet, error) {
	resp, err := c.Patch(ctx, "sys_update_set", sysID, updates)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update")
	}

	updateSet := updateSetFromRecord(resp.Result)
	return &updateSet, nil
}

func updateSetFromRecord(record map[string]interface{}) UpdateSet {
	return UpdateSet{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		State:       getString(record, "state"),
		Application: getString(record, "application"),
		AppName:     getString(record, "application.name"),
		Description: getString(record, "description"),
		Parent:      getString(record, "parent"),
		ParentName:  getString(record, "parent.name"),
		CreatedBy:   getString(record, "sys_created_by"),
		CreatedOn:   getString(record, "sys_created_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
	}
}
