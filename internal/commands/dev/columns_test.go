// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewColumnsCmd(t *testing.T) {
	cmd := NewColumnsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "columns")
	assert.Equal(t, []string{"column", "col"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestColumnsListCmd(t *testing.T) {
	cmd := newColumnsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestColumnsShowCmd(t *testing.T) {
	cmd := newColumnsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [element|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestColumnsCreateCmd(t *testing.T) {
	cmd := newColumnsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("table"))
	assert.NotNil(t, flags.Lookup("element"))
	assert.NotNil(t, flags.Lookup("type"))
	assert.NotNil(t, flags.Lookup("label"))
	assert.NotNil(t, flags.Lookup("mandatory"))
	assert.NotNil(t, flags.Lookup("max-length"))
	assert.NotNil(t, flags.Lookup("reference-table"))
	assert.NotNil(t, flags.Lookup("default-value"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("scope"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestColumnsUpdateCmd(t *testing.T) {
	cmd := newColumnsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [element|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("label"))
	assert.NotNil(t, flags.Lookup("mandatory"))
	assert.NotNil(t, flags.Lookup("max-length"))
	assert.NotNil(t, flags.Lookup("active"))
	assert.NotNil(t, flags.Lookup("data"))
	assert.NotNil(t, flags.Lookup("table"))
}

func TestColumnsDeleteCmd(t *testing.T) {
	cmd := newColumnsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [element|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("force"))
	assert.NotNil(t, flags.Lookup("table"))
}

func TestColumnsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "element": "short_description", "column_label": "Short description", "internal_type": "string", "mandatory": "false", "max_length": "4000", "active": "true", "name": "incident"},
			{"sys_id": "def456", "element": "priority", "column_label": "Priority", "internal_type": "integer", "mandatory": "true", "max_length": "40", "active": "true", "name": "incident"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsListWithTableFlag(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "list", "--table", "incident")

	assert.NoError(t, err)
	// Should include the table name in the query
	assert.Contains(t, transport.capturedQuery, "name%3Dincident")
}

func TestColumnsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "list", "--query", "internal_type=reference")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "internal_type%3Dreference")
}

func TestColumnsShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "element": "short_description", "column_label": "Short description", "internal_type": "string", "mandatory": "false", "max_length": "4000", "active": "true", "name": "incident", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "show", "short_description")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "element": "short_description", "column_label": "Short description", "internal_type": "string", "mandatory": "false", "active": "true", "name": "incident", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsShowNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "show", "nonexistent_field")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestColumnsCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - create the column
			`{"result": {"sys_id": "new123", "element": "my_field", "column_label": "My Field", "internal_type": "string", "name": "incident", "mandatory": "false", "active": "true", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--element", "my_field", "--type", "string", "--label", "My Field")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsCreateValidationMissingTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--element", "my_field", "--type", "string", "--label", "My Field")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--table is required")
}

func TestColumnsCreateValidationMissingElement(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--type", "string", "--label", "My Field")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--element is required")
}

func TestColumnsCreateValidationMissingType(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--element", "my_field", "--label", "My Field")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--type is required")
}

func TestColumnsCreateValidationMissingLabel(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--element", "my_field", "--type", "string")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--label is required")
}

func TestColumnsCreateValidationReferenceTypeNeedsReferenceTable(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "create", "--table", "incident", "--element", "parent", "--type", "reference", "--label", "Parent")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--reference-table is required for reference type columns")
}

func TestColumnsUpdateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the column
			`{"result": [{"sys_id": "abc123", "element": "my_field", "column_label": "My Field", "internal_type": "string", "name": "incident", "mandatory": "false", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - update the column
			`{"result": {"sys_id": "abc123", "element": "my_field", "column_label": "Updated Label", "internal_type": "string", "name": "incident", "mandatory": "true", "active": "true", "sys_scope": "global"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "update", "my_field", "--table", "incident", "--label", "Updated Label", "--mandatory")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsUpdateNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "update", "NonExistentField", "--table", "incident", "--label", "New Label")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestColumnsUpdateValidationNoUpdates(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "element": "my_field", "column_label": "My Field", "internal_type": "string", "name": "incident", "active": "true", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "update", "my_field", "--table", "incident")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no updates provided")
}

func TestColumnsDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find the column
			`{"result": [{"sys_id": "abc123", "element": "my_field", "column_label": "My Field", "internal_type": "string", "name": "incident", "active": "true", "sys_scope": "global"}]}`,
			// Second call - get current user (for scope validation)
			`{"result": [{"sys_id": "user123", "user_name": "admin", "name": "System Administrator"}]}`,
			// Third call - get current application
			`{"result": [{"sys_id": "app123", "scope": "global", "name": "Global"}]}`,
			// Fourth call - delete the column
			`{"result": {}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "delete", "my_field", "--table", "incident", "--force")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsDeleteNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "delete", "NonExistentField", "--table", "incident", "--force")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestColumnsBareCommandWithArg(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "element": "short_description", "column_label": "Short description", "internal_type": "string", "name": "incident", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	err := executeCommand(cmd, app, "show", "short_description")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_dictionary"))
}

func TestColumnsBareCommandWithoutArgShowsHelp(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewColumnsCmd()
	// When called with no args, it should show help (which doesn't error, just outputs help text)
	err := executeCommand(cmd, app)

	// Help command doesn't return an error
	assert.NoError(t, err)
}

func TestValidateElementName(t *testing.T) {
	// Valid names
	assert.NoError(t, validateElementName("my_field"))
	assert.NoError(t, validateElementName("field123"))
	assert.NoError(t, validateElementName("u_custom_field"))

	// Invalid names
	assert.Error(t, validateElementName(""))
	assert.Error(t, validateElementName("my field"))
	assert.Error(t, validateElementName("MyField"))
	assert.Error(t, validateElementName("my-field"))
	assert.Error(t, validateElementName("my.field"))
}

func TestFindColumnBySysID(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123def456abc123def456abc12345", "element": "test_field", "column_label": "Test Field", "internal_type": "string", "name": "incident", "sys_scope": "global"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)

	ctx := context.Background()
	record, err := findColumnBySysID(ctx, app, "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.Equal(t, "test_field", getStringField(record, "element"))
}
