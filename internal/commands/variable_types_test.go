package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestVariableTypesCmd tests the variable-types command
func TestVariableTypesCmd(t *testing.T) {
	cmd := NewVariableTypesCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")
}
