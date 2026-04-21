package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestVersionCmd tests the version command
func TestVersionCmd(t *testing.T) {
	cmd := NewVersionCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "version", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")
}
