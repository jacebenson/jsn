// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImportCmd(t *testing.T) {
	cmd := NewImportCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "import")
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestImportRootShowsHelp(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewImportCmd()
	err := executeCommand(cmd, app)

	assert.NoError(t, err)
}

func TestImportShowBySetIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "sys_import_set": {"display_value": "SET0010001", "value": "SET0010001"}, "sys_target_table": {"display_value": "incident", "value": "incident"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewImportCmd()
	err := executeCommand(cmd, app, "show", "SET0010001")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_import_set_row"))
}

func TestImportShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "sys_import_set": {"display_value": "SET0010001", "value": "SET0010001"}, "sys_target_table": {"display_value": "incident", "value": "incident"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewImportCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_import_set_row"))
	assert.Contains(t, transport.capturedQuery, "sys_id")
}
