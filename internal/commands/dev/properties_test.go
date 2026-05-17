// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPropertiesCmd(t *testing.T) {
	cmd := NewPropertiesCmd()
	require.NotNil(t, cmd)
	assert.Contains(t, cmd.Use, "properties")
	assert.NotEmpty(t, cmd.Short)
	assert.NotEmpty(t, cmd.Long)
}

func TestPropertiesRootShowsHelp(t *testing.T) {
	app, _ := setupTestApp(t)
	cmd := NewPropertiesCmd()
	err := executeCommand(cmd, app)

	assert.NoError(t, err)
}

func TestPropertiesShowIntegration(t *testing.T) {
	transport := &mockTransport{
		responseStatus: 200,
		responseBody: `{"result": [
			{"sys_id": "abc123", "name": {"display_value": "glide.foo.bar", "value": "glide.foo.bar"}, "value": {"display_value": "1", "value": "1"}}
		]}`,
	}

	app, _ := setupTestAppWithTransport(t, transport)
	cmd := NewPropertiesCmd()
	err := executeCommand(cmd, app, "show", "glide.foo.bar")

	assert.NoError(t, err)
	assert.True(t, transport.capturedAnyPath("/api/now/table/sys_properties"))
}
