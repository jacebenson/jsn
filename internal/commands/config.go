package commands

import (
	"fmt"
	"strings"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

// normalizeInstanceURL ensures the URL has proper format
func normalizeInstanceURL(url string) string {
	url = strings.TrimSpace(url)
	url = strings.TrimSuffix(url, "/")
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		url = "https://" + url
	}
	return url
}

func NewConfigCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Configuration management",
	}

	cmd.AddCommand(newConfigAddCommand())
	cmd.AddCommand(newConfigListCommand())
	cmd.AddCommand(newConfigSwitchCommand())
	cmd.AddCommand(newConfigGetCommand())

	return cmd
}

func newConfigAddCommand() *cobra.Command {
	var (
		instanceURL string
		username    string
	)

	cmd := &cobra.Command{
		Use:   "add <name>",
		Short: "Add a new instance profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			if instanceURL == "" {
				return output.ErrUsage("instance URL is required (--url)")
			}

			instanceURL = normalizeInstanceURL(instanceURL)

			profile := &config.Profile{
				InstanceURL: instanceURL,
				Username:    username,
				AuthMethod:  "gck",
			}

			cfg.Profiles[args[0]] = profile
			if cfg.DefaultProfile == "" {
				cfg.DefaultProfile = args[0]
			}

			if err := cfg.Save(); err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			fmt.Printf("Added profile '%s' for %s\n", args[0], instanceURL)
			return nil
		},
	}

	cmd.Flags().StringVar(&instanceURL, "url", "", "ServiceNow instance URL")
	cmd.Flags().StringVar(&username, "username", "", "Username for authentication")

	return cmd
}

func newConfigListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List configured profiles",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			if len(cfg.Profiles) == 0 {
				fmt.Println("No profiles configured")
				fmt.Println("\nTo add a profile:")
				fmt.Println("  jsn config add <name> --url <instance-url>")
				return nil
			}

			fmt.Println("Profiles:")
			// Sort profile names for consistent output
			names := make([]string, 0, len(cfg.Profiles))
			for name := range cfg.Profiles {
				names = append(names, name)
			}
			for i := 0; i < len(names)-1; i++ {
				for j := i + 1; j < len(names); j++ {
					if names[i] > names[j] {
						names[i], names[j] = names[j], names[i]
					}
				}
			}
			for _, name := range names {
				profile := cfg.Profiles[name]
				active := ""
				if name == cfg.DefaultProfile {
					active = " *"
				}
				fmt.Printf("  %s%s\n", name, active)
				fmt.Printf("    URL: %s\n", profile.InstanceURL)
			}

			return nil
		},
	}
}

func newConfigSwitchCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "switch <name>",
		Short: "Switch active profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			if _, ok := cfg.Profiles[args[0]]; !ok {
				return output.ErrNotFound(fmt.Sprintf("profile '%s' not found", args[0]))
			}

			cfg.DefaultProfile = args[0]

			if err := cfg.Save(); err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			fmt.Printf("Switched to profile '%s'\n", args[0])
			return nil
		},
	}
}

func newConfigGetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "get",
		Short: "Show current configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			fmt.Printf("Config file: %s\n", config.GlobalConfigPath())
			fmt.Printf("Default profile: %s\n", cfg.DefaultProfile)

			if len(cfg.Profiles) > 0 {
				fmt.Println("\nProfiles:")
				for name, profile := range cfg.Profiles {
					fmt.Printf("  %s:\n", name)
					fmt.Printf("    URL: %s\n", profile.InstanceURL)
				}
			}

			return nil
		},
	}
}
