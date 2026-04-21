package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestRestCmd tests the rest command
func TestRestCmd(t *testing.T) {
	cmd := NewRestCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "rest", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"get", "post", "patch", "delete"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
