// Package commands provides CLI commands.
package commands

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
)

// NewSetupCmd creates the setup command.
func NewSetupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Interactive first-time setup",
		Long: `Run interactive setup to configure jsn for first use.

This will guide you through:
  1. Entering your ServiceNow instance URL
  2. Authenticating with OAuth (copy-paste flow)
  3. Setting your default instance

You can run this anytime to reconfigure or add new instances.

Examples:
  # Run interactive setup
  jsn setup

  # Non-interactive setup (for automation)
  export SERVICENOW_OAUTH_TOKEN=your-token
  jsn auth login https://dev12345.service-now.com`,
		RunE: runSetup,
	}
}

func runSetup(cmd *cobra.Command, args []string) error {
	// Load config directly (setup is excluded from PersistentPreRunE)
	cfg, err := config.Load(config.FlagOverrides{})
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	// Create app context
	app := appctx.NewApp(cfg)

	// Check if already configured
	hasDefault := app.Config.GetEffectiveInstance() != ""
	isAuthenticated := app.Auth.IsAuthenticated()

	reader := bufio.NewReader(os.Stdin)

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "╔════════════════════════════════════════════════════════════╗")
	fmt.Fprintln(os.Stderr, "║           jsn - Jace's ServiceNow CLI                      ║")
	fmt.Fprintln(os.Stderr, "╚════════════════════════════════════════════════════════════╝")
	fmt.Fprintln(os.Stderr)

	if hasDefault {
		fmt.Fprintf(os.Stderr, "Current default instance: %s\n", app.Config.GetEffectiveInstance())
		if isAuthenticated {
			fmt.Fprintln(os.Stderr, "Status: ✓ Authenticated")
		} else {
			fmt.Fprintln(os.Stderr, "Status: ✗ Not authenticated")
		}
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "This setup will add a new instance or reconfigure the existing one.")
	} else {
		fmt.Fprintln(os.Stderr, "Welcome! Let's get you connected to ServiceNow.")
	}

	fmt.Fprintln(os.Stderr)

	// Step 1: Get instance URL
	fmt.Fprintln(os.Stderr, "STEP 1: ServiceNow Instance URL")
	fmt.Fprintln(os.Stderr, "────────────────────────────────────────────────────────────")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Your instance URL is typically one of these formats:")
	fmt.Fprintln(os.Stderr, "  • https://dev12345.service-now.com")
	fmt.Fprintln(os.Stderr, "  • https://acme.service-now.com")
	fmt.Fprintln(os.Stderr, "  • https://acmedev.servicenowservices.com")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Find it in your browser's address bar when logged into ServiceNow.")
	fmt.Fprintln(os.Stderr)

	var instanceURL string
	for instanceURL == "" {
		fmt.Fprint(os.Stderr, "Instance URL: ")
		input, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("failed to read input: %w", err)
		}
		instanceURL = strings.TrimSpace(input)

		if instanceURL == "" {
			fmt.Fprintln(os.Stderr, "  ✗ Instance URL is required")
			continue
		}

		// Normalize and validate
		instanceURL = config.NormalizeInstanceURL(instanceURL)

		// Basic validation
		if !strings.HasPrefix(instanceURL, "https://") && !strings.HasPrefix(instanceURL, "http://") {
			fmt.Fprintln(os.Stderr, "  ✗ URL must start with https://")
			instanceURL = ""
			continue
		}

		fmt.Fprintf(os.Stderr, "  ✓ Using: %s\n", instanceURL)
	}

	fmt.Fprintln(os.Stderr)

	// Step 2: OAuth authentication
	fmt.Fprintln(os.Stderr, "STEP 2: OAuth Authentication")
	fmt.Fprintln(os.Stderr, "────────────────────────────────────────────────────────────")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Opening browser for OAuth authentication...")
	fmt.Fprintln(os.Stderr)

	if err := app.Auth.Login(instanceURL); err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	// Get username for the new instance
	var username string
	tempSDK := sdk.NewClient(instanceURL, app.Auth)
	if user, err := tempSDK.GetCurrentUser(cmd.Context()); err == nil {
		username = user.UserName
	}

	fmt.Fprintf(os.Stderr, "  ✓ Authenticated successfully%s!\n", func() string {
		if username != "" {
			return " as " + username
		}
		return ""
	}())
	fmt.Fprintln(os.Stderr)

	// Step 3: Set as default
	fmt.Fprintln(os.Stderr, "STEP 3: Configuration")
	fmt.Fprintln(os.Stderr, "────────────────────────────────────────────────────────────")
	fmt.Fprintln(os.Stderr)

	// Add to profiles
	profileName := generateProfileName(instanceURL)
	if app.Config.Profiles == nil {
		app.Config.Profiles = make(map[string]*config.Profile)
	}
	app.Config.Profiles[profileName] = &config.Profile{
		InstanceURL: instanceURL,
		AuthMethod:  "oauth",
		Username:    username,
	}

	if hasDefault && app.Config.GetEffectiveInstance() != instanceURL {
		fmt.Fprintf(os.Stderr, "Current default: %s\n", app.Config.GetEffectiveInstance())
		fmt.Fprintf(os.Stderr, "New instance:    %s\n", instanceURL)
		fmt.Fprintln(os.Stderr)
		fmt.Fprint(os.Stderr, "Set as new default? [Y/n]: ")

		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(strings.ToLower(input))

		if input == "" || input == "y" || input == "yes" {
			app.Config.InstanceURL = instanceURL
			app.Config.DefaultProfile = profileName
			if err := app.Config.Save(); err != nil {
				fmt.Fprintf(os.Stderr, "  ⚠ Warning: failed to save config: %v\n", err)
			} else {
				fmt.Fprintln(os.Stderr, "  ✓ Set as default instance")
			}
		} else {
			// Still save the profile, just don't change default
			if err := app.Config.Save(); err != nil {
				fmt.Fprintf(os.Stderr, "  ⚠ Warning: failed to save config: %v\n", err)
			}
			fmt.Fprintln(os.Stderr, "  ℹ Keeping existing default")
			fmt.Fprintln(os.Stderr, "  ✓ Added new profile")
		}
	} else {
		app.Config.InstanceURL = instanceURL
		app.Config.DefaultProfile = profileName
		if err := app.Config.Save(); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ Warning: failed to save config: %v\n", err)
		} else {
			fmt.Fprintln(os.Stderr, "  ✓ Set as default instance")
		}
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "╔════════════════════════════════════════════════════════════╗")
	fmt.Fprintln(os.Stderr, "║              Setup Complete! ✓                             ║")
	fmt.Fprintln(os.Stderr, "╚════════════════════════════════════════════════════════════╝")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "You are now authenticated to:\n  %s\n\n", instanceURL)
	fmt.Fprintln(os.Stderr, "Next steps:")
	fmt.Fprintln(os.Stderr, "  jsn auth status     Check authentication status")
	fmt.Fprintln(os.Stderr, "  jsn --help          See available commands")
	fmt.Fprintln(os.Stderr)

	return app.OK(map[string]string{
		"message":  "Setup complete",
		"instance": instanceURL,
	}, output.WithSummary(fmt.Sprintf("✓ Setup complete - Authenticated to %s", instanceURL)))
}
