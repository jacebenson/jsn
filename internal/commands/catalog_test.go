package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestCatalogItemCmd tests the catalog-item command
func TestCatalogItemCmd(t *testing.T) {
	cmd := NewCatalogItemCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"create", "create-variable", "variables"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
