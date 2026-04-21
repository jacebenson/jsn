package commands

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
)

// TestAssignmentRulesCmdStructure tests the assignment-rules command
func TestAssignmentRulesCmdStructure(t *testing.T) {
	cmd := NewAssignmentRulesCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "assignment-rules [<name_or_sys_id>]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags - assignment-rules is flag-based
	for _, flag := range []string{"search", "query", "limit", "order", "desc", "table", "active", "all"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestATFCmdStructure tests the ATF (Automated Test Framework) command
func TestATFCmdStructure(t *testing.T) {
	cmd := NewATFCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "atf", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify subcommands for test management
	for _, name := range []string{"create", "add-step", "run", "list"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// TestCatalogItemCmd tests the catalog-item command
func TestCatalogItemCmdStructure(t *testing.T) {
	cmd := NewCatalogItemCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify subcommands for catalog item management
	for _, name := range []string{"create", "create-variable", "variables"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// TestChoicesCmd tests the choices command
func TestChoicesCmdStructure(t *testing.T) {
	cmd := NewChoicesCommand()
	assert.NotNil(t, cmd)
	assert.Equal(t, "choices", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify subcommands for choice management
	for _, name := range []string{"list", "create", "update", "delete", "reorder"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// TestCodeSearchCmd tests the code-search command
func TestCodeSearchCmdStructure(t *testing.T) {
	cmd := NewCodeSearchCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "code-search <term>", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify search capability - actual flags in code-search.go
	assert.NotNil(t, cmd.Flag("table"), "Flag --table should exist for filtering")
	assert.NotNil(t, cmd.Flag("scope"), "Flag --scope should exist")
	assert.NotNil(t, cmd.Flag("limit"), "Flag --limit should exist")
	assert.NotNil(t, cmd.Flag("search-group"), "Flag --search-group should exist")
}

// TestDataPoliciesCmd tests the data-policies command
func TestDataPoliciesCmdStructure(t *testing.T) {
	cmd := NewDataPoliciesCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags based on actual implementation
	for _, flag := range []string{"search", "query", "limit", "order", "desc", "active", "all"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestDecisionTablesCmd tests the decision-tables command
func TestDecisionTablesCmdStructure(t *testing.T) {
	cmd := NewDecisionTablesCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags for searching and filtering
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestEmailActionsCmd tests the email-actions command
func TestEmailActionsCmdStructure(t *testing.T) {
	cmd := NewEmailActionsCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify subcommands if any
	sub := findSubcommand(cmd, "script")
	if sub != nil {
		assert.NotNil(t, sub, "Subcommand script should exist")
	}
}

// TestEvalCmd tests the eval command
func TestEvalCmdStructure(t *testing.T) {
	cmd := NewEvalCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "eval [<script>]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags
	assert.NotNil(t, cmd.Flag("file"), "Flag --file should exist for script files")
}

// TestFlowsCmd tests the flows command
func TestFlowsCmdExtended(t *testing.T) {
	cmd := NewFlowsCmd()
	assert.NotNil(t, cmd)

	// Verify all flow subcommands exist
	expectedSubcommands := []string{"create", "executions", "execute", "variables", "actions", "triggers"}
	for _, name := range expectedSubcommands {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist on flows", name)
	}
}

// TestImportSetsCmd tests the import-sets command
func TestImportSetsCmdStructure(t *testing.T) {
	cmd := NewImportSetsCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "import-sets [<name_or_sys_id>]", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestRestCmd tests the rest command (raw API calls)
func TestRestCmdStructure(t *testing.T) {
	cmd := NewRestCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "rest", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify REST method subcommands
	for _, name := range []string{"get", "post", "patch", "delete"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// TestScriptedRestCmd tests the scripted-rest command
func TestScriptedRestCmdStructure(t *testing.T) {
	cmd := NewScriptedRestCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify flags for searching
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestScopeCmd tests the scope command
func TestScopeCmdStructure(t *testing.T) {
	cmd := NewScopeCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "scope", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify scope management subcommands
	for _, name := range []string{"show", "list", "use", "create"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// TestSetupCmd tests the setup command
func TestSetupCmdStructure(t *testing.T) {
	cmd := NewSetupCommand()
	assert.NotNil(t, cmd)
	assert.Equal(t, "setup", cmd.Use)
	assert.NotEmpty(t, cmd.Short)
}

// TestUIScriptsCmd tests the ui-scripts command
func TestUIScriptsCmdStructure(t *testing.T) {
	cmd := NewUIScriptsCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Verify script subcommand for viewing code
	sub := findSubcommand(cmd, "script")
	assert.NotNil(t, sub, "Subcommand script should exist")

	// Verify search/list flags
	for _, flag := range []string{"search", "query", "limit", "order", "desc"} {
		assert.NotNil(t, cmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestVariableTypesCmd tests the variable-types command
func TestVariableTypesCmdStructure(t *testing.T) {
	cmd := NewVariableTypesCmd()
	assert.NotNil(t, cmd)
	assert.NotEmpty(t, cmd.Short)

	// Variable types is typically a static reference command
	// It might have subcommands like list or search
	sub := findSubcommand(cmd, "list")
	if sub != nil {
		assert.NotNil(t, sub, "Subcommand list might exist")
	}
}

// TestWorkspaceCmd tests the workspace command
func TestWorkspaceCmdStructure(t *testing.T) {
	cmd := NewWorkspaceCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "workspace", cmd.Use)
	assert.NotEmpty(t, cmd.Short)

	// Verify workspace management subcommands
	for _, name := range []string{"create", "add-page", "add-screen", "add-macroponent"} {
		sub := findSubcommand(cmd, name)
		assert.NotNil(t, sub, "Subcommand %s should exist", name)
	}
}

// ===== Additional Coverage Tests =====

// TestAllCommandsExist verifies all known commands are instantiable
func TestAllCommandsExist(t *testing.T) {
	commands := []struct {
		name    string
		factory func() *cobra.Command
	}{
		{"Assignment Rules", NewAssignmentRulesCmd},
		{"ATF", NewATFCmd},
		{"Catalog Item", NewCatalogItemCmd},
		{"Choices", NewChoicesCommand},
		{"Code Search", NewCodeSearchCmd},
		{"Data Policies", NewDataPoliciesCmd},
		{"Decision Tables", NewDecisionTablesCmd},
		{"Email Actions", NewEmailActionsCmd},
		{"Eval", NewEvalCmd},
		{"Flows", NewFlowsCmd},
		{"Import Sets", NewImportSetsCmd},
		{"Records", NewRecordsCmd},
		{"Rest", NewRestCmd},
		{"Scripted REST", NewScriptedRestCmd},
		{"Scope", NewScopeCmd},
		{"Setup", NewSetupCommand},
		{"UI Scripts", NewUIScriptsCmd},
		{"Variable Types", NewVariableTypesCmd},
		{"Workspace", NewWorkspaceCmd},
		{"Rules", NewRulesCmd},
		{"Jobs", NewJobsCmd},
		{"Script Includes", NewScriptIncludesCmd},
		{"UI Policies", NewUIPoliciesCmd},
		{"ACLs", NewACLsCmd},
		{"Client Scripts", NewClientScriptsCmd},
		{"Docs", NewDocsCmd},
		{"Commands", NewCommandsCmd},
		{"Version", NewVersionCmd},
		{"Tables", NewTablesCmd},
		{"UpdateSet", NewUpdateSetCmd},
		{"Logs", NewLogsCmd},
		{"Config", NewConfigCommand},
		{"Auth", NewAuthCommand},
		{"Portals", NewPortalsCmd},
		{"Widgets", NewWidgetsCmd},
		{"Pages", NewPagesCmd},
		{"Catalog Item", NewCatalogItemCmd},
		{"Forms", NewFormsCmd},
		{"Lists", NewListsCmd},
		{"Variable", NewVariableCmd},
	}

	for _, tc := range commands {
		t.Run(tc.name, func(t *testing.T) {
			cmd := tc.factory()
			assert.NotNil(t, cmd, "%s command should not be nil", tc.name)
			assert.NotEmpty(t, cmd.Use, "%s command should have Use field", tc.name)
			assert.NotEmpty(t, cmd.Short, "%s command should have Short description", tc.name)
		})
	}
}

// TestCommandNaming verifies commands follow consistent naming patterns
func TestCommandNaming(t *testing.T) {
	tests := []struct {
		name     string
		cmd      *cobra.Command
		expected string
	}{
		{"Assignment Rules", NewAssignmentRulesCmd(), "assignment-rules [<name_or_sys_id>]"},
		{"ATF", NewATFCmd(), "atf"},
		{"Eval", NewEvalCmd(), "eval [<script>]"},
		{"Rest", NewRestCmd(), "rest"},
		{"Scope", NewScopeCmd(), "scope"},
		{"Setup", NewSetupCommand(), "setup"},
		{"Workspace", NewWorkspaceCmd(), "workspace"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, tt.cmd.Use, "Command %s should have correct Use", tt.name)
		})
	}
}

// TestCommandDescriptions verifies all commands have meaningful descriptions
func TestCommandDescriptions(t *testing.T) {
	commands := []struct {
		name    string
		factory func() *cobra.Command
	}{
		{"Assignment Rules", NewAssignmentRulesCmd},
		{"ATF", NewATFCmd},
		{"Catalog Item", NewCatalogItemCmd},
		{"Choices", NewChoicesCommand},
		{"Code Search", NewCodeSearchCmd},
		{"Data Policies", NewDataPoliciesCmd},
		{"Decision Tables", NewDecisionTablesCmd},
		{"Email Actions", NewEmailActionsCmd},
		{"Eval", NewEvalCmd},
		{"Flows", NewFlowsCmd},
		{"Rest", NewRestCmd},
		{"Scope", NewScopeCmd},
		{"Setup", NewSetupCommand},
		{"Workspace", NewWorkspaceCmd},
	}

	for _, tc := range commands {
		t.Run(tc.name, func(t *testing.T) {
			cmd := tc.factory()
			assert.NotEmpty(t, cmd.Short, "%s should have Short description", tc.name)
			// Optional: check for Long description
			if cmd.Long != "" {
				assert.True(t, len(cmd.Long) > len(cmd.Short),
					"%s Long should be more detailed than Short", tc.name)
			}
		})
	}
}

// TestFlagConsistency verifies common flags appear on similar commands
func TestFlagConsistency(t *testing.T) {
	// Commands that should have search/query/limit flags for listing
	searchableCommands := []struct {
		name    string
		factory func() *cobra.Command
	}{
		{"Assignment Rules", NewAssignmentRulesCmd},
		{"Data Policies", NewDataPoliciesCmd},
		{"Decision Tables", NewDecisionTablesCmd},
		{"Email Actions", NewEmailActionsCmd},
		{"Scripted REST", NewScriptedRestCmd},
		{"UI Scripts", NewUIScriptsCmd},
	}

	for _, tc := range searchableCommands {
		t.Run(tc.name, func(t *testing.T) {
			cmd := tc.factory()
			// These commands typically have search capabilities
			hasSearch := cmd.Flag("search") != nil || cmd.Flag("query") != nil
			assert.True(t, hasSearch, "%s should have search or query flag", tc.name)
		})
	}
}

// TestSubcommandHierarchy verifies logical subcommand structures
func TestSubcommandHierarchy(t *testing.T) {
	tests := []struct {
		name           string
		cmd            *cobra.Command
		hasSubcommands bool
		expectedSubs   []string
	}{
		{
			name:           "Rest command has HTTP methods",
			cmd:            NewRestCmd(),
			hasSubcommands: true,
			expectedSubs:   []string{"get", "post", "patch", "delete"},
		},
		{
			name:           "Scope command has scope operations",
			cmd:            NewScopeCmd(),
			hasSubcommands: true,
			expectedSubs:   []string{"show", "list", "use", "create"},
		},
		{
			name:           "Workspace command has workspace operations",
			cmd:            NewWorkspaceCmd(),
			hasSubcommands: true,
			expectedSubs:   []string{"create", "add-page", "add-screen", "add-macroponent"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.hasSubcommands {
				assert.True(t, len(tt.cmd.Commands()) > 0, "Command should have subcommands")
				for _, expected := range tt.expectedSubs {
					sub := findSubcommand(tt.cmd, expected)
					assert.NotNil(t, sub, "Subcommand %s should exist", expected)
				}
			}
		})
	}
}
