package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestUpdateSetCmd tests the updateset command
func TestUpdateSetCmd(t *testing.T) {
	cmd := NewUpdateSetCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "updateset", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"list", "show", "use", "create", "parent"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
