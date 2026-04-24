package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewSetupCmd(t *testing.T) {
	cmd := NewSetupCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "setup", cmd.Use)
	assert.Contains(t, cmd.Short, "Interactive")
	assert.Contains(t, cmd.Long, "interactive")
	assert.Contains(t, cmd.Long, "OAuth")
}

func TestSetupCmdHasCorrectHelp(t *testing.T) {
	cmd := NewSetupCmd()

	// Verify the help text mentions the three steps
	assert.Contains(t, cmd.Long, "Entering your ServiceNow instance URL")
	assert.Contains(t, cmd.Long, "Authenticating with OAuth")
	assert.Contains(t, cmd.Long, "Setting your default instance")

	// Verify examples are present
	assert.Contains(t, cmd.Long, "jsn setup")
	assert.Contains(t, cmd.Long, "SERVICENOW_OAUTH_TOKEN")
}
