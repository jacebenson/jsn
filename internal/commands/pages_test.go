package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestPagesCmd tests the pages command
func TestPagesCmd(t *testing.T) {
	cmd := NewPagesCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	assert.NotNil(t, cmd.Flag("search"), "Flag --search should exist")
	assert.NotNil(t, cmd.Flag("limit"), "Flag --limit should exist")
}
