// Package commands provides CLI commands.
package commands

import (
	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/commands/dev"
)

// NewDevCmd creates the dev command group.
func NewDevCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dev",
		Short: "Manage ServiceNow development artifacts",
		Long: `Manage ServiceNow development artifacts.

AUTOMATIONS
  flows         Manage Flow Designer flows
  actions       Manage action definitions

SCRIPTS
  includes      Manage script includes
  rules         Manage business rules
  clientscripts Manage client scripts
  uiactions     Manage UI actions
  uipolicies    Manage UI policies

DATA
  tables        List table definitions
  columns       Manage column definitions
  forms         Manage UI Forms
  lists         Manage UI List layouts
  import        Manage import sets

SERVICE PORTAL
  sppages       Manage Service Portal pages
  spwidgets     Manage Service Portal widgets

CLASSIC UI
  uipages       Manage Classic UI pages
  appmenu       Manage Classic UI application menus

INTEGRATION
  scrapi        Manage Scripted REST APIs

SECURITY
  acls          Manage access controls
  roles         Manage roles

PLATFORM
  updatesets    Manage update sets
  scopes        List application scopes
  properties    Manage system properties
  logs          Query system logs
  rest          Make raw REST API calls
  eval          Execute background scripts

Examples:
  # Show this help
  jsn dev

  # List script includes
  jsn dev includes list

  # List business rules
  jsn dev rules list

  # List flows
  jsn dev flows list

  # Show table details
  jsn dev tables show incident`,
		SilenceUsage: true,
	}

	// Custom help to show categories but suppress auto-generated commands
	cmd.SetHelpFunc(func(c *cobra.Command, args []string) {
		c.Println(c.Long)
		c.Println()
		c.Printf(`Usage:
  jsn %s [flags] <command>

Flags:
  -h, --help   help for %s

Global Flags:
      --format string     Output format: auto, json, markdown, styled, quiet
      --instance string   ServiceNow instance URL
      --json              Output in JSON format
      --markdown          Output in Markdown format
  -p, --profile string    Configuration profile to use
  -q, --quiet             Output only data, no envelope
      --styled            Force styled output
`, c.Name(), c.Name())
	})

	cmd.AddCommand(
		// Automations
		dev.NewFlowsCmd(),
		dev.NewActionsCmd(),

		// Scripts
		dev.NewIncludesCmd(),
		dev.NewRulesCmd(),
		dev.NewClientScriptsCmd(),
		dev.NewUIActionsCmd(),
		dev.NewUIPoliciesCmd(),

		// Data
		dev.NewTablesCmd(),
		dev.NewColumnsCmd(),
		dev.NewFormsCmd(),
		dev.NewListsCmd(),
		dev.NewImportCmd(),

		// Service Portal
		dev.NewSPPagesCmd(),
		dev.NewSPWidgetsCmd(),

		// Classic UI
		dev.NewUIPagesCmd(),
		dev.NewAppMenuCmd(),

		// Integration
		dev.NewScRAPICmd(),

		// Security
		dev.NewACLsCmd(),
		dev.NewRolesCmd(),

		// Platform
		dev.NewUpdateSetsCmd(),
		dev.NewScopesCmd(),
		dev.NewPropertiesCmd(),
		dev.NewLogsCmd(),
		dev.NewRestCmd(),
		dev.NewEvalCmd(),
	)

	return cmd
}
