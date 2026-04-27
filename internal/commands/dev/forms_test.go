// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFormsCmd(t *testing.T) {
	cmd := NewFormsCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "forms", cmd.Use)
	assert.Equal(t, []string{"form"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestFormsSubcommandsExist(t *testing.T) {
	cmd := NewFormsCmd()
	require.NotNil(t, cmd)

	subcommands := cmd.Commands()
	require.Len(t, subcommands, 2)

	names := make([]string, len(subcommands))
	for i, sc := range subcommands {
		names[i] = sc.Name()
	}

	assert.Contains(t, names, "list")
	assert.Contains(t, names, "show")
}

func TestFormsListCmd(t *testing.T) {
	cmd := newFormsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list [table]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestFormsListIntegration(t *testing.T) {
	// Mock the sys_ui_section response with views
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"view": {"display_value": "Default view", "value": "abc123"}},
			{"view": {"display_value": "service operations workspace", "value": "def456"}},
			{"view": {"display_value": "Default view", "value": "abc123"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewFormsCmd()
	err := executeCommand(cmd, app, "list", "incident")

	assert.NoError(t, err)
	// Verify it queries sys_ui_section (not sys_ui_view) for the correct table
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_section"))
	assert.Contains(t, transport.capturedQuery, "name%3Dincident")
	assert.Contains(t, transport.capturedQuery, "sysparm_group_by=view")
}

func TestFormsListNoResults(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewFormsCmd()
	err := executeCommand(cmd, app, "list", "nonexistent_table")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_section"))
	assert.Contains(t, transport.capturedQuery, "name%3Dnonexistent_table")
}

func TestFormsShowCmd(t *testing.T) {
	cmd := newFormsShowCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "show [table]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("view"))
}

func TestFormsShowIntegration(t *testing.T) {
	// Mock responses for view lookup, sections, and elements
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// View lookup response
			`{"result": [{"sys_id": "abc123"}]}`,
			// Sections response
			`{"result": [
				{"sys_id": "sec1", "name": {"display_value": "incident", "value": "incident"}, "view": {"display_value": "Default view", "value": "abc123"}, "caption": "Details", "order": "100"}
			]}`,
			// Elements response
			`{"result": [
				{"sys_id": "elem1", "sys_ui_section": {"display_value": "sec1", "value": "sec1"}, "element": "number", "type": "field", "position": "100"}
			]}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFormsShowCmd()
	err := executeCommand(cmd, app, "incident")

	assert.NoError(t, err)
	// Should query sys_ui_view for view lookup
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_view"))
	// Should query sys_ui_section for form sections
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_section"))
	// Should query sys_ui_element for form elements
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_ui_element"))
}

func TestFormsShowWithViewFlag(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// View lookup by title
			`{"result": [{"sys_id": "xyz789"}]}`,
			// Sections response
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFormsShowCmd()
	err := executeCommand(cmd, app, "incident", "--view", "custom view")

	// Should return error since no sections found
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no form sections found")
}

func TestFormsShowNoSections(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBodies: []string{
			// View lookup
			`{"result": [{"sys_id": "abc123"}]}`,
			// Empty sections response
			`{"result": []}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := newFormsShowCmd()
	err := executeCommand(cmd, app, "incident", "--view", "Default view")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no form sections found")
}
