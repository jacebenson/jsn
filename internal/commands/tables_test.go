package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestTablesCmd tests the tables command
func TestTablesCmd(t *testing.T) {
	cmd := NewTablesCmd()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "tables", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"list", "show", "schema", "columns", "relationships", "dependencies", "diagram"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestTablesListSubcommand tests the tables list subcommand
func TestTablesListSubcommand(t *testing.T) {
	cmd := NewTablesCmd()
	listCmd := findSubcommand(cmd, "list")
	assert.NotNil(t, listCmd, "list subcommand should exist")

	// Check flags
	flags := []string{"search", "limit", "order", "desc"}
	for _, flag := range flags {
		assert.NotNil(t, listCmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestTablesShowSubcommand tests the tables show subcommand
func TestTablesShowSubcommand(t *testing.T) {
	cmd := NewTablesCmd()
	showCmd := findSubcommand(cmd, "show")
	assert.NotNil(t, showCmd, "show subcommand should exist")
}

// TestTablesSchemaSubcommand tests the tables schema subcommand
func TestTablesSchemaSubcommand(t *testing.T) {
	cmd := NewTablesCmd()
	schemaCmd := findSubcommand(cmd, "schema")
	assert.NotNil(t, schemaCmd, "schema subcommand should exist")
}

// TestTablesColumnsSubcommand tests the tables columns subcommand
func TestTablesColumnsSubcommand(t *testing.T) {
	cmd := NewTablesCmd()
	columnsCmd := findSubcommand(cmd, "columns")
	assert.NotNil(t, columnsCmd, "columns subcommand should exist")

	// Check flags
	assert.NotNil(t, columnsCmd.Flag("limit"), "Flag --limit should exist")
}
