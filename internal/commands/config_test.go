package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestConfigCmd tests the config command
func TestConfigCmd(t *testing.T) {
	cmd := NewConfigCommand()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "config", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands - actual subcommands based on config.go implementation
	subcommands := []string{"show", "init", "profiles", "profile", "delete", "set", "unset"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
