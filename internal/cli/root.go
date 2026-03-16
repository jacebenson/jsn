package cli

import (
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/commands"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

var (
	cfgFile    string
	profile    string
	jsonOutput bool
	agentMode  bool
	quietMode  bool
	mdOutput   bool
	jqFilter   string
)

func NewRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "jsn",
		Short:         "ServiceNow CLI - agent-first, agent-native",
		Long:          `A CLI for exploring and managing ServiceNow instances.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			return initializeApp(cmd)
		},
	}

	root.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is $HOME/.config/servicenow/config.json)")
	root.PersistentFlags().StringVarP(&profile, "profile", "p", "", "profile to use")
	root.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	root.PersistentFlags().BoolVar(&agentMode, "agent", false, "Agent mode (JSON + quiet + no interactive prompts)")
	root.PersistentFlags().BoolVarP(&quietMode, "quiet", "q", false, "Quiet output (data only, no envelope)")
	root.PersistentFlags().BoolVar(&mdOutput, "md", false, "Output as Markdown")
	root.PersistentFlags().StringVar(&jqFilter, "jq", "", "Apply jq filter to JSON output")

	root.AddCommand(commands.NewAuthCommand())
	root.AddCommand(commands.NewConfigCommand())
	root.AddCommand(commands.NewSetupCommand())
	root.AddCommand(commands.NewTablesCmd())
	root.AddCommand(commands.NewUpdateSetCmd())
	root.AddCommand(commands.NewChoicesCommand())
	root.AddCommand(commands.NewRecordsCmd())
	root.AddCommand(commands.NewFlowsCmd())
	root.AddCommand(commands.NewRulesCmd())
	root.AddCommand(commands.NewJobsCmd())
	root.AddCommand(commands.NewScriptIncludesCmd())
	root.AddCommand(commands.NewCommandsCmd())
	root.AddCommand(commands.NewVersionCmd())

	return root
}

func Execute() error {
	return NewRootCommand().Execute()
}

func initializeApp(cmd *cobra.Command) error {
	cfg, err := config.Load(cfgFile, profile)
	if err != nil {
		return err
	}

	authManager := auth.NewManager(cfg)

	// Determine output format from flags
	var format output.Format
	switch {
	case agentMode, quietMode:
		format = output.FormatQuiet
	case jsonOutput:
		format = output.FormatJSON
	case mdOutput:
		format = output.FormatMarkdown
	default:
		format = output.FormatAuto
	}

	// Create output writer
	outputOpts := output.Options{
		Format:   format,
		Writer:   cmd.OutOrStdout(),
		JQFilter: jqFilter,
	}
	outputWriter := output.New(outputOpts)

	// Create SDK client
	var sdkClient *sdk.Client
	if activeProfile := cfg.GetActiveProfile(); activeProfile != nil {
		sdkClient = sdk.NewClient(activeProfile.InstanceURL, func() (string, string) {
			// Get credentials
			creds, err := authManager.GetCredentials()
			if err != nil {
				return "", ""
			}

			// For basic auth: username/password
			// For gck: use token as password with empty username
			if activeProfile.AuthMethod == "basic" {
				return activeProfile.Username, creds.Token
			}
			return "", creds.Token
		})
	}

	app := &appctx.App{
		Config: cfg,
		Auth:   authManager,
		Output: outputWriter,
	}

	// Only set SDK if we have a valid client
	if sdkClient != nil {
		app.SDK = sdkClient
	}

	ctx := appctx.WithContext(cmd.Context(), app)
	cmd.SetContext(ctx)

	return nil
}
