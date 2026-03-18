package sdk

import (
	"context"
	"fmt"
	"net/url"
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
func (c *Client) GetCurrentUser(ctx context.Context) (*User, error) {
	// Get username from auth credentials
	username, _ := c.getAuth()

	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,user_name,name,email")

	// Query by username if available, otherwise get first active user
	if username != "" {
		query.Set("sysparm_query", fmt.Sprintf("user_name=%s", username))
	} else {
		query.Set("sysparm_query", "active=true")
	}

	resp, err := c.Get(ctx, "sys_user", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("could not determine current user")
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
