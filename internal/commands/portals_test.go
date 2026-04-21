package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestPortalsCmd tests the portals command
func TestPortalsCmd(t *testing.T) {
	cmd := NewPortalsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	flags := []string{"search", "query", "limit", "order", "desc"}
	for _, flag := range flags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}
