package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestListsCmd tests the lists command
func TestListsCmd(t *testing.T) {
	cmd := NewListsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	assert.NotNil(t, cmd.Flag("table"), "Flag --table should exist")
	assert.NotNil(t, cmd.Flag("view"), "Flag --view should exist")
}
