package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestAssignmentRulesCommand tests the assignment-rules command
func TestAssignmentRulesCommand(t *testing.T) {
	cmd := NewAssignmentRulesCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "assignment-rules [<name_or_sys_id>]", cmd.Use, "Command name should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check expected flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc", "table", "active", "all"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Assignment-rules doesn't have subcommands - it uses flags-based args
	assert.Equal(t, 0, len(cmd.Commands()), "assignment-rules should not have subcommands")
}
