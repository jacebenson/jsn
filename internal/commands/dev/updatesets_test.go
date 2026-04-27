// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateSetsCmd(t *testing.T) {
	cmd := NewUpdateSetsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "updatesets")
	assert.Equal(t, []string{"updateset", "us"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestUpdateSetsListCmd(t *testing.T) {
	cmd := newUpdateSetsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("limit"))
	assert.NotNil(t, flags.Lookup("offset"))
}

func TestUpdateSetsShowCmd(t *testing.T) {
	cmd := newUpdateSetsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestUpdateSetsSetCmd(t *testing.T) {
	cmd := newUpdateSetsSetCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "set [name|sys_id]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

func TestUpdateSetsListIntegration(t *testing.T) {
	// Mock responses for update sets and aggregate counts
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - list update sets
			`{"result": [
				{"sys_id": "abc123", "name": {"display_value": "Default Update Set", "value": "Default Update Set"}, "state": {"display_value": "In Progress", "value": "in progress"}, "application.name": {"display_value": "Global", "value": "global"}, "parent.name": {"display_value": "", "value": ""}, "sys_created_by": "admin", "sys_created_on": "2024-01-01 00:00:00"},
				{"sys_id": "def456", "name": {"display_value": "My Update Set", "value": "My Update Set"}, "state": {"display_value": "Complete", "value": "complete"}, "application.name": {"display_value": "Test App", "value": "test_app"}, "parent.name": {"display_value": "Parent", "value": "parent123"}, "sys_created_by": "jsmith", "sys_created_on": "2024-01-02 00:00:00"}
			]}`,
			// Second call - aggregate count for abc123
			`{"result": {"stats": {"*": {"count": 5}}}}`,
			// Third call - aggregate count for def456
			`{"result": {"stats": {"*": {"count": 10}}}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)

	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_set"))
}

func TestUpdateSetsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "list", "--query", "state=in progress")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedQuery, "state")
}

func TestUpdateSetsShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find update set
			`{"result": [
				{"sys_id": "abc123", "name": {"display_value": "My Update Set", "value": "My Update Set"}, "state": {"display_value": "In Progress", "value": "in progress"}}
			]}`,
			// Second call - aggregate count
			`{"result": {"stats": {"*": {"count": 5}}}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "My Update Set")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_set"))
}

func TestUpdateSetsShowBySysIDIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find update set by sys_id
			`{"result": [
				{"sys_id": "abc123def456abc123def456abc12345", "name": {"display_value": "My Update Set", "value": "My Update Set"}, "state": {"display_value": "In Progress", "value": "in progress"}}
			]}`,
			// Second call - aggregate count
			`{"result": {"stats": {"*": {"count": 5}}}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_set"))
}

func TestUpdateSetsSetIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// First call - find update set
			`{"result": [
				{"sys_id": "abc123", "name": {"display_value": "My Update Set", "value": "My Update Set"}, "state": {"display_value": "In Progress", "value": "in progress"}, "application": {"display_value": "Test App", "value": "app123"}}
			]}`,
			// Second call - get current user
			`{"result": [
				{"sys_id": "user456", "user_name": "admin", "name": "System Administrator"}
			]}`,
			// Third call - query existing preference (sys_update_set)
			`{"result": []}`,
			// Fourth call - create preference (sys_update_set)
			`{"result": {"sys_id": "pref789"}}`,
			// Fifth call - query existing preference (apps.current_app)
			`{"result": []}`,
			// Sixth call - create preference (apps.current_app)
			`{"result": {"sys_id": "pref790"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "set", "My Update Set")

	// Should successfully set the update set
	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_set"))
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user"))
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_user_preference"))
}

func TestUpdateSetsSetCmdWithoutArgs(t *testing.T) {
	cmd := newUpdateSetsSetCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "set [name|sys_id]", cmd.Use)
	// Command should exist and be configured
	assert.NotNil(t, cmd.RunE)
}

func TestUpdateSetsSetNotFound(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "set", "NonExistentUpdateSet")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestUpdateSetsShowEnhancedIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// 1. Find update set
			`{"result": [
				{"sys_id": "abc123def456abc123def456abc12345", "name": "My Update Set", "state": "in progress", "application": {"display_value": "Test App", "value": "app123"}, "parent": {"display_value": "Parent Set", "value": "parent456"}, "sys_created_on": "2024-01-01 00:00:00", "sys_updated_on": "2024-01-02 00:00:00", "sys_created_by": {"display_value": "admin", "value": "admin"}, "sys_updated_by": {"display_value": "jsmith", "value": "jsmith"}}
			]}`,
			// 2. Aggregate count for updates
			`{"result": {"stats": {"*": {"count": 15}}}}`,
			// 3. Fetch parent update set
			`{"result": [
				{"sys_id": "parent456", "name": "Parent Update Set"}
			]}`,
			// 4. Fetch child update sets
			`{"result": [
				{"sys_id": "child789", "name": "Child Update Set 1"},
				{"sys_id": "child012", "name": "Child Update Set 2"}
			]}`,
			// 5. Fetch updates snapshot
			`{"result": [
				{"sys_id": "upd001", "type": "sys_script_include", "target_name": "MyScriptInclude", "action": "INSERT", "sys_updated_by": {"display_value": "jsmith", "value": "jsmith"}, "sys_updated_on": "2024-01-02 10:00:00"},
				{"sys_id": "upd002", "type": "sys_script_include", "target_name": "AnotherScript", "action": "UPDATE", "sys_updated_by": {"display_value": "admin", "value": "admin"}, "sys_updated_on": "2024-01-02 09:00:00"}
			]}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "My Update Set")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_set"))
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_update_xml"))
	// Should have made 5 API calls
	assert.Equal(t, 5, transport.requestCount)
}

func TestUpdateSetsShowEnhancedWithoutParent(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// 1. Find update set (no parent)
			`{"result": [
				{"sys_id": "abc123def456abc123def456abc12345", "name": "Standalone Update Set", "state": "in progress", "application": {"display_value": "Test App", "value": "app123"}, "parent": {"display_value": "", "value": ""}, "sys_created_on": "2024-01-01 00:00:00", "sys_updated_on": "2024-01-02 00:00:00", "sys_created_by": {"display_value": "admin", "value": "admin"}, "sys_updated_by": {"display_value": "jsmith", "value": "jsmith"}}
			]}`,
			// 2. Aggregate count for updates
			`{"result": {"stats": {"*": {"count": 5}}}}`,
			// 3. No parent lookup (parent is empty)
			// 4. Fetch child update sets (none)
			`{"result": []}`,
			// 5. Fetch updates snapshot
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "Standalone Update Set")

	assert.NoError(t, err)
}

func TestUpdateSetsShowSimpleFlag(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// Find update set
			`{"result": [
				{"sys_id": "abc123def456abc123def456abc12345", "name": "My Update Set", "state": {"display_value": "In Progress", "value": "in progress"}}
			]}`,
			// Aggregate count only (simple mode)
			`{"result": {"stats": {"*": {"count": 5}}}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "My Update Set", "--simple")

	assert.NoError(t, err)
	// Simple mode should only make 2 API calls (find + count)
	assert.Equal(t, 2, transport.requestCount)
}

func TestUpdateSetsShowEnhancedBySysID(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// 1. Find update set by sys_id (32 char hex)
			`{"result": [
				{"sys_id": "abc123def456abc123def456abc12345", "name": "Test Update Set", "state": "in progress", "application": {"display_value": "Global", "value": "global"}, "parent": {"display_value": "", "value": ""}, "sys_created_on": "2024-01-01 00:00:00", "sys_updated_on": "2024-01-02 00:00:00", "sys_created_by": {"display_value": "admin", "value": "admin"}, "sys_updated_by": {"display_value": "admin", "value": "admin"}}
			]}`,
			// 2. Aggregate count
			`{"result": {"stats": {"*": {"count": 3}}}}`,
			// 3. No parent lookup (parent is empty, so skipped)
			// 3. Fetch children (concurrent with snapshot, but we count sequentially)
			`{"result": []}`,
			// 4. Fetch updates snapshot
			`{"result": [
				{"sys_id": "upd001", "type": "sys_script_include", "target_name": "TestScript", "action": "INSERT", "sys_updated_by": {"display_value": "admin", "value": "admin"}, "sys_updated_on": "2024-01-02 10:00:00"}
			]}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewUpdateSetsCmd()
	err := executeCommand(cmd, app, "show", "abc123def456abc123def456abc12345")

	assert.NoError(t, err)
	// Without parent lookup (empty parent), we expect 4 calls: find, count, children, snapshot
	assert.Equal(t, 4, transport.requestCount)
}
