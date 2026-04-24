// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTablesCmd(t *testing.T) {
	cmd := NewTablesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "tables")
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestTablesListCmd(t *testing.T) {
	cmd := newTablesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestTablesGetCmd(t *testing.T) {
	cmd := newTablesGetCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "get [table-name]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args
	assert.Nil(t, cmd.Args(cmd, []string{"incident"}))

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("columns"))
}

func TestTablesColumnsCmd(t *testing.T) {
	cmd := newTablesColumnsCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "columns", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestTablesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "incident", "value": "incident"}, "label": {"display_value": "Incident", "value": "Incident"}, "super_class": {"display_value": "Task", "value": "task"}},
			{"sys_id": "def456", "name": {"display_value": "problem", "value": "problem"}, "label": {"display_value": "Problem", "value": "Problem"}, "super_class": {"display_value": "Task", "value": "task"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_db_object")
}

func TestTablesListWithSearch(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "incident")
}

func TestTablesGetIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "incident", "value": "incident"}, "label": {"display_value": "Incident", "value": "Incident"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "get", "incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_db_object")
	assert.Contains(t, transport.capturedQuery, "name%3Dincident")
}

func TestTablesGetNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "get", "NonExistentTable")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestTablesColumnsIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "col1", "element": {"display_value": "number", "value": "number"}, "column_label": {"display_value": "Number", "value": "Number"}, "internal_type": {"display_value": "string", "value": "string"}},
			{"sys_id": "col2", "element": {"display_value": "short_description", "value": "short_description"}, "column_label": {"display_value": "Short description", "value": "Short description"}, "internal_type": {"display_value": "string", "value": "string"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "columns", "--table", "incident")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_dictionary")
}

func TestTablesColumnsRequiresTable(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "columns")

	assert.Error(t, err)
}
