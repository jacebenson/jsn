// Package cli provides the command-line interface.
package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/commands"
	"github.com/jacebenson/jsn/internal/config"
)

var (
	// Global flags
	instanceFlag string
	profileFlag  string
	formatFlag   string
	jsonFlag     bool
	quietFlag    bool
	styledFlag   bool
	markdownFlag bool
)

// Execute runs the CLI.
func Execute() error {
	return NewRootCmd().Execute()
}

// NewRootCmd creates the root command.
func NewRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "jsn",
		Short: "Command-line interface for ServiceNow",
		Long: `Command-line interface for ServiceNow

Work with multiple ServiceNow instances (dev, test, prod, clients) from your terminal.
Each instance is stored as a separate profile with its own OAuth credentials.`,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			// Skip for help and version commands
			if cmd.Name() == "help" || cmd.Name() == "version" || cmd.Name() == "setup" {
				return nil
			}

			// Determine format from flags
			format := "auto"
			if jsonFlag {
				format = "json"
			} else if quietFlag {
				format = "quiet"
			} else if styledFlag {
				format = "styled"
			} else if markdownFlag {
				format = "markdown"
			} else if formatFlag != "" {
				format = formatFlag
			}

			// Load configuration
			cfg, err := config.Load(config.FlagOverrides{
				Instance: instanceFlag,
				Profile:  profileFlag,
				Format:   format,
			})
			if err != nil {
				return err
			}

			// Create app context
			app := appctx.NewApp(cfg)

			// Store in command context
			ctx := appctx.WithApp(cmd.Context(), app)
			cmd.SetContext(ctx)

			// Check if authenticated for non-auth commands
			if !app.Auth.IsAuthenticated() && cfg.GetEffectiveInstance() != "" {
				fmt.Fprintf(os.Stderr, "\n⚠️  Not authenticated to %s\n\n", cfg.GetEffectiveInstance())
				fmt.Fprintln(os.Stderr, "To get started, run:")
				fmt.Fprintln(os.Stderr, "  jsn setup           # Interactive setup")
				fmt.Fprintf(os.Stderr, "  jsn auth login %s   # Login to instance\n\n", cfg.GetEffectiveInstance())
			}

			// Print context header for interactive terminals
			if cmd.Name() != "help" && cmd.Name() != "version" && cmd.Name() != "completion" {
				app.PrintContextHeader()
			}

			return nil
		},
	}

	// Global flags
	cmd.PersistentFlags().StringVar(&instanceFlag, "instance", "", "ServiceNow instance URL (e.g., https://dev12345.service-now.com)")
	cmd.PersistentFlags().StringVarP(&profileFlag, "profile", "p", "", "Configuration profile to use")
	cmd.PersistentFlags().StringVar(&formatFlag, "format", "", "Output format: auto, json, markdown, styled, quiet")
	cmd.PersistentFlags().BoolVar(&jsonFlag, "json", false, "Output in JSON format")
	cmd.PersistentFlags().BoolVarP(&quietFlag, "quiet", "q", false, "Output only data, no envelope")
	cmd.PersistentFlags().BoolVar(&styledFlag, "styled", false, "Force styled output")
	cmd.PersistentFlags().BoolVar(&markdownFlag, "markdown", false, "Output in Markdown format")

	// Add commands
	cmd.AddCommand(commands.NewSetupCmd())
	cmd.AddCommand(commands.NewAuthCmd())
	cmd.AddCommand(commands.NewProfilesCmd())
	cmd.AddCommand(commands.NewRecordsCmd())

	// Phase 2: Work commands
	cmd.AddCommand(commands.NewIncidentsCmd())
	cmd.AddCommand(commands.NewChangesCmd())
	cmd.AddCommand(commands.NewRequestsCmd())
	cmd.AddCommand(commands.NewTasksCmd())
	cmd.AddCommand(commands.NewUsersCmd())
	cmd.AddCommand(commands.NewGroupsCmd())
	cmd.AddCommand(commands.NewGroupMembersCmd())
	cmd.AddCommand(commands.NewGroupRolesCmd())

	// Phase 3: Dev commands
	cmd.AddCommand(commands.NewDevCmd())

	// Utility commands
	cmd.AddCommand(commands.NewVersionCmd())

	// Hide the auto-generated completion command from main help
	// (Users can still use: jsn completion bash)
	cmd.InitDefaultCompletionCmd()
	if c := findSubcommand(cmd, "completion"); c != nil {
		c.Hidden = true
	}

	// Set custom help template
	cmd.SetUsageTemplate(customHelpTemplate)
	cmd.SetFlagErrorFunc(func(c *cobra.Command, err error) error {
		return err
	})

	return cmd
}

// customHelpTemplate is a cleaner, categorized help template inspired by basecamp-cli.
// For root command, show categorized commands. For subcommands, show flat list.
const customHelpTemplate = `Usage:
  {{.UseLine}}{{if .HasAvailableSubCommands}} <command>{{end}}{{- if not .Parent}}

CORE COMMANDS{{range .Commands}}{{if (and (eq .Name "incidents") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "changes") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "requests") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "tasks") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}

DATA & ADMIN{{range .Commands}}{{if (and (eq .Name "records") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "users") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "groups") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "groupmembers") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "grouproles") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}

DEVELOPMENT{{range .Commands}}{{if (and (eq .Name "dev") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}

CONFIGURATION{{range .Commands}}{{if (and (eq .Name "auth") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "profiles") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{if (and (eq .Name "setup") (not .Hidden))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{else}}{{- if .HasAvailableSubCommands}}

Available Commands:{{- range .Commands}}{{if not .Hidden}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{end}}{{end}}
{{- if .HasAvailableLocalFlags}}

FLAGS
{{.LocalFlags.FlagUsages}}
{{- end}}
{{- if .HasAvailableInheritedFlags}}

GLOBAL FLAGS
{{.InheritedFlags.FlagUsages}}
{{- end}}{{if not .Parent}}

EXAMPLES
  $ jsn incidents              # List all incidents
  $ jsn inc INC0010001       # Show incident details
  $ jsn inc create           # Create a new incident
  $ jsn records list --table task --query "active=true"

LEARN MORE
  Use "jsn <command> --help" for more information about a command.{{end}}
`

// findSubcommand finds a subcommand by name.
func findSubcommand(cmd *cobra.Command, name string) *cobra.Command {
	for _, c := range cmd.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}
