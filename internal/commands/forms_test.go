package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestFormsCmd tests the forms command
func TestFormsCmd(t *testing.T) {
	cmd := NewFormsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check flags
	assert.NotNil(t, cmd.Flag("table"), "Flag --table should exist")
	assert.NotNil(t, cmd.Flag("view"), "Flag --view should exist")
}
