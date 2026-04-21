package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestWidgetsCmd tests the widgets command
func TestWidgetsCmd(t *testing.T) {
	cmd := NewWidgetsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	flags := []string{"search", "query", "limit", "order", "desc"}
	for _, flag := range flags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check show subcommand exists
	sub := findSubcommand(cmd, "show")
	assert.NotNil(t, sub, "Subcommand show should exist")
}
