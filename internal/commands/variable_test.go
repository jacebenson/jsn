package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestVariableCmd tests the variable command
func TestVariableCmd(t *testing.T) {
	cmd := NewVariableCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"show", "choices", "add-choice", "remove-choice"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
