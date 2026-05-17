// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRulesCmd(t *testing.T) {
	cmd := NewRulesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "rules")
	assert.Equal(t, []string{"rule", "br"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestRulesListCmd(t *testing.T) {
	cmd := newRulesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestRulesShowCmd(t *testing.T) {
	cmd := newRulesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestRulesCreateCmd(t *testing.T) {
	cmd := newRulesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("collection"))
	assert.NotNil(t, flags.Lookup("when"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("order"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("insert"))
	assert.NotNil(t, flags.Lookup("update"))
	assert.NotNil(t, flags.Lookup("delete"))
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("business-rule"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestRulesUpdateCmd(t *testing.T) {
	cmd := newRulesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("script"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("order"))
}

func TestRulesDeleteCmd(t *testing.T) {
	cmd := newRulesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestRulesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Test Rule", "value": "Test Rule"}, "collection": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}, "order": {"display_value": "100", "value": "100"}},
			{"sys_id": "def456", "name": {"display_value": "Another Rule", "value": "Another Rule"}, "collection": {"display_value": "task", "value": "task"}, "active": {"display_value": "false", "value": "false"}, "order": {"display_value": "200", "value": "200"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "list", "--query", "collection=incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "collection")
}

func TestRulesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "My Business Rule", "value": "My Business Rule"}, "collection": {"display_value": "incident", "value": "incident"}, "when": {"display_value": "before", "value": "before"}, "active": {"display_value": "true", "value": "true"}, "script": {"display_value": "gs.info('Hello');", "value": "gs.info('Hello');"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "show", "My Business Rule")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "My Business Rule", "value": "My Business Rule"}, "collection": {"display_value": "incident", "value": "incident"}, "when": {"display_value": "before", "value": "before"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "show", "NonExistentRule")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRulesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Create response
			`{"result": {"sys_id": "newrule123", "name": "New Rule", "collection": "incident", "when": "before", "active": "true"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Rule", "--collection", "incident", "--when", "before", "--script", "gs.info('test');")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesCreateRequiresName(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "create", "--collection", "incident", "--when", "before", "--script", "gs.info('test');")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--name is required")
}

func TestRulesCreateRequiresCollection(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Rule", "--when", "before", "--script", "gs.info('test');")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--collection")
}

func TestRulesCreateRequiresWhen(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Rule", "--collection", "incident", "--script", "gs.info('test');")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--when")
}

func TestRulesCreateRequiresScript(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "create", "--name", "New Rule", "--collection", "incident", "--when", "before")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--script")
}

func TestRulesUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find rule
			`{"result": [{"sys_id": "abc123", "name": "My Rule", "collection": "incident", "when": "before", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "name": "My Rule", "active": "false"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "update", "My Rule", "--data", `{"active": false}`)

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "update", "NonExistentRule", "--data", `{"active": false}`)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRulesUpdateNoData(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "My Rule", "collection": "incident", "sys_scope": {"display_value": "global", "value": "global"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "update", "My Rule")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates specified")
}

func TestRulesUpdateWithConvenienceFlags(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find rule
			`{"result": [{"sys_id": "abc123", "name": "My Rule", "collection": "incident", "when": "before", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Update response
			`{"result": {"sys_id": "abc123", "name": "My Rule", "active": "false", "script": "gs.info('Updated');"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "update", "My Rule", "--script", "gs.info('Updated');", "--active=false")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find rule
			`{"result": [{"sys_id": "abc123", "name": "My Rule", "collection": "incident", "sys_scope": {"display_value": "global", "value": "global"}}]}`,
			// Get current user (for scope validation)
			`{"result": [{"sys_id": "user456", "user_name": "admin"}]}`,
			// Get current application
			`{"result": {"sys_id": "app789", "scope": "global"}}`,
			// Delete response (empty 200)
			`{}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "delete", "My Rule", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}

func TestRulesDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentRule", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestRulesRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	// No args - should show help (which returns nil in cobra 1.8+)
	err := executeCommand(cmd, app)
	assert.NoError(t, err)
}

func TestRulesGetByNameIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Specific Rule", "value": "Specific Rule"}, "collection": {"display_value": "incident", "value": "incident"}, "active": {"display_value": "true", "value": "true"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRulesCmd()
	err := executeCommand(cmd, app, "show", "Specific Rule")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_script"))
}
