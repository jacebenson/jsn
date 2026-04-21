package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestJobsCmd tests the jobs command (scheduled jobs)
func TestJobsCmd(t *testing.T) {
	cmd := NewJobsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check expected flags exist
	expectedFlags := []string{"search", "query", "limit", "order", "desc", "type", "active"}
	for _, flag := range expectedFlags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check subcommands
	subcommands := []string{"executions", "logs", "run", "script"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}
