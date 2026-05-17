// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestACLsCmd(t *testing.T) {
	cmd := NewACLsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "acls")
	assert.Equal(t, []string{"acl"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestACLsListCmd(t *testing.T) {
	cmd := newACLsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestACLsShowCmd(t *testing.T) {
	cmd := newACLsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestACLsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "incident.read", "value": "incident.read"}, "operation": {"display_value": "read", "value": "read"}, "active": {"display_value": "true", "value": "true"}, "type": {"display_value": "record", "value": "record"}},
			{"sys_id": "def456", "name": {"display_value": "incident.write", "value": "incident.write"}, "operation": {"display_value": "write", "value": "write"}, "active": {"display_value": "false", "value": "false"}, "type": {"display_value": "record", "value": "record"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewACLsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_security_acl"))
}

func TestACLsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewACLsCmd()
	err := executeCommand(cmd, app, "list", "--query", "operation=read")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "operation")
}

func TestACLsShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "incident.read", "value": "incident.read"}, "operation": {"display_value": "read", "value": "read"}, "type": {"display_value": "record", "value": "record"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewACLsCmd()
	err := executeCommand(cmd, app, "show", "incident.read")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_security_acl"))
}

func TestACLsShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "incident.read", "value": "incident.read"}, "operation": {"display_value": "read", "value": "read"}, "type": {"display_value": "record", "value": "record"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewACLsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_security_acl"))
}

func TestACLsShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewACLsCmd()
	err := executeCommand(cmd, app, "show", "NonExistentACL")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestACLsRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewACLsCmd()
	// No args - should show help (which returns nil in cobra 1.8+)
	err := executeCommand(cmd, app)
	assert.NoError(t, err)
}

func TestACLsGetByNameIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "incident.read", "value": "incident.read"}, "operation": {"display_value": "read", "value": "read"}, "type": {"display_value": "record", "value": "record"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newACLsShowCmd()
	err := executeCommand(cmd, app, "incident.read")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_security_acl"))
}
