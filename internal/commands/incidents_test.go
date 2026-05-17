// Package commands provides CLI commands.
package commands

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIncidentsCmd(t *testing.T) {
	cmd := NewIncidentsCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "incidents")
	assert.Equal(t, []string{"incident", "inc"}, cmd.Aliases)
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestIncidentsListCmd(t *testing.T) {
	cmd := newIncidentsListCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("query"))
	assert.NotNil(t, flags.Lookup("columns"))
	assert.NotNil(t, flags.Lookup("limit"))
}

func TestIncidentsCreateCmd(t *testing.T) {
	cmd := newIncidentsCreateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("description"))
	assert.NotNil(t, flags.Lookup("priority"))
	assert.NotNil(t, flags.Lookup("data"))
}

func TestIncidentsUpdateCmd(t *testing.T) {
	cmd := newIncidentsUpdateCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "update [number]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args - cobra.ExactArgs(1) returns nil when valid
	assert.Nil(t, cmd.Args(cmd, []string{"INC0010001"}))

	// Check flags
	flags := cmd.Flags()
	assert.NotNil(t, flags.Lookup("data"))
}

func TestIncidentsDeleteCmd(t *testing.T) {
	cmd := newIncidentsDeleteCmd()
	require.NotNil(t, cmd)
	assert.Equal(t, "delete [number]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Check required args - cobra.ExactArgs(1) returns nil when valid
	assert.Nil(t, cmd.Args(cmd, []string{"INC0010001"}))
}

func TestIncidentsListIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "INC0010001", "value": "INC0010001"}, "short_description": "Test incident", "priority": "1"},
			{"sys_id": "def456", "number": {"display_value": "INC0010002", "value": "INC0010002"}, "short_description": "Another incident", "priority": "2"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "list")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/incident")
}

func TestIncidentsListWithQuery(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody:   `{"result": []}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "list", "--query", "priority=1")

	assert.NoError(t, err)
	// URL encoding: = becomes %3D
	assert.Contains(t, transport.capturedQuery, "priority")
}

func TestIncidentsShowByNumber(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": {"display_value": "INC0010001", "value": "INC0010001"}, "short_description": "Test incident"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	// The command uses list with query to find by number
	err := executeCommand(cmd, app, "list", "--query", "number=INC0010001")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/incident")
}

func TestIncidentsRootDoesNotImplicitShow(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "INC0010001")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown command")
}

func TestIncidentsCreateIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 201,
		responseBody:   `{"result": {"sys_id": "new123", "number": "INC0010003", "short_description": "New incident"}}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "create", "--description", "New incident", "--priority", "1")

	assert.NoError(t, err)
	assert.Contains(t, transport.capturedPath, "/api/now/table/incident")
	assert.Contains(t, string(transport.capturedBody), "New incident")
	assert.Contains(t, string(transport.capturedBody), "1")
}

func TestIncidentsCreateRequiresDescription(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "create")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "short_description")
}

// multiCallMockTransport handles multiple sequential calls with different responses
type multiCallMockTransport struct {
	callCount     int
	capturedPath  string
	capturedQuery string
	capturedBody  []byte
	responses     []string
}

func (m *multiCallMockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.callCount++
	m.capturedPath = req.URL.Path
	m.capturedQuery = req.URL.RawQuery
	if req.Body != nil {
		body, _ := io.ReadAll(req.Body)
		m.capturedBody = body
		req.Body.Close()
	}

	responseBody := `{"result": []}`
	if m.callCount <= len(m.responses) {
		responseBody = m.responses[m.callCount-1]
	}

	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(responseBody)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

func TestIncidentsUpdateIntegration(t *testing.T) {
	transport := &multiCallMockTransport{
		responses: []string{
			// First call: find incident (returns array)
			`{"result": [{"sys_id": "abc123", "number": "INC0010001"}]}`,
			// Second call: update incident (returns object)
			`{"result": {"sys_id": "abc123", "number": "INC0010001", "state": "6"}}`,
		},
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "update", "INC0010001", "--data", `{"state": "6"}`)

	// Should make two requests: one to find, one to update
	assert.NoError(t, err)
	assert.Equal(t, 2, transport.callCount)
}

func TestIncidentsDeleteIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "number": "INC0010001"}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewIncidentsCmd()
	err := executeCommand(cmd, app, "delete", "INC0010001")

	// Should make two requests: one to find, one to delete
	assert.NoError(t, err)
}

func TestGetStringField(t *testing.T) {
	tests := []struct {
		name     string
		record   map[string]any
		field    string
		expected string
	}{
		{
			name:     "simple string",
			record:   map[string]any{"number": "INC001"},
			field:    "number",
			expected: "INC001",
		},
		{
			name:     "display value object",
			record:   map[string]any{"number": map[string]any{"display_value": "INC001", "value": "sys123"}},
			field:    "number",
			expected: "INC001",
		},
		{
			name:     "value only object",
			record:   map[string]any{"number": map[string]any{"value": "sys123"}},
			field:    "number",
			expected: "sys123",
		},
		{
			name:     "missing field",
			record:   map[string]any{},
			field:    "number",
			expected: "",
		},
		{
			name:     "nil field",
			record:   map[string]any{"number": nil},
			field:    "number",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := getStringField(tt.record, tt.field)
			assert.Equal(t, tt.expected, got)
		})
	}
}
