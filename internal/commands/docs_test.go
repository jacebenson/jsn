package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestDocsCmd tests the docs command
func TestDocsCmd(t *testing.T) {
	cmd := NewDocsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "docs [topic]", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands - based on actual docs.go implementation
	subcommands := []string{"list", "search", "update"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
