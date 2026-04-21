package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestACLsCmd tests the acls command
func TestACLsCmd(t *testing.T) {
	cmd := NewACLsCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "acls [<name_or_sys_id>]", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")
	assert.NotEmpty(t, cmd.Long, "Command should have a long description")

	// Check expected flags exist
	expectedFlags := []string{"search", "query", "limit", "order", "desc", "table", "operation", "type", "active", "all"}
	for _, flag := range expectedFlags {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}

	// Check subcommands
	subcommands := []string{"script", "check", "create", "update", "delete"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestACLsCreateSubcommand tests the acls create subcommand
func TestACLsCreateSubcommand(t *testing.T) {
	cmd := NewACLsCmd()
	createCmd := findSubcommand(cmd, "create")
	assert.NotNil(t, createCmd, "create subcommand should exist")

	// Check required flags exist
	requiredFlags := []string{"name", "operation"}
	for _, flag := range requiredFlags {
		f := createCmd.Flag(flag)
		assert.NotNil(t, f, "Flag --%s should exist", flag)
		// Cobra marks required flags with annotation
		assert.NotNil(t, f.Annotations["cobra_annotation_bash_completion_one_required_flag"],
			"Flag --%s should be required", flag)
	}

	// Check optional flags
	optionalFlags := []string{"table", "type", "field", "script", "active"}
	for _, flag := range optionalFlags {
		assert.NotNil(t, createCmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestACLsUpdateSubcommand tests the acls update subcommand
func TestACLsUpdateSubcommand(t *testing.T) {
	cmd := NewACLsCmd()
	updateCmd := findSubcommand(cmd, "update")
	assert.NotNil(t, updateCmd, "update subcommand should exist")
	assert.Equal(t, "update <sys_id>", updateCmd.Use, "Update command use should match")

	// Check update flags
	flags := []string{"name", "operation", "table", "type", "field", "script", "active"}
	for _, flag := range flags {
		assert.NotNil(t, updateCmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestACLsDeleteSubcommand tests the acls delete subcommand
func TestACLsDeleteSubcommand(t *testing.T) {
	cmd := NewACLsCmd()
	deleteCmd := findSubcommand(cmd, "delete")
	assert.NotNil(t, deleteCmd, "delete subcommand should exist")
	assert.Equal(t, "delete <sys_id>", deleteCmd.Use, "Delete command use should match")

	// Check force flag
	assert.NotNil(t, deleteCmd.Flag("force"), "Flag --force should exist")
}

// TestACLsScriptSubcommand tests the acls script subcommand
func TestACLsScriptSubcommand(t *testing.T) {
	cmd := NewACLsCmd()
	scriptCmd := findSubcommand(cmd, "script")
	assert.NotNil(t, scriptCmd, "script subcommand should exist")
}

// TestACLsCheckSubcommand tests the acls check subcommand
func TestACLsCheckSubcommand(t *testing.T) {
	cmd := NewACLsCmd()
	checkCmd := findSubcommand(cmd, "check")
	assert.NotNil(t, checkCmd, "check subcommand should exist")

	// Check required flags
	assert.NotNil(t, checkCmd.Flag("table"), "Flag --table should exist")
	assert.NotNil(t, checkCmd.Flag("operation"), "Flag --operation should exist")
}
