package cli

// Reserved Short Flags
//
// These short flags have established meanings across multiple commands.
// Avoid reusing them for different purposes to prevent conflicts.
//
//   -p  --profile       (global) Profile to use
//   -q  --quiet         (global) Quiet output
//   -n  --limit/count   Number of items to fetch
//   -t  --table/type    Table name or type filter
//   -f  --field/file    Field name or file path
//   -i  --interactive   Enable interactive mode
//   -o  --output        Output file or format
//   -s  --scope         Application scope filter
//   -l  --level/limit   Log level or limit
//   -m  --minutes       Time range in minutes
//
// When adding new flags, prefer long-form only if the short form
// would conflict or be ambiguous.

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/commands"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

var (
	cfgFile       string
	profile       string
	jsonOutput    bool
	agentMode     bool
	quietMode     bool
	mdOutput      bool
	jqFilter      string
	noInteractive bool
)

func NewRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:   "jsn",
		Short: "ServiceNow CLI - agent-first, agent-native",
		Long: `A CLI for exploring and managing ServiceNow instances.

Output modes (pick one):
  --json     JSON envelope {ok, data, summary, breadcrumbs} — use when parsing
  --md       Markdown tables — use when showing results to humans
  --quiet    Raw JSON data only (no envelope)
  --agent    JSON + quiet + no interactive prompts (for automation)
  --jq <f>   Apply jq filter to JSON output

Discovery:
  jsn commands --md       Full command catalog with descriptions and hints
  jsn <command> --help    Detailed usage for any command

Hierarchy: Use specific commands (rules, flows, etc.) first. Fall back to
'records --table <name>' for generic CRUD. Use 'rest' as a raw escape hatch.`,
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
	root.PersistentFlags().BoolVar(&noInteractive, "no-interactive", false, "Disable interactive prompts (for scripts/CI)")

	// ─── Explore ─────────────────────────────────────────────────────────
	root.AddCommand(commands.NewTablesCmd())
	root.AddCommand(commands.NewRecordsCmd())
	root.AddCommand(commands.NewRulesCmd())
	root.AddCommand(commands.NewFlowsCmd())
	root.AddCommand(commands.NewJobsCmd())
	root.AddCommand(commands.NewLogsCmd())

	// ─── Scripts ─────────────────────────────────────────────────────────
	root.AddCommand(commands.NewScriptIncludesCmd())
	root.AddCommand(commands.NewClientScriptsCmd())
	root.AddCommand(commands.NewUIScriptsCmd())
	root.AddCommand(commands.NewACLsCmd())

	// ─── UI ──────────────────────────────────────────────────────────────
	root.AddCommand(commands.NewUIPoliciesCmd())
	root.AddCommand(commands.NewFormsCmd())
	root.AddCommand(commands.NewListsCmd())
	root.AddCommand(commands.NewChoicesCommand())

	// ─── Service Catalog ─────────────────────────────────────────────────
	root.AddCommand(commands.NewCatalogItemCmd())
	root.AddCommand(commands.NewVariableCmd())
	root.AddCommand(commands.NewVariableTypesCmd())

	// ─── Service Portal ──────────────────────────────────────────────────
	root.AddCommand(commands.NewPortalsCmd())
	root.AddCommand(commands.NewWidgetsCmd())
	root.AddCommand(commands.NewPagesCmd())

	// ─── Dev Tools ───────────────────────────────────────────────────────
	root.AddCommand(commands.NewUpdateSetCmd())
	root.AddCommand(commands.NewScopeCmd())

	root.AddCommand(commands.NewRestCmd())
	root.AddCommand(commands.NewEvalCmd())

	// ─── Config ──────────────────────────────────────────────────────────
	root.AddCommand(commands.NewConfigCommand())
	root.AddCommand(commands.NewAuthCommand())
	root.AddCommand(commands.NewSetupCommand())
	root.AddCommand(commands.NewInstanceCmd())

	// ─── Help ────────────────────────────────────────────────────────────
	root.AddCommand(commands.NewDocsCmd())
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

	// First-run auto-setup: if no profiles exist, run setup
	if len(cfg.Profiles) == 0 && !noInteractive && !agentMode {
		if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
			fmt.Fprintln(os.Stderr, "First run detected. Starting setup...")
			setupCmd := commands.NewSetupCommand()
			setupCmd.SetIn(cmd.InOrStdin())
			setupCmd.SetOut(cmd.OutOrStdout())
			setupCmd.SetErr(cmd.ErrOrStderr())
			if err := setupCmd.Execute(); err != nil {
				return fmt.Errorf("setup failed: %w", err)
			}
			// Reload config after setup
			cfg, err = config.Load(cfgFile, profile)
			if err != nil {
				return err
			}
		}
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
		sdkClient = sdk.NewClient(activeProfile.InstanceURL, func() (string, string, bool) {
			// Get credentials
			creds, err := authManager.GetCredentials()
			if err != nil {
				return "", "", false
			}

			// For g_ck tokens: use X-UserToken header + cookies
			// For basic auth: token=password, cookies=username (repurposed)
			if activeProfile.AuthMethod == "gck" {
				return creds.Token, creds.Cookies, true
			}
			// Basic auth: token is password, pass username via cookies slot
			return creds.Token, creds.Username, false
		})
	}

	app := &appctx.App{
		Config: cfg,
		Auth:   authManager,
		Output: outputWriter,
		Flags: map[string]interface{}{
			"no-interactive": noInteractive || agentMode,
		},
	}

	// Only set SDK if we have a valid client
	if sdkClient != nil {
		app.SDK = sdkClient
	}

	ctx := appctx.WithContext(cmd.Context(), app)
	cmd.SetContext(ctx)

	// Check for default update set warning (only in interactive mode)
	if sdkClient != nil && format != output.FormatQuiet && format != output.FormatJSON && !agentMode {
		checkDefaultUpdateSet(cmd.Context(), sdkClient)
	}

	return nil
}

// checkDefaultUpdateSet warns users if they're working in the default update set.
// This helps prevent accidental changes to the default update set.
func checkDefaultUpdateSet(ctx context.Context, sdkClient *sdk.Client) {
	currentUser, err := sdkClient.GetCurrentUser(ctx)
	if err != nil {
		return // Silently skip if we can't get the user
	}

	currentUpdateSet, err := sdkClient.GetCurrentUpdateSet(ctx, currentUser.SysID)
	if err != nil || currentUpdateSet == nil {
		return // Silently skip if we can't get the update set
	}

	// Check if update set name contains "default" (case-insensitive)
	if strings.Contains(strings.ToLower(currentUpdateSet.Name), "default") {
		warningStyle := lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#ffaa00"))
		hintStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888"))
		scopeStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#e8a217"))

		scope := currentUpdateSet.AppName
		if scope == "" {
			scope = currentUpdateSet.Application
		}
		if scope == "" {
			scope = "global"
		}

		fmt.Fprintln(os.Stderr, warningStyle.Render("⚠ You're in the 'default' update set"))
		fmt.Fprintln(os.Stderr, scopeStyle.Render("  Scope: "+scope))
		fmt.Fprintln(os.Stderr, hintStyle.Render("  Run 'jsn updateset use' to select or create an update set"))
		fmt.Fprintln(os.Stderr)
	}
}
