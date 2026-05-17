// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"strings"
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

func TestTablesShowCmd(t *testing.T) {
	cmd := newTablesShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [table-name]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args
	assert.Nil(t, cmd.Args(cmd, []string{"incident"}))
}

func TestTablesCreateCmd(t *testing.T) {
	cmd := newTablesCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("name"))
	assert.NotNil(t, flags.Lookup("label"))
	assert.NotNil(t, flags.Lookup("extends"))
	assert.NotNil(t, flags.Lookup("create-acls"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("extendable"))
}

func TestTablesCreateCmd_MissingRequiredFlags(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create")

	assert.Error(t, err)
	// Cobra validates required flags before our custom validation
	assert.Contains(t, err.Error(), "required flag")
}

func TestTablesCreateCmd_MissingLabel(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_test_table")

	assert.Error(t, err)
	// Cobra validates required flags before our custom validation
	assert.Contains(t, err.Error(), "required flag")
}

func TestTablesCreateCmd_InvalidJSON(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_test_table", "--label", "Test", "--data", "invalid json")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid JSON")
}

func TestTablesUpdateCmd(t *testing.T) {
	cmd := newTablesUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [table-name]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("label"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestTablesUpdateCmd_ProtectedFields(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "Test"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "update", "u_test_table", "--data", `{"name":"new_name"}`)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "cannot update field 'name'")
}

func TestTablesUpdateCmd_ProtectedSuperClass(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "Test"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "update", "u_test_table", "--data", `{"super_class":"new_parent"}`)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "cannot update field 'super_class'")
}

func TestTablesUpdateCmd_NoFields(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "Test"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "update", "u_test_table")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no fields to update")
}

func TestTablesDeleteCmd(t *testing.T) {
	cmd := newTablesDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [table-name]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
}

func TestTablesDeleteCmd_RefuseSystemTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"value": "incident"}, "label": {"value": "Incident"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "delete", "incident")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "refusing to delete system table")
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

func TestTablesRootShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app)

	assert.NoError(t, err)
}

func TestTablesShowIntegrationViaSubcommand(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call: get table
			`{"result": [{"sys_id": {"value": "abc123"}, "name": {"value": "incident"}, "label": {"value": "Incident"}}]}`,
			// Second call: column count (stats API)
			`{"result": {"stats": {"count": "5"}}}`,
			// Third call: extension info
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "show", "incident")

	assert.NoError(t, err)
	// Check any captured path contains the table API
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_db_object"))
}

func TestTablesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call: get table
			`{"result": [{"sys_id": {"value": "abc123"}, "name": {"value": "incident"}, "label": {"value": "Incident"}}]}`,
			// Second call: column count (stats API)
			`{"result": {"stats": {"count": "5"}}}`,
			// Third call: extension info
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "show", "incident")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_db_object"))
}

func TestTablesShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "show", "NonExistentTable")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestTablesShowBySysID(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call: get table by sys_id
			`{"result": [{"sys_id": {"value": "abc123def456abc123def456abc123def4"}, "name": {"value": "incident"}, "label": {"value": "Incident"}}]}`,
			// Second call: column count
			`{"result": {"stats": {"count": "5"}}}`,
			// Third call: extension info
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc123def4")

	assert.NoError(t, err)
	// Check that any query contains sys_id lookup (URL encoded as sys_id%3D)
	foundSysID := false
	for _, q := range transport.capturedQueries {
		if strings.Contains(q, "sys_id") && strings.Contains(q, "abc123") {
			foundSysID = true
			break
		}
	}
	assert.True(t, foundSysID, "expected query to contain sys_id lookup")
}

func TestTablesCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "Test Table"}}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_test_table", "--label", "Test Table")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/sys_db_object")
	assert.Contains(t, string(transport.capturedBody), "u_test_table")
	assert.Contains(t, string(transport.capturedBody), "Test Table")
}

func TestTablesUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call: find table
			`{"result": [{"sys_id": {"value": "abc123"}, "name": {"value": "u_test_table"}, "label": {"value": "Old Label"}, "sys_scope": {"value": "global"}}]}`,
			// Second call: GetCurrentUser (scope validation)
			`{"result": {"sys_id": {"value": "user123"}, "name": {"value": "Test User"}, "user_name": {"value": "test.user"}}}`,
			// Third call: GetCurrentApplication (scope validation)
			`{"result": {"sys_id": {"value": "app123"}, "scope": {"value": "global"}}}`,
			// Fourth call: update table
			`{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "New Label"}}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "update", "u_test_table", "--label", "New Label")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_db_object"))
}

func TestTablesUpdateTableNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "update", "NonExistentTable", "--label", "New Label")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestTablesDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			`{"result": [{"sys_id": {"value": "abc123"}, "name": {"value": "u_test_table"}}]}`, // find
			`{"result": []}`, // count (empty to simplify)
			`{"result": []}`, // delete response
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	// Note: This would require input for confirmation, so we use --force
	err := executeCommand(cmd, app, "delete", "u_test_table", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_db_object"))
}

func TestTablesDeleteTableNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentTable", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestTablesListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "list", "--query", "super_class=task")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "super_class%3Dtask")
}

func TestTablesCreateWithExtends(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			`{"result": [{"sys_id": {"value": "task123"}, "name": {"value": "task"}}]}`,                         // find parent
			`{"result": {"sys_id": "abc123", "name": {"value": "u_my_table"}, "label": {"value": "My Table"}}}`, // create
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_my_table", "--label", "My Table", "--extends", "task")

	assert.NoError(t, err)
}

func TestTablesCreateExtendsNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_my_table", "--label", "My Table", "--extends", "nonexistent")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to find parent table")
}

func TestTablesCreateWithData(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": {"sys_id": "abc123", "name": {"value": "u_test_table"}, "label": {"value": "Test"}}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewTablesCmd()
	err := executeCommand(cmd, app, "create", "--name", "u_test_table", "--label", "Test", "--data", `{"is_extendable":true}`)

	assert.NoError(t, err)
	assert.Contains(t, string(transport.capturedBody), "is_extendable")
}
