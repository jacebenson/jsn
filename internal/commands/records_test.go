package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestRecordsCmd tests the records command
func TestRecordsCmd(t *testing.T) {
	cmd := NewRecordsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "records [<sys_id>]", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")
	assert.NotEmpty(t, cmd.Long, "Command should have a long description")

	// Check expected flags exist
	expectedFlags := []string{
		"table", "limit", "search", "query", "fields",
		"order", "desc", "all", "count",
	}
	for _, flag := range expectedFlags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check subcommands
	subcommands := []string{"create", "update", "delete"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestRecordsCreateSubcommand tests the records create subcommand
func TestRecordsCreateSubcommand(t *testing.T) {
	cmd := NewRecordsCmd()
	createCmd := findSubcommand(cmd, "create")
	assert.NotNil(t, createCmd, "create subcommand should exist")
	assert.Equal(t, "create", createCmd.Use, "Create command use should match")

	// Check flags
	assert.NotNil(t, createCmd.Flag("field"), "Flag --field should exist")
	assert.NotNil(t, createCmd.Flag("data"), "Flag --data should exist")
	assert.NotNil(t, createCmd.Flag("scope"), "Flag --scope should exist for issue #33")
}

// TestRecordsUpdateSubcommand tests the records update subcommand
func TestRecordsUpdateSubcommand(t *testing.T) {
	cmd := NewRecordsCmd()
	updateCmd := findSubcommand(cmd, "update")
	assert.NotNil(t, updateCmd, "update subcommand should exist")
	assert.Equal(t, "update <sys_id>", updateCmd.Use, "Update command use should match")

	// Check flags
	assert.NotNil(t, updateCmd.Flag("field"), "Flag --field should exist")
	assert.NotNil(t, updateCmd.Flag("data"), "Flag --data should exist")
}

// TestRecordsDeleteSubcommand tests the records delete subcommand
func TestRecordsDeleteSubcommand(t *testing.T) {
	cmd := NewRecordsCmd()
	deleteCmd := findSubcommand(cmd, "delete")
	assert.NotNil(t, deleteCmd, "delete subcommand should exist")
	assert.Equal(t, "delete <sys_id>", deleteCmd.Use, "Delete command use should match")

	// Check force flag
	assert.NotNil(t, deleteCmd.Flag("force"), "Flag --force should exist")
}
