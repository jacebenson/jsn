// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFlowsCmd(t *testing.T) {
	cmd := NewFlowsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "flows")
	assert.Equal(t, []string{"flow"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestFlowsListCmd(t *testing.T) {
	cmd := newFlowsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestFlowsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Flow", "value": "My Flow"}, "active": {"display_value": "true", "value": "true"}, "description": "Test flow description"},
			{"sys_id": "def456", "name": {"display_value": "Another Flow", "value": "Another Flow"}, "active": {"display_value": "true", "value": "true"}, "description": "Another test flow"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewFlowsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_hub_flow")
}

func TestFlowsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewFlowsCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "active")
}

func TestFlowsGetByName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Flow", "value": "My Flow"}, "active": "true", "description": "Test flow"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFlowsShowCmd()
	err := executeCommand(cmd, app, "My Flow")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_hub_flow")
}

func TestFlowsGetBySysID(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "My Flow", "value": "My Flow"}, "active": "true"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFlowsShowCmd()
	err := executeCommand(cmd, app, "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyQuery("sys_id%3Dabc123def456abc123def456abc12345"))
}

func TestFlowsGetNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFlowsShowCmd()
	err := executeCommand(cmd, app, "NonExistentFlow")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestFlowsShowCmd(t *testing.T) {
	cmd := newFlowsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestFlowsShowByName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Flow", "value": "My Flow"}, "active": "true", "description": "Test flow"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFlowsShowCmd()
	err := executeCommand(cmd, app, "My Flow")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_hub_flow")
}

func TestFlowsCreateCmd(t *testing.T) {
	cmd := newFlowsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")
}

func TestFlowsCreateReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newFlowsCreateCmd()
	err := executeCommand(cmd, app)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestFlowsUpdateCmd(t *testing.T) {
	cmd := newFlowsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")
}

func TestFlowsUpdateReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newFlowsUpdateCmd()
	err := executeCommand(cmd, app, "My Flow")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestFlowsDeleteCmd(t *testing.T) {
	cmd := newFlowsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.Contains(t, cmd.Short, "not yet implemented")
	assert.NotEmpty(t, cmd.Long)
	assert.Contains(t, cmd.Long, "GraphQL")
}

func TestFlowsDeleteReturnsError(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := newFlowsDeleteCmd()
	err := executeCommand(cmd, app, "My Flow")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet implemented")
	assert.Contains(t, err.Error(), "GraphQL")
}

func TestFlowsSubcommandsExist(t *testing.T) {
	cmd := NewFlowsCmd()
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
