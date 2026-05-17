// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewActionsCmd(t *testing.T) {
	cmd := NewActionsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "actions")
	assert.Equal(t, []string{"action"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestActionsListCmd(t *testing.T) {
	cmd := newActionsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestActionsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Action", "value": "My Action"}, "active": {"display_value": "true", "value": "true"}, "sys_scope": {"display_value": "Global", "value": "global"}},
			{"sys_id": "def456", "name": {"display_value": "Another Action", "value": "Another Action"}, "active": {"display_value": "false", "value": "false"}, "sys_scope": {"display_value": "My App", "value": "x_myapp"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewActionsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_cb_action"))
}

func TestActionsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewActionsCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	// Query is URL encoded, so we check for the encoded value
	assert.Contains(t, transport.capturedQuery, "active%3Dtrue")
}

func TestActionsShowCmd(t *testing.T) {
	cmd := newActionsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestActionsShowByName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Action", "value": "My Action"}, "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newActionsShowCmd()
	err := executeCommand(cmd, app, "My Action")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_cb_action"))
}

func TestActionsShowBySysID(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "My Action", "value": "My Action"}, "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newActionsShowCmd()
	err := executeCommand(cmd, app, "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	// Verify the sys_cb_action table was queried
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_cb_action"))
}

func TestActionsShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newActionsShowCmd()
	err := executeCommand(cmd, app, "NonExistentAction")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestActionsCreateCmd(t *testing.T) {
	cmd := newActionsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestActionsCreateReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newActionsCreateCmd()
	err := executeCommand(cmd, app)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestActionsUpdateCmd(t *testing.T) {
	cmd := newActionsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("active"))
}

func TestActionsUpdateReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newActionsUpdateCmd()
	err := executeCommand(cmd, app, "My Action")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestActionsDeleteCmd(t *testing.T) {
	cmd := newActionsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestActionsDeleteReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newActionsDeleteCmd()
	err := executeCommand(cmd, app, "My Action")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestActionsSubcommandsExist(t *testing.T) {
	cmd := NewActionsCmd()
	require.NotNil(t, cmd)

	subcommands := cmd.Commands()
	require.Len(t, subcommands, 5)

	names := make([]string, len(subcommands))
	for i, sc := range subcommands {
		names[i] = sc.Name()
	}

	assert.Contains(t, names, "list")
	assert.Contains(t, names, "show")
	assert.Contains(t, names, "create")
	assert.Contains(t, names, "update")
	assert.Contains(t, names, "delete")
}

func TestActionsBareCommandShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewActionsCmd()
	// When called with no args, it should show help (which doesn't error, just outputs help text)
	err := executeCommand(cmd, app)

	// Help command doesn't return an error
	assert.NoError(t, err)
}

func TestActionsShowCommandWithArgShowsAction(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Action", "value": "My Action"}, "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	// Show subcommand should show the action
	cmd := newActionsShowCmd()
	err := executeCommand(cmd, app, "My Action")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_cb_action"))
}

func TestFindActionByNameOrSysID(t *testing.T) {
	// Test that 32-char hex is recognized as sys_id
	assert.True(t, isHexString("abc123def456abc123def456abc12345"))
	// Test that shorter strings are still hex
	assert.True(t, isHexString("abc123"))
	// Test non-hex
	assert.False(t, isHexString("MyAction-Name"))
	assert.False(t, isHexString("my_action_name"))
}
