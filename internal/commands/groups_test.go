// Package commands provides CLI commands.
package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGroupsCmd(t *testing.T) {
	cmd := NewGroupsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "groups")
	assert.Equal(t, []string{"group"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestGroupsListCmd(t *testing.T) {
	cmd := newGroupsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestGroupsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": "IT Support", "manager": "admin", "email": "itsupport@example.com"},
			{"sys_id": "def456", "name": "Developers", "manager": "jdoe", "email": "dev@example.com"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewGroupsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_user_group")
}

func TestGroupsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewGroupsCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	// URL encoding: = becomes %3D
	assert.Contains(t, transport.capturedQuery, "active")
}

func TestGroupsRootDoesNotImplicitSearch(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewGroupsCmd()
	err := executeCommand(cmd, app, "IT Support")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}
