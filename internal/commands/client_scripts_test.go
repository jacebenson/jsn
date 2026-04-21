package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestClientScriptsCmd tests the client-scripts command
func TestClientScriptsCmd(t *testing.T) {
	cmd := NewClientScriptsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check expected flags exist
	expectedFlags := []string{"search", "query", "limit", "order", "desc", "table", "type", "active"}
	for _, flag := range expectedFlags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check script subcommand exists
	sub := findSubcommand(cmd, "script")
	assert.NotNil(t, sub, "Subcommand script should exist")
}
