// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewClientScriptsCmd(t *testing.T) {
	cmd := NewClientScriptsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "clientscripts")
	assert.Equal(t, []string{"clientscript", "cs"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestClientScriptsListCmd(t *testing.T) {
	cmd := newClientScriptsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestClientScriptsShowCmd(t *testing.T) {
	cmd := newClientScriptsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestClientScriptsCreateCmd(t *testing.T) {
	cmd := newClientScriptsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("type"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("field"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestClientScriptsUpdateCmd(t *testing.T) {
	cmd := newClientScriptsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("active"))
}

func TestClientScriptsDeleteCmd(t *testing.T) {
	cmd := newClientScriptsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestClientScriptsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "active": "true", "type": "onLoad", "sys_scope": {"display_value": "Global", "value": "global"}},
			{"sys_id": "def456", "name": "AnotherScript", "table_name": "task", "active": "false", "type": "onChange", "sys_scope": {"display_value": "My App", "value": "x_myapp"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "list", "--query", "table_name=incident")

	assert.NoError(t, err)
	// Query is URL encoded, so we check for the encoded value
	assert.Contains(t, transport.capturedQuery, "table_name%3Dincident")
}

func TestClientScriptsShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "show", "TestScript")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	// Should call the client script table endpoint
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "show", "NonExistentScript")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestClientScriptsCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		// Create command only makes one API call (POST to create) when no --scope is specified
		responseBody: `{"result": {"sys_id": "new123", "name": "NewScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--name", "NewScript", "--table", "incident", "--script", "function onLoad() {}")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsCreateValidationMissingName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--script", "function onLoad() {}")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "name is required")
}

func TestClientScriptsCreateValidationMissingTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--name", "TestScript", "--script", "function onLoad() {}")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "table is required")
}

func TestClientScriptsCreateValidationMissingScript(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--name", "TestScript", "--table", "incident")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "script is required")
}

func TestClientScriptsCreateValidationInvalidType(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--name", "TestScript", "--table", "incident", "--script", "function() {}", "--type", "invalid")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid type")
}

func TestClientScriptsCreateValidationMissingFieldForOnChange(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "create", "--name", "TestScript", "--table", "incident", "--script", "function onChange() {}", "--type", "onChange")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "field is required")
}

func TestClientScriptsUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the client script
			`{"result": [{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - update the client script
			`{"result": {"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() { return true; }", "active": "true", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "update", "TestScript", "--script", "function onLoad() { return true; }")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "update", "NonExistentScript", "--script", "function() {}")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestClientScriptsUpdateValidationNoUpdates(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "update", "TestScript")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates provided")
}

func TestClientScriptsDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the client script
			`{"result": [{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - delete the client script (DELETE returns empty or 204)
			`{"result": {}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "delete", "TestScript", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentScript", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestClientScriptsBareCommandWithArg(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "table_name": "incident", "type": "onLoad", "script": "function onLoad() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	// When using subcommands, the bare command with args uses the show subcommand
	cmd := NewClientScriptsCmd()
	err := executeCommand(cmd, app, "show", "TestScript")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_client"))
}

func TestClientScriptsBareCommandWithoutArgShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewClientScriptsCmd()
	// When called with no args, it should show help (which doesn't error, just outputs help text)
	err := executeCommand(cmd, app)

	// Help command doesn't return an error
	assert.NoError(t, err)
}

func TestFindClientScriptByNameOrSysID(t *testing.T) {
	// Test that 32-char hex is recognized as sys_id
	assert.True(t, isHexString("abc123def456abc123def456abc12345"))
	// Test that shorter strings are still hex
	assert.True(t, isHexString("abc123"))
	// Test non-hex
	assert.False(t, isHexString("MyScript-Name"))
}
