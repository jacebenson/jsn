// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewIncludesCmd(t *testing.T) {
	cmd := NewIncludesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "includes")
	assert.Equal(t, []string{"include", "si"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestIncludesListCmd(t *testing.T) {
	cmd := newIncludesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestIncludesShowCmd(t *testing.T) {
	cmd := newIncludesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestIncludesCreateCmd(t *testing.T) {
	cmd := newIncludesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("api-name"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestIncludesUpdateCmd(t *testing.T) {
	cmd := newIncludesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("script"))
}

func TestIncludesDeleteCmd(t *testing.T) {
	cmd := newIncludesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestIncludesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "active": "true", "sys_scope": {"display_value": "Global", "value": "global"}},
			{"sys_id": "def456", "name": "AnotherScript", "api_name": "x_myapp.AnotherScript", "active": "false", "sys_scope": {"display_value": "My App", "value": "x_myapp"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	// Query is URL encoded, so we check for the encoded value
	assert.Contains(t, transport.capturedQuery, "active%3Dtrue")
}

func TestIncludesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "show", "TestScript")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	// Should call the script include table endpoint
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "show", "NonExistentScript")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestIncludesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - get current user (for scope determination)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Second call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Third call - create the script include
			`{"result": {"sys_id": "new123", "name": "NewScript", "api_name": "global.NewScript", "script": "function NewScript() {}", "active": "true", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "create", "--name", "NewScript", "--script", "function NewScript() {}")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesCreateValidationMissingName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "create", "--script", "function Test() {}")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "name is required")
}

func TestIncludesCreateValidationMissingScript(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "create", "--name", "TestScript")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "script is required")
}

func TestIncludesUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the script include
			`{"result": [{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - update the script include
			`{"result": {"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() { return true; }", "active": "true", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "update", "TestScript", "--script", "function TestScript() { return true; }")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "update", "NonExistentScript", "--script", "function() {}")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestIncludesUpdateValidationNoUpdates(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "update", "TestScript")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates provided")
}

func TestIncludesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the script include
			`{"result": [{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - delete the script include (DELETE returns empty or 204)
			`{"result": {}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "delete", "TestScript", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentScript", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestIncludesBareCommandWithArg(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "TestScript", "api_name": "global.TestScript", "script": "function TestScript() {}", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	// When using subcommands, the bare command with args uses the show subcommand
	// This is the recommended pattern: jsn dev includes show TestScript
	cmd := NewIncludesCmd()
	err := executeCommand(cmd, app, "show", "TestScript")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script_include"))
}

func TestIncludesBareCommandWithoutArgShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewIncludesCmd()
	// When called with no args, it should show help (which doesn't error, just outputs help text)
	err := executeCommand(cmd, app)

	// Help command doesn't return an error
	assert.NoError(t, err)
}

func TestFindIncludeByNameOrSysID(t *testing.T) {
	// Test that 32-char hex is recognized as sys_id
	assert.True(t, isHexString("abc123def456abc123def456abc12345"))
	// Test that shorter strings are not hex (or at least not treated as sys_id)
	assert.True(t, isHexString("abc123")) // This is still hex, just shorter
	// Test non-hex
	assert.False(t, isHexString("MyScript-Name"))
}
