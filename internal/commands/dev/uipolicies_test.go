// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUIPoliciesCmd(t *testing.T) {
	cmd := NewUIPoliciesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "uipolicies")
	assert.Equal(t, []string{"uipolicy", "up"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestUIPoliciesListCmd(t *testing.T) {
	cmd := newUIPoliciesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestUIPoliciesShowCmd(t *testing.T) {
	cmd := newUIPoliciesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [description|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestUIPoliciesCreateCmd(t *testing.T) {
	cmd := newUIPoliciesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("description"))
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("condition"))
	assert.NotNil(t, flags.Lookup("order"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("run-scripts"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestUIPoliciesUpdateCmd(t *testing.T) {
	cmd := newUIPoliciesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [description|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("condition"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("order"))
}

func TestUIPoliciesDeleteCmd(t *testing.T) {
	cmd := newUIPoliciesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [description|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestUIPoliciesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "short_description": {"display_value": "Test Policy", "value": "Test Policy"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}, "order": {"display_value": "100", "value": "100"}},
			{"sys_id": "def456", "short_description": {"display_value": "Another Policy", "value": "Another Policy"}, "table": {"display_value": "task", "value": "task"}, "active": {"display_value": "false", "value": "false"}, "order": {"display_value": "200", "value": "200"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "list", "--query", "table=incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "table")
}

func TestUIPoliciesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "short_description": {"display_value": "My UI Policy", "value": "My UI Policy"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}, "condition": {"display_value": "state==1", "value": "state==1"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "show", "My UI Policy")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "short_description": {"display_value": "My UI Policy", "value": "My UI Policy"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "show", "NonExistentPolicy")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIPoliciesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Create response
			`{"result": {"sys_id": "newpolicy123", "short_description": "New Policy", "table": "incident", "active": "true"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "create", "--description", "New Policy", "--table", "incident", "--condition", "state==1")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesCreateRequiresDescription(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--description is required")
}

func TestUIPoliciesCreateRequiresTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "create", "--description", "New Policy")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--table is required")
}

func TestUIPoliciesUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find policy
			`{"result": [{"sys_id": "abc123", "short_description": "My Policy", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "short_description": "My Policy", "active": "false"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "update", "My Policy", "--data", `{"active": false}`)

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "update", "NonExistentPolicy", "--data", `{"active": false}`)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIPoliciesUpdateNoData(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "short_description": "My Policy", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "update", "My Policy")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates specified")
}

func TestUIPoliciesUpdateWithConvenienceFlags(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find policy
			`{"result": [{"sys_id": "abc123", "short_description": "My Policy", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "short_description": "My Policy", "active": "false", "condition": "state==2"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "update", "My Policy", "--condition", "state==2", "--active=false")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find policy
			`{"result": [{"sys_id": "abc123", "short_description": "My Policy", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Delete response (empty 200)
			`{}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "delete", "My Policy", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}

func TestUIPoliciesDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentPolicy", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIPoliciesRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	// No args - should show help (which returns nil in cobra 1.8+)
	err := executeCommand(cmd, app)
	assert.NoError(t, err)
}

func TestUIPoliciesGetByDescriptionIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "short_description": {"display_value": "Specific Policy", "value": "Specific Policy"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIPoliciesCmd()
	err := executeCommand(cmd, app, "show", "Specific Policy")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_policy"))
}
