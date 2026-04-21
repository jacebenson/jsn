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

// ListApplicationsOptions holds options for listing applications.
type ListApplicationsOptions struct {
	Limit  int
	Offset int
	Query  string
}

// ListApplications retrieves applications/scopes from sys_scope.
// Pass limit=0 to fetch all applications (uses pagination).
func (c *Client) ListApplications(ctx context.Context, limit int) ([]Application, error) {
	opts := &ListApplicationsOptions{
		Limit: limit,
	}
	return c.ListApplicationsWithOptions(ctx, opts)
}

// ListApplicationsWithOptions retrieves applications with full options.
func (c *Client) ListApplicationsWithOptions(ctx context.Context, opts *ListApplicationsOptions) ([]Application, error) {
	if opts == nil {
		opts = &ListApplicationsOptions{}
	}

	// If limit is 0, fetch all using pagination
	if opts.Limit == 0 && opts.Offset == 0 {
		return c.listAllApplications(ctx)
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}

	query := url.Values{}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	query.Set("sysparm_fields", "sys_id,name,scope,description")
	query.Set("sysparm_orderby", "name")

	if opts.Query != "" {
		query.Set("sysparm_query", opts.Query)
	}

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

// listAllApplications fetches all applications using pagination.
func (c *Client) listAllApplications(ctx context.Context) ([]Application, error) {
	var allApps []Application
	offset := 0
	batchSize := 250

	for {
		query := url.Values{}
		query.Set("sysparm_limit", fmt.Sprintf("%d", batchSize))
		query.Set("sysparm_offset", fmt.Sprintf("%d", offset))
		query.Set("sysparm_fields", "sys_id,name,scope,description")
		query.Set("sysparm_orderby", "name")

		resp, err := c.Get(ctx, "sys_scope", query)
		if err != nil {
			return nil, err
		}

		if len(resp.Result) == 0 {
			break
		}

		for _, record := range resp.Result {
			allApps = append(allApps, applicationFromRecord(record))
		}

		if len(resp.Result) < batchSize {
			break
		}

		offset += batchSize
	}

	return allApps, nil
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

// CreateApplicationOptions holds options for creating a new scoped application.
type CreateApplicationOptions struct {
	Name        string
	Scope       string
	Description string
	Version     string
}

// CreateApplication creates a new scoped application in sys_app.
func (c *Client) CreateApplication(ctx context.Context, opts CreateApplicationOptions) (*Application, error) {
	data := map[string]interface{}{
		"name":  opts.Name,
		"scope": opts.Scope,
	}

	if opts.Description != "" {
		data["short_description"] = opts.Description
	}
	if opts.Version != "" {
		data["version"] = opts.Version
	}

	resp, err := c.Post(ctx, "sys_app", data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	app := applicationFromRecord(resp.Result)
	return &app, nil
}

// GetProperty retrieves a single system property by name from sys_properties.
func (c *Client) GetProperty(ctx context.Context, name string) (string, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "value")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", name))

	resp, err := c.Get(ctx, "sys_properties", query)
	if err != nil {
		return "", err
	}
	if len(resp.Result) == 0 {
		return "", fmt.Errorf("property not found: %s", name)
	}
	return getString(resp.Result[0], "value"), nil
}

func applicationFromRecord(record map[string]interface{}) Application {
	return Application{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Scope:       getString(record, "scope"),
		Description: getString(record, "description"),
	}
}
