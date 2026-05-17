// Package commands provides CLI commands.
package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChangesCmd(t *testing.T) {
	cmd := NewChangesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "changes")
	assert.Equal(t, []string{"change", "chg"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestChangesListCmd(t *testing.T) {
	cmd := newChangesListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestChangesCreateCmd(t *testing.T) {
	cmd := newChangesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("description"))
	assert.NotNil(t, flags.Lookup("risk"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestChangesUpdateCmd(t *testing.T) {
	cmd := newChangesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [number]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args - cobra.ExactArgs(1) returns nil when valid
	assert.Nil(t, cmd.Args(cmd, []string{"CHG0010001"}))

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
}

func TestChangesDeleteCmd(t *testing.T) {
	cmd := newChangesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [number]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args - cobra.ExactArgs(1) returns nil when valid
	assert.Nil(t, cmd.Args(cmd, []string{"CHG0010001"}))
}

func TestChangesListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "CHG0010001", "value": "CHG0010001"}, "short_description": "Test change", "risk": "medium"},
			{"sys_id": "def456", "number": {"display_value": "CHG0010002", "value": "CHG0010002"}, "short_description": "Another change", "risk": "high"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/change_request")
}

func TestChangesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 201,
		responseBody:   `{"result": {"sys_id": "new123", "number": "CHG0010003", "short_description": "New change request"}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "create", "--description", "New change request", "--risk", "medium")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/change_request")
	assert.Contains(t, string(transport.capturedBody), "New change request")
	assert.Contains(t, string(transport.capturedBody), "medium")
}

func TestChangesCreateRequiresDescription(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "create")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "short_description")
}

func TestChangesUpdateIntegration(t *testing.T) {
	transport := &multiCallMockTransport{
		responses: []string{
			// First call: find change (returns array)
			`{"result": [{"sys_id": "abc123", "number": "CHG0010001"}]}`,
			// Second call: update change (returns object)
			`{"result": {"sys_id": "abc123", "number": "CHG0010001", "state": "3"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "update", "CHG0010001", "--data", `{"state": "3"}`)

	// Should make two requests: one to find, one to update
	assert.NoError(t, err)
	assert.Equal(t, 2, transport.callCount)
}

func TestChangesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": "CHG0010001"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "delete", "CHG0010001")

	// Should make two requests: one to find, one to delete
	assert.NoError(t, err)
}

func TestChangesRootDoesNotImplicitShow(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewChangesCmd()
	err := executeCommand(cmd, app, "CHG0010001")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}
