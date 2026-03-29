package sdk

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// User represents a ServiceNow user (sys_user record).
type User struct {
	SysID    string `json:"sys_id"`
	UserName string `json:"user_name"`
	Name     string `json:"name"`
	Email    string `json:"email"`
}

// UserPreference represents a user preference (sys_user_preference record).
type UserPreference struct {
	SysID    string `json:"sys_id"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	User     string `json:"user"`
	UserName string `json:"user.user_name"`
}

// GetCurrentUser retrieves the currently authenticated user.
// Uses gs.getUserID() via background script to get the actual current user's sys_id,
// then queries sys_user for the full user record.
func (c *Client) GetCurrentUser(ctx context.Context) (*User, error) {
	// Use background script to get the current user's sys_id
	script := "gs.print(gs.getUserID());"
	result, err := c.Eval(ctx, script, DefaultEvalOptions())
	if err != nil {
		return nil, fmt.Errorf("failed to get current user ID: %w", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("script error: %s", result.Error)
	}

	// Parse the output to get the sys_id
	userID := strings.TrimSpace(result.Output)
	if userID == "" {
		return nil, fmt.Errorf("could not determine current user ID")
	}

	// Query sys_user for the full user record
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,user_name,name,email")
	query.Set("sysparm_query", "sys_id="+userID)

	resp, err := c.Get(ctx, "sys_user", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("user not found: %s", userID)
	}

	user := userFromRecord(resp.Result[0])
	return &user, nil
}

// GetUserPreference retrieves a user preference by name for the current user.
func (c *Client) GetUserPreference(ctx context.Context, userID, name string) (*UserPreference, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,value,user,user.user_name")
	query.Set("sysparm_query", fmt.Sprintf("user=%s^name=%s", userID, name))

	resp, err := c.Get(ctx, "sys_user_preference", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, nil
	}

	pref := userPreferenceFromRecord(resp.Result[0])
	return &pref, nil
}

// SetUserPreference creates or updates a user preference.
func (c *Client) SetUserPreference(ctx context.Context, userID, name, value string) error {
	// Check if preference already exists
	existing, err := c.GetUserPreference(ctx, userID, name)
	if err != nil {
		return err
	}

	data := map[string]interface{}{
		"user":  userID,
		"name":  name,
		"value": value,
	}

	if existing != nil {
		// Update existing
		_, err = c.Patch(ctx, "sys_user_preference", existing.SysID, data)
	} else {
		// Create new
		_, err = c.Post(ctx, "sys_user_preference", data)
	}

	return err
}

// GetCurrentUpdateSet retrieves the current update set for the user.
func (c *Client) GetCurrentUpdateSet(ctx context.Context, userID string) (*UpdateSet, error) {
	pref, err := c.GetUserPreference(ctx, userID, "sys_update_set")
	if err != nil {
		return nil, err
	}

	if pref == nil || pref.Value == "" {
		return nil, nil
	}

	return c.GetUpdateSet(ctx, pref.Value)
}

// SetCurrentUpdateSet sets the current update set for the user.
func (c *Client) SetCurrentUpdateSet(ctx context.Context, userID, updateSetSysID string) error {
	return c.SetUserPreference(ctx, userID, "sys_update_set", updateSetSysID)
}

// GetCurrentApplication retrieves the current application scope for the user.
func (c *Client) GetCurrentApplication(ctx context.Context, userID string) (*Application, error) {
	pref, err := c.GetUserPreference(ctx, userID, "apps.current_app")
	if err != nil {
		return nil, err
	}

	if pref == nil || pref.Value == "" {
		return nil, nil
	}

	return c.GetApplication(ctx, pref.Value)
}

// SetCurrentApplication sets the current application scope for the user.
func (c *Client) SetCurrentApplication(ctx context.Context, userID, appSysID string) error {
	return c.SetUserPreference(ctx, userID, "apps.current_app", appSysID)
}

func userFromRecord(record map[string]interface{}) User {
	return User{
		SysID:    getString(record, "sys_id"),
		UserName: getString(record, "user_name"),
		Name:     getString(record, "name"),
		Email:    getString(record, "email"),
	}
}

func userPreferenceFromRecord(record map[string]interface{}) UserPreference {
	return UserPreference{
		SysID:    getString(record, "sys_id"),
		Name:     getString(record, "name"),
		Value:    getString(record, "value"),
		User:     getString(record, "user"),
		UserName: getString(record, "user.user_name"),
	}
}
