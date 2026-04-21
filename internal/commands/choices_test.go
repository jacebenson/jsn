package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestChoicesCmd tests the choices command
func TestChoicesCmd(t *testing.T) {
	cmd := NewChoicesCommand()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "choices", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"list", "create", "update", "delete", "reorder"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
