// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestScopesCmd(t *testing.T) {
	cmd := NewScopesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "scopes")
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestScopesListCmd(t *testing.T) {
	cmd := newScopesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestScopesShowCmd(t *testing.T) {
	cmd := newScopesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [scope-name-or-sys-id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args
	assert.Nil(t, cmd.Args(cmd, []string{"global"}))

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("columns"))
}

func TestScopesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Global", "value": "Global"}, "scope": {"display_value": "global", "value": "global"}, "short_description": "Global scope"},
			{"sys_id": "def456", "name": {"display_value": "My App", "value": "My App"}, "scope": {"display_value": "x_my_app", "value": "x_my_app"}, "short_description": "My custom app"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewScopesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_scope")
}

func TestScopesRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewScopesCmd()
	// Root command with no args should show help (not make API call)
	err := executeCommand(cmd, app)

	// Should not error, just shows help
	assert.NoError(t, err)
	// No API call should be made
	assert.Empty(t, transport.capturedPath)
}

func TestScopesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewScopesCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "active")
}

func TestScopesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "Global", "value": "Global"}, "scope": {"display_value": "global", "value": "global"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewScopesCmd()
	err := executeCommand(cmd, app, "show", "global")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_scope")
}

func TestScopesGetNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewScopesCmd()
	err := executeCommand(cmd, app, "show", "NonExistentScope")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}
