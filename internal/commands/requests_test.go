// Package commands provides CLI commands.
package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRequestsCmd(t *testing.T) {
	cmd := NewRequestsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "requests")
	assert.Equal(t, []string{"request", "req", "ritm"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestRequestsListCmd(t *testing.T) {
	cmd := newRequestsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestRequestsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "RITM0010001", "value": "RITM0010001"}, "short_description": "Test request", "request_state": "1"},
			{"sys_id": "def456", "number": {"display_value": "RITM0010002", "value": "RITM0010002"}, "short_description": "Another request", "request_state": "2"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRequestsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sc_req_item")
}

func TestRequestsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRequestsCmd()
	err := executeCommand(cmd, app, "list", "--query", "request_state=1")

	assert.NoError(t, err)
	// URL encoding: = becomes %3D
	assert.Contains(t, transport.capturedQuery, "request_state")
}

func TestRequestsShowByNumber(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "RITM0010001", "value": "RITM0010001"}, "short_description": "Test request"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewRequestsCmd()
	// The command uses list with query to find by number
	err := executeCommand(cmd, app, "list", "--query", "number=RITM0010001")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sc_req_item")
}

func TestRequestsRootDoesNotImplicitShow(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewRequestsCmd()
	err := executeCommand(cmd, app, "RITM0010001")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}
