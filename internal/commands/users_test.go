// Package commands provides CLI commands.
package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsersCmd(t *testing.T) {
	cmd := NewUsersCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "users")
	assert.Equal(t, []string{"user"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestUsersListCmd(t *testing.T) {
	cmd := newUsersListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestUsersListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "user_name": "admin", "name": "System Administrator", "email": "admin@example.com", "active": "true"},
			{"sys_id": "def456", "user_name": "jdoe", "name": "John Doe", "email": "jdoe@example.com", "active": "true"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUsersCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_user")
}

func TestUsersListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUsersCmd()
	err := executeCommand(cmd, app, "list", "--query", "active=true")

	assert.NoError(t, err)
	// URL encoding: = becomes %3D
	assert.Contains(t, transport.capturedQuery, "active")
}

func TestUsersRootDoesNotImplicitSearch(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewUsersCmd()
	err := executeCommand(cmd, app, "John Doe")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}
