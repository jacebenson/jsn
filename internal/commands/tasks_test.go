// Package commands provides CLI commands.
package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTasksCmd(t *testing.T) {
	cmd := NewTasksCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "tasks")
	assert.Equal(t, []string{"task", "sctask"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestTasksListCmd(t *testing.T) {
	cmd := newTasksListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestTasksListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "SCTASK0010001", "value": "SCTASK0010001"}, "short_description": "Test task", "state": "1"},
			{"sys_id": "def456", "number": {"display_value": "SCTASK0010002", "value": "SCTASK0010002"}, "short_description": "Another task", "state": "2"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTasksCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sc_task")
}

func TestTasksListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTasksCmd()
	err := executeCommand(cmd, app, "list", "--query", "state=1")

	assert.NoError(t, err)
	// URL encoding: = becomes %3D
	assert.Contains(t, transport.capturedQuery, "state")
}

func TestTasksShowCmd(t *testing.T) {
	cmd := newTasksShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [number]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestTasksShowByNumber(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "SCTASK0010001", "value": "SCTASK0010001"}, "short_description": "Test task"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTasksCmd()
	// The command uses list with query to find by number
	err := executeCommand(cmd, app, "list", "--query", "number=SCTASK0010001")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sc_task")
}

func TestTasksRootDoesNotImplicitShow(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewTasksCmd()
	err := executeCommand(cmd, app, "SCTASK0010001")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}
