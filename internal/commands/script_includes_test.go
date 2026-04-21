package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestScriptIncludesCmd tests the script-includes command
func TestScriptIncludesCmd(t *testing.T) {
	cmd := NewScriptIncludesCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check expected flags exist
	expectedFlags := []string{"search", "query", "limit", "order", "desc", "scope", "active"}
	for _, flag := range expectedFlags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check script subcommand exists
	sub := findSubcommand(cmd, "script")
	assert.NotNil(t, sub, "Subcommand script should exist")
}
