// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLogsCmd(t *testing.T) {
	cmd := NewLogsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "logs")
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestLogsListCmd(t *testing.T) {
	cmd := newLogsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("level"))
	assert.NotNil(t, flags.Lookup("source"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestLogsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "log1", "level": {"display_value": "Error", "value": "0"}, "message": {"display_value": "Test error message", "value": "Test error message"}, "source": {"display_value": "Script Include", "value": "Script Include"}},
			{"sys_id": "log2", "level": {"display_value": "Information", "value": "2"}, "message": {"display_value": "Info message", "value": "Info message"}, "source": {"display_value": "Business Rule", "value": "Business Rule"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/syslog")
}

func TestLogsListWithLevelFilter(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list", "--level", "error")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "level")
}

func TestLogsListWithSourceFilter(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list", "--source", "Script Include")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "source")
}

func TestLogsListWithCombinedFilters(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list", "--level", "error", "--source", "Business Rule")

	assert.NoError(t, err)
	// Should contain both filters
	assert.Contains(t, transport.capturedQuery, "level")
	assert.Contains(t, transport.capturedQuery, "source")
}

func TestLogsRootShowsHelp(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app)

	assert.NoError(t, err)
}

func TestLogsListSubcommandIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "log1", "level": {"display_value": "Error", "value": "0"}, "message": {"display_value": "Test error", "value": "Test error"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/syslog")
}

func TestLogsListSubcommandWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "list", "--query", "level=0")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "level")
}

func TestLogsShowCmd(t *testing.T) {
	cmd := newLogsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestLogsShowSubcommandIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "log1", "level": {"display_value": "Error", "value": "0"}, "message": {"display_value": "Test error message", "value": "Test error message"}, "source": {"display_value": "Script Include", "value": "Script Include"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewLogsCmd()
	err := executeCommand(cmd, app, "show", "log1")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/syslog")
	// Query is URL-encoded: sys_id%3Dlog1 (colon becomes %3D)
	assert.Contains(t, transport.capturedQuery, "sys_id")
	assert.Contains(t, transport.capturedQuery, "log1")
}
