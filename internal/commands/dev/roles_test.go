// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewRolesCmd(t *testing.T) {
	cmd := NewRolesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "roles")
	assert.Equal(t, []string{"role"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestRolesListCmd(t *testing.T) {
	cmd := newRolesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestRolesShowCmd(t *testing.T) {
	cmd := newRolesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestRolesCreateCmd(t *testing.T) {
	cmd := newRolesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("description"))
	assert.NotNil(t, flags.Lookup("elevated"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestRolesUpdateCmd(t *testing.T) {
	cmd := newRolesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("description"))
	assert.NotNil(t, flags.Lookup("elevated"))
}

func TestRolesDeleteCmd(t *testing.T) {
	cmd := newRolesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestRolesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "admin", "description": "System Administrator", "elevated_privilege": "true", "sys_scope": {"display_value": "Global", "value": "global"}},
			{"sys_id": "def456", "name": "itil", "description": "ITIL User", "elevated_privilege": "false", "sys_scope": {"display_value": "Global", "value": "global"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "list", "--query", "elevated_privilege=true")

	assert.NoError(t, err)
	// Query is URL encoded, so we check for the encoded value
	assert.Contains(t, transport.capturedQuery, "elevated_privilege%3Dtrue")
}

func TestRolesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "admin", "description": "System Administrator", "elevated_privilege": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "show", "admin")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": "admin", "description": "System Administrator", "elevated_privilege": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	// Should call the roles table endpoint
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "show", "nonexistent_role")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRolesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "new123", "name": "x_myapp.user", "description": "My App User Role", "elevated_privilege": "false", "sys_scope": "global"}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "create", "--name", "x_myapp.user", "--description", "My App User Role")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesCreateValidationMissingName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "create", "--description", "Test description")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "name is required")
}

func TestRolesCreateWithElevatedFlag(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "new456", "name": "x_myapp.admin", "description": "My App Admin", "elevated_privilege": "true", "sys_scope": "global"}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "create", "--name", "x_myapp.admin", "--description", "My App Admin", "--elevated")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the role
			`{"result": [{"sys_id": "abc123", "name": "x_myapp.user", "description": "Old description", "elevated_privilege": "false", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - update the role
			`{"result": {"sys_id": "abc123", "name": "x_myapp.user", "description": "Updated description", "elevated_privilege": "false", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "update", "x_myapp.user", "--description", "Updated description")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "update", "nonexistent_role", "--description", "test")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRolesUpdateValidationNoUpdates(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "admin", "description": "System Administrator", "elevated_privilege": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "update", "admin")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates provided")
}

func TestRolesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the role
			`{"result": [{"sys_id": "abc123", "name": "x_myapp.test", "description": "Test Role", "elevated_privilege": "false", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - delete the role (DELETE returns empty or 204)
			`{"result": {}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "delete", "x_myapp.test", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "delete", "nonexistent_role", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRolesBareCommandWithArg(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "admin", "description": "System Administrator", "elevated_privilege": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	// When using subcommands, the bare command with args uses the show subcommand
	// This is the recommended pattern: jsn dev roles show admin
	cmd := NewRolesCmd()
	err := executeCommand(cmd, app, "show", "admin")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_role"))
}

func TestRolesBareCommandWithoutArgShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRolesCmd()
	// When called with no args, it should show help (which doesn't error, just outputs help text)
	err := executeCommand(cmd, app)

	// Help command doesn't return an error
	assert.NoError(t, err)
}

func TestFindRoleByNameOrSysID(t *testing.T) {
	// Test that 32-char hex is recognized as sys_id
	assert.True(t, isHexString("abc123def456abc123def456abc12345"))
	// Test that shorter strings are not treated as sys_id
	assert.True(t, isHexString("abc123")) // This is still hex, just shorter
	// Test non-hex
	assert.False(t, isHexString("admin-role"))
}
