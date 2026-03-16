package commands

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
)

// TestCommandCreation tests that all command constructors return valid commands
func TestCommandCreation(t *testing.T) {
	tests := []struct {
		name     string
		cmd      *cobra.Command
		expected string
	}{
		{
			name:     "Auth command",
			cmd:      NewAuthCommand(),
			expected: "auth",
		},
		{
			name:     "Config command",
			cmd:      NewConfigCommand(),
			expected: "config",
		},
		{
			name:     "Setup command",
			cmd:      NewSetupCommand(),
			expected: "setup",
		},
		{
			name:     "Tables command",
			cmd:      NewTablesCmd(),
			expected: "tables",
		},
		{
			name:     "UpdateSet command",
			cmd:      NewUpdateSetCmd(),
			expected: "updateset",
		},
		{
			name:     "Choices command",
			cmd:      NewChoicesCommand(),
			expected: "choices",
		},
		{
			name:     "Records command",
			cmd:      NewRecordsCmd(),
			expected: "records",
		},
		{
			name:     "Flows command",
			cmd:      NewFlowsCmd(),
			expected: "flows",
		},
		{
			name:     "Rules command",
			cmd:      NewRulesCmd(),
			expected: "rules",
		},
		{
			name:     "Jobs command",
			cmd:      NewJobsCmd(),
			expected: "jobs",
		},
		{
			name:     "ScriptIncludes command",
			cmd:      NewScriptIncludesCmd(),
			expected: "script-includes",
		},
		{
			name:     "UI Policies command",
			cmd:      NewUIPoliciesCmd(),
			expected: "ui-policies",
		},
		{
			name:     "ACLs command",
			cmd:      NewACLsCmd(),
			expected: "acls",
		},
		{
			name:     "Client Scripts command",
			cmd:      NewClientScriptsCmd(),
			expected: "client-scripts",
		},
		{
			name:     "Docs command",
			cmd:      NewDocsCmd(),
			expected: "docs [topic]",
		},
		{
			name:     "Commands command",
			cmd:      NewCommandsCmd(),
			expected: "commands",
		},
		{
			name:     "Version command",
			cmd:      NewVersionCmd(),
			expected: "version",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.NotNil(t, tt.cmd, "Command should not be nil")
			assert.Equal(t, tt.expected, tt.cmd.Use, "Command name should match")
			assert.NotEmpty(t, tt.cmd.Short, "Command should have a short description")
		})
	}
}

// TestTablesSubcommands tests tables command subcommands
func TestTablesSubcommands(t *testing.T) {
	cmd := NewTablesCmd()

	subcommands := []string{"list", "show", "schema", "columns"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestACLsSubcommands tests acls command subcommands
func TestACLsSubcommands(t *testing.T) {
	cmd := NewACLsCmd()

	subcommands := []string{"list", "show", "script", "check"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestDocsSubcommands tests docs command subcommands
func TestDocsSubcommands(t *testing.T) {
	cmd := NewDocsCmd()

	subcommands := []string{"list", "search", "update"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestKnownTopics tests that knownTopics is populated
func TestKnownTopics(t *testing.T) {
	assert.NotEmpty(t, knownTopics, "knownTopics should not be empty")
	assert.Contains(t, knownTopics, "gliderecord", "should contain gliderecord")
	assert.Contains(t, knownTopics, "operators", "should contain operators")
}

// findSubcommand finds a subcommand by name
func findSubcommand(cmd *cobra.Command, name string) *cobra.Command {
	for _, sub := range cmd.Commands() {
		if sub.Name() == name {
			return sub
		}
	}
	return nil
}
