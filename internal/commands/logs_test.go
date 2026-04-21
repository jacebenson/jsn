package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestLogsCmd tests the logs command
func TestLogsCmd(t *testing.T) {
	cmd := NewLogsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "logs", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	flags := []string{"level", "source", "minutes", "limit"}
	for _, flag := range flags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}
