// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUIActionsCmd(t *testing.T) {
	cmd := NewUIActionsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "uiactions")
	assert.Equal(t, []string{"uiaction", "ua"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestUIActionsListCmd(t *testing.T) {
	cmd := newUIActionsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestUIActionsShowCmd(t *testing.T) {
	cmd := newUIActionsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestUIActionsCreateCmd(t *testing.T) {
	cmd := newUIActionsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("client-script"))
	assert.NotNil(t, flags.Lookup("condition"))
	assert.NotNil(t, flags.Lookup("order"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("show-insert"))
	assert.NotNil(t, flags.Lookup("show-update"))
	assert.NotNil(t, flags.Lookup("show-delete"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestUIActionsUpdateCmd(t *testing.T) {
	cmd := newUIActionsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("active"))
}

func TestUIActionsDeleteCmd(t *testing.T) {
	cmd := newUIActionsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestUIActionsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Test Action", "value": "Test Action"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}, "order": {"display_value": "100", "value": "100"}},
			{"sys_id": "def456", "name": {"display_value": "Another Action", "value": "Another Action"}, "table": {"display_value": "task", "value": "task"}, "active": {"display_value": "false", "value": "false"}, "order": {"display_value": "200", "value": "200"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "list", "--query", "table=incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "table")
}

func TestUIActionsShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My UI Action", "value": "My UI Action"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}, "script": {"display_value": "gs.info('Hello');", "value": "gs.info('Hello');"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "show", "My UI Action")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "My UI Action", "value": "My UI Action"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "show", "NonExistentAction")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIActionsCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Create response
			`{"result": {"sys_id": "newaction123", "name": "New Action", "table": "incident", "active": "true"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Action", "--table", "incident", "--script", "gs.info('test');")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsCreateRequiresName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--script", "gs.info('test');")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--name is required")
}

func TestUIActionsCreateRequiresTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Action", "--script", "gs.info('test');")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--table")
}

func TestUIActionsCreateRequiresScript(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Action", "--table", "incident")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--script")
}

func TestUIActionsUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find action
			`{"result": [{"sys_id": "abc123", "name": "My Action", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "name": "My Action", "active": "false"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "update", "My Action", "--data", `{"active": false}`)

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "update", "NonExistentAction", "--data", `{"active": false}`)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIActionsUpdateNoData(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "My Action", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "update", "My Action")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates specified")
}

func TestUIActionsUpdateWithConvenienceFlags(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find action
			`{"result": [{"sys_id": "abc123", "name": "My Action", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "name": "My Action", "active": "false", "script": "gs.info('Updated');"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "update", "My Action", "--script", "gs.info('Updated');", "--active=false")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find action
			`{"result": [{"sys_id": "abc123", "name": "My Action", "table": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Delete response (empty 200)
			`{}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "delete", "My Action", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}

func TestUIActionsDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentAction", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUIActionsRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUIActionsCmd()
	// No args - should show help (which returns nil in cobra 1.8+)
	err := executeCommand(cmd, app)
	assert.NoError(t, err)
}

func TestUIActionsGetByNameIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Specific Action", "value": "Specific Action"}, "table": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newUIActionsShowCmd()
	err := executeCommand(cmd, app, "Specific Action")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_action"))
}
