package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// User represents a ServiceNow user.
type User struct {
	SysID    string `json:"sys_id"`
	UserName string `json:"user_name"`
	Name     string `json:"name"`
	Email    string `json:"email"`
}

// GetCurrentUser retrieves the current user's info.
func (c *Client) GetCurrentUser(ctx context.Context) (*User, error) {
	params := url.Values{}
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,user_name,name,email")
	params.Set("sysparm_query", "sys_id=javascript:gs.getUserID()")

	records, err := c.List(ctx, "sys_user", params)
	if err != nil {
		return nil, fmt.Errorf("failed to query current user: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("could not determine current user from session")
	}

	return userFromRecord(records[0]), nil
}

// userFromRecord converts a record map to a User struct.
func userFromRecord(record map[string]any) *User {
	return &User{
		SysID:    getString(record, "sys_id"),
		UserName: getString(record, "user_name"),
		Name:     getString(record, "name"),
		Email:    getString(record, "email"),
	}
}

// UpdateSet represents a ServiceNow update set.
type UpdateSet struct {
	SysID string `json:"sys_id"`
	Name  string `json:"name"`
}

// GetCurrentUpdateSet retrieves the current update set for the user from sys_user_preference.
func (c *Client) GetCurrentUpdateSet(ctx context.Context, userID string) (*UpdateSet, error) {
	// First, get the update set sys_id from user preferences
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "value")
	query.Set("sysparm_query", "user="+userID+"^name=sys_update_set")

	prefRecords, err := c.List(ctx, "sys_user_preference", query)
	if err != nil {
		return nil, fmt.Errorf("failed to query user preference: %w", err)
	}

	// No preference set - return default
	if len(prefRecords) == 0 {
		return &UpdateSet{Name: "-"}, nil
	}

	// Get the update set sys_id from the preference value
	updateSetSysID := getString(prefRecords[0], "value")
	if updateSetSysID == "" {
		return &UpdateSet{Name: "-"}, nil
	}

	// Now fetch the update set name
	usQuery := url.Values{}
	usQuery.Set("sysparm_limit", "1")
	usQuery.Set("sysparm_fields", "sys_id,name")
	usQuery.Set("sysparm_query", "sys_id="+updateSetSysID)

	usRecords, err := c.List(ctx, "sys_update_set", usQuery)
	if err != nil {
		return nil, fmt.Errorf("failed to query update set details: %w", err)
	}

	if len(usRecords) == 0 {
		// Preference exists but update set was deleted - return default
		return &UpdateSet{Name: "-"}, nil
	}

	return &UpdateSet{
		SysID: getString(usRecords[0], "sys_id"),
		Name:  getString(usRecords[0], "name"),
	}, nil
}

// Application represents a ServiceNow application scope.
type Application struct {
	SysID string `json:"sys_id"`
	Scope string `json:"scope"`
	Name  string `json:"name"`
}

// GetCurrentApplication retrieves the current application scope for the user from sys_user_preference.
func (c *Client) GetCurrentApplication(ctx context.Context, userID string) (*Application, error) {
	// First, get the application sys_id from user preferences
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "value")
	query.Set("sysparm_query", "user="+userID+"^name=apps.current_app")

	prefRecords, err := c.List(ctx, "sys_user_preference", query)
	if err != nil {
		return nil, fmt.Errorf("failed to query user preference: %w", err)
	}

	// No preference set - return global
	if len(prefRecords) == 0 {
		return &Application{Scope: "global"}, nil
	}

	// Get the application sys_id from the preference value
	appSysID := getString(prefRecords[0], "value")
	if appSysID == "" || appSysID == "global" {
		return &Application{Scope: "global"}, nil
	}

	// Now fetch the application scope details
	appQuery := url.Values{}
	appQuery.Set("sysparm_limit", "1")
	appQuery.Set("sysparm_fields", "sys_id,scope,name")
	appQuery.Set("sysparm_query", "sys_id="+appSysID)

	// Try sys_scope first, then sys_app
	appRecords, err := c.List(ctx, "sys_scope", appQuery)
	if err != nil || len(appRecords) == 0 {
		appRecords, err = c.List(ctx, "sys_app", appQuery)
		if err != nil {
			return nil, fmt.Errorf("failed to query application details: %w", err)
		}
	}

	if len(appRecords) == 0 {
		// Preference exists but application was deleted - return global
		return &Application{Scope: "global"}, nil
	}

	return &Application{
		SysID: getString(appRecords[0], "sys_id"),
		Scope: getString(appRecords[0], "scope"),
		Name:  getString(appRecords[0], "name"),
	}, nil
}
