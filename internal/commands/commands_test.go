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
			expected: "records [<sys_id>]",
		},
		{
			name:     "Flows command",
			cmd:      NewFlowsCmd(),
			expected: "flows [<name_or_sys_id>] [variables]",
		},
		{
			name:     "Rules command",
			cmd:      NewRulesCmd(),
			expected: "rules [<name_or_sys_id>]",
		},
		{
			name:     "Jobs command",
			cmd:      NewJobsCmd(),
			expected: "jobs [<name_or_sys_id>]",
		},
		{
			name:     "ScriptIncludes command",
			cmd:      NewScriptIncludesCmd(),
			expected: "script-includes [<name_or_sys_id>]",
		},
		{
			name:     "UI Policies command",
			cmd:      NewUIPoliciesCmd(),
			expected: "ui-policies [<name_or_sys_id>]",
		},
		{
			name:     "ACLs command",
			cmd:      NewACLsCmd(),
			expected: "acls [<name_or_sys_id>]",
		},
		{
			name:     "Client Scripts command",
			cmd:      NewClientScriptsCmd(),
			expected: "client-scripts [<name_or_sys_id>]",
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
		{
			name:     "Portals command",
			cmd:      NewPortalsCmd(),
			expected: "sp [<identifier>]",
		},
		{
			name:     "Widgets command",
			cmd:      NewWidgetsCmd(),
			expected: "sp-widgets [<identifier>]",
		},
		{
			name:     "Pages command",
			cmd:      NewPagesCmd(),
			expected: "sp-pages [<identifier>]",
		},
		{
			name:     "Catalog Item command",
			cmd:      NewCatalogItemCmd(),
			expected: "catalog-item [<sys_id_or_name>]",
		},
		{
			name:     "Forms command",
			cmd:      NewFormsCmd(),
			expected: "forms [<table>]",
		},
		{
			name:     "Lists command",
			cmd:      NewListsCmd(),
			expected: "lists [<table>]",
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

	// list and show were merged into the root command
	subcommands := []string{"script", "check"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// Verify list and show are NOT subcommands anymore
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root acls command", flag)
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

// TestJobsSubcommands tests jobs command subcommands
func TestJobsSubcommands(t *testing.T) {
	cmd := NewJobsCmd()

	// list and show were merged into the root command
	subcommands := []string{"executions", "logs", "run", "script"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// Verify list and show are NOT subcommands anymore
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root jobs command", flag)
	}
}

// TestLogsCommand tests logs command
func TestLogsCommand(t *testing.T) {
	cmd := NewLogsCmd()
	assert.NotNil(t, cmd, "Logs command should not be nil")
	assert.Equal(t, "logs", cmd.Use, "Command name should be logs")

	// Check subcommands
	subcommands := []string{"list", "show"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// Check flags on list subcommand
	listCmd := findSubcommand(cmd, "list")
	flags := []string{"table", "sys-id", "source", "minutes", "script", "level", "limit", "query"}
	for _, flag := range flags {
		assert.NotNil(t, listCmd.Flag(flag), "Flag %s should exist on list subcommand", flag)
	}
}

// TestInstanceCommand tests instance command
func TestInstanceCommand(t *testing.T) {
	cmd := NewInstanceCmd()
	assert.NotNil(t, cmd, "Instance command should not be nil")
	assert.Equal(t, "instance", cmd.Use, "Command name should be instance")

	// Check subcommands
	sub := findSubcommand(cmd, "info")
	assert.NotNil(t, sub, "Subcommand info should exist")
}

// TestFlowsSubcommands tests flows command subcommands
func TestFlowsSubcommands(t *testing.T) {
	cmd := NewFlowsCmd()

	// list and show were merged into the root command
	subcommands := []string{"executions", "execute"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// Verify list and show are NOT subcommands anymore
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "active", "order", "desc", "all"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root flows command", flag)
	}
}

// TestTablesSubcommandsExtended tests tables command subcommands including new ones
func TestTablesSubcommandsExtended(t *testing.T) {
	cmd := NewTablesCmd()

	subcommands := []string{"list", "show", "schema", "columns", "relationships", "dependencies", "diagram"}
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

// TestPortalsCommand tests portals command (list/show merged into root)
func TestPortalsCommand(t *testing.T) {
	cmd := NewPortalsCmd()

	// Verify list and show are NOT subcommands
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root sp command", flag)
	}
}

// TestWidgetsCommand tests widgets command (list merged into root, show kept)
func TestWidgetsCommand(t *testing.T) {
	cmd := NewWidgetsCmd()

	// show is kept as subcommand (has code-viewing flags)
	sub := findSubcommand(cmd, "show")
	assert.NotNil(t, sub, "Subcommand show should exist (kept for code flags)")

	// list should NOT exist
	assert.Nil(t, findSubcommand(cmd, "list"), "Subcommand list should NOT exist (merged into root)")

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root sp-widgets command", flag)
	}
}

// TestPagesCommand tests pages command (list/show merged into root)
func TestPagesCommand(t *testing.T) {
	cmd := NewPagesCmd()

	// Verify list and show are NOT subcommands
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root sp-pages command", flag)
	}
}

// TestCatalogItemCommand tests catalog-item command (list/show merged into root)
func TestCatalogItemCommand(t *testing.T) {
	cmd := NewCatalogItemCmd()

	// list and show should NOT exist as subcommands
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Action subcommands should still exist
	for _, name := range []string{"create", "create-variable", "variables"} {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"query", "limit", "catalog", "active"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root catalog-item command", flag)
	}
}

// TestFormsCommand tests forms command (list/show merged into root)
func TestFormsCommand(t *testing.T) {
	cmd := NewFormsCmd()

	// list and show should NOT exist as subcommands
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"table", "limit", "view"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root forms command", flag)
	}
}

// TestListsCommand tests lists command (list/show merged into root)
func TestListsCommand(t *testing.T) {
	cmd := NewListsCmd()

	// list and show should NOT exist as subcommands
	for _, removed := range []string{"list", "show"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify root flags exist
	for _, flag := range []string{"table", "limit", "view"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root lists command", flag)
	}
}

// TestRecordsCommand tests records command (list/show/query/count/variables merged into root)
func TestRecordsCommand(t *testing.T) {
	cmd := NewRecordsCmd()

	// create, update, delete should exist as subcommands
	for _, name := range []string{"create", "update", "delete"} {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}

	// list, show, query, count, variables should NOT exist as subcommands (merged into root)
	for _, removed := range []string{"list", "show", "query", "count", "variables"} {
		t.Run("no_"+removed, func(t *testing.T) {
			sub := findSubcommand(cmd, removed)
			assert.Nil(t, sub, "Subcommand %s should NOT exist (merged into root)", removed)
		})
	}

	// Verify --table persistent flag exists
	assert.NotNil(t, cmd.PersistentFlags().Lookup("table"), "Persistent flag --table should exist on records command")

	// Verify root flags exist
	for _, flag := range []string{"search", "query", "limit", "fields", "order", "desc", "all", "count"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist on root records command", flag)
	}
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
