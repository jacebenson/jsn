package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// Application represents a ServiceNow application scope (sys_scope record).
type Application struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Scope       string `json:"scope"`
	Description string `json:"description"`
}

// ListApplications retrieves applications/scopes from sys_scope.
func (c *Client) ListApplications(ctx context.Context, limit int) ([]Application, error) {
	if limit <= 0 {
		limit = 100
	}

	query := url.Values{}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	query.Set("sysparm_fields", "sys_id,name,scope,description")
	query.Set("sysparm_orderby", "name")

	resp, err := c.Get(ctx, "sys_scope", query)
	if err != nil {
		return nil, err
	}

	apps := make([]Application, len(resp.Result))
	for i, record := range resp.Result {
		apps[i] = applicationFromRecord(record)
	}

	return apps, nil
}

// GetApplication retrieves an application by scope name or sys_id.
func (c *Client) GetApplication(ctx context.Context, identifier string) (*Application, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,scope,description")

	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("scope=%s^ORname=%s", identifier, identifier))
	}

	resp, err := c.Get(ctx, "sys_scope", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("application not found: %s", identifier)
	}

	app := applicationFromRecord(resp.Result[0])
	return &app, nil
}

func applicationFromRecord(record map[string]interface{}) Application {
	return Application{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Scope:       getString(record, "scope"),
		Description: getString(record, "description"),
	}
}
