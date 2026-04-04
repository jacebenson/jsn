package commands

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
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
		Long: `Manage jsn configuration.

Configuration is loaded from multiple sources with the following precedence:
  flags > env > local > global

Config locations:
  - Global: ~/.config/servicenow/config.json
  - Local:  .servicenow/config.json

Config values can also be set via environment variables:
  SERVICENOW_TOKEN      Override authentication token
  SERVICENOW_INSTANCE  Override instance URL
  SERVICENOW_NO_KEYRING Use file storage instead of keyring`,
	}

	cmd.AddCommand(newConfigShowCommand())
	cmd.AddCommand(newConfigInitCommand())
	cmd.AddCommand(newConfigProfilesCommand())
	cmd.AddCommand(newConfigProfileCommand())
	cmd.AddCommand(newConfigSetCommand())
	cmd.AddCommand(newConfigUnsetCommand())

	return cmd
}

// newConfigShowCommand shows effective configuration with sources
func newConfigShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Show effective configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			// Determine sources
			profileSource := "default"
			profile := cfg.GetActiveProfile()

			if os.Getenv("SERVICENOW_INSTANCE") != "" {
				profileSource = "env"
			} else if cfg.DefaultProfile != "" || len(cfg.Profiles) > 0 {
				profileSource = "file"
			}

			fmt.Println("Effective configuration")
			fmt.Println()
			fmt.Printf("Profile    : map[source:%s value:%s]\n", profileSource, cfg.DefaultProfile)
			if profile != nil {
				fmt.Printf("Instance  : map[source:%s value:%s]\n", profileSource, profile.InstanceURL)
				if profile.AuthMethod != "" {
					fmt.Printf("Auth      : map[source:%s value:%s]\n", profileSource, profile.AuthMethod)
				}
			}

			// Show config file locations
			fmt.Println()
			fmt.Println("Config files:")
			fmt.Printf("  Global: %s\n", config.GlobalConfigPath())
			fmt.Printf("  Local:  %s\n", config.LocalConfigPath())

			// Show environment variables
			fmt.Println()
			fmt.Println("Environment variables:")
			if os.Getenv("SERVICENOW_TOKEN") != "" {
				fmt.Println("  SERVICENOW_TOKEN     : map[source:env value:***]")
			}
			if os.Getenv("SERVICENOW_INSTANCE") != "" {
				fmt.Printf("  SERVICENOW_INSTANCE : map[source:env value:%s]\n", os.Getenv("SERVICENOW_INSTANCE"))
			}

			return nil
		},
	}
}

// newConfigInitCommand initializes a config file
func newConfigInitCommand() *cobra.Command {
	var (
		instanceURL string
		name        string
		global      bool
	)

	cmd := &cobra.Command{
		Use:   "init [name]",
		Short: "Initialize a configuration profile",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			profileName := name
			if profileName == "" && len(args) > 0 {
				profileName = args[0]
			}
			if profileName == "" {
				profileName = "default"
			}

			if instanceURL == "" {
				return output.ErrUsage("instance URL is required (--url)")
			}

			instanceURL = normalizeInstanceURL(instanceURL)

			profile := &config.Profile{
				InstanceURL: instanceURL,
				AuthMethod:  "gck",
			}

			cfg.Profiles[profileName] = profile
			if cfg.DefaultProfile == "" {
				cfg.DefaultProfile = profileName
			}

			var err error
			if global {
				err = cfg.Save()
			} else {
				err = cfg.SaveLocal()
			}

			if err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			scope := "local"
			savePath := config.LocalConfigPath()
			if global {
				scope = "global"
				savePath = config.GlobalConfigPath()
			}

			fmt.Printf("Initialized %s profile '%s' for %s\n", scope, profileName, instanceURL)
			fmt.Printf("Saved to: %s\n", savePath)
			fmt.Println()
			fmt.Println("Next steps:")
			fmt.Println("  jsn auth login --method gck --token <your-token>")

			return nil
		},
	}

	cmd.Flags().StringVar(&instanceURL, "url", "", "ServiceNow instance URL (required)")
	cmd.Flags().StringVar(&name, "name", "", "Profile name (default: default)")
	cmd.Flags().BoolVar(&global, "global", false, "Save to global config instead of local")

	return cmd
}

// newConfigProfilesCommand lists all profiles
func newConfigProfilesCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "profiles",
		Short: "List all configuration profiles",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			if len(cfg.Profiles) == 0 {
				fmt.Println("No profiles configured")
				fmt.Println("\nTo create a profile:")
				fmt.Println("  jsn config init <name> --url <instance-url>")
				return nil
			}

			// Sort profile names
			names := make([]string, 0, len(cfg.Profiles))
			for name := range cfg.Profiles {
				names = append(names, name)
			}
			sort.Strings(names)

			// Show config file locations
			if cfg.GlobalPath != "" {
				fmt.Printf("Global: %s\n", cfg.GlobalPath)
			}
			if cfg.LocalPath != "" {
				fmt.Printf("Local:  %s\n", cfg.LocalPath)
			}

			authManager := app.Auth.(*auth.Manager)
			if authManager.GetStore().UsingKeyring() {
				fmt.Printf("Creds:  system keyring (service=%s)\n", "servicenow")
			} else {
				fmt.Printf("Creds:  %s\n", config.GlobalConfigDir()+"/credentials.json")
			}
			fmt.Println()

			for _, name := range names {
				profile := cfg.Profiles[name]
				active := ""
				if name == cfg.DefaultProfile {
					active = " *"
				}
				source := profile.Source
				if source == "" {
					source = "global"
				}
				fmt.Printf("  %s%s (%s)\n", name, active, source)
				fmt.Printf("    URL:  %s\n", profile.InstanceURL)
				if profile.AuthMethod != "" {
					fmt.Printf("    Auth: %s\n", profile.AuthMethod)
				}
			}

			return nil
		},
	}
}

// newConfigProfileCommand manages the default profile
func newConfigProfileCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profile [<name>]",
		Short: "Show or switch the default profile",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)

			// If no args, show current profile
			if len(args) == 0 {
				fmt.Printf("Current profile: %s\n", cfg.DefaultProfile)
				if cfg.DefaultProfile != "" {
					if profile, ok := cfg.Profiles[cfg.DefaultProfile]; ok {
						fmt.Printf("Instance: %s\n", profile.InstanceURL)
					}
				}
				return nil
			}

			// Switch profile
			newProfile := args[0]
			if _, ok := cfg.Profiles[newProfile]; !ok {
				return output.ErrNotFound(fmt.Sprintf("profile '%s' not found", newProfile))
			}

			cfg.DefaultProfile = newProfile

			if err := cfg.Save(); err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			fmt.Printf("Switched to profile '%s'\n", newProfile)
			return nil
		},
	}

	return cmd
}

// newConfigSetCommand sets a config value
func newConfigSetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a configuration value",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			key := args[0]
			value := args[1]

			switch strings.ToLower(key) {
			case "default-profile", "defaultprofile":
				if _, ok := cfg.Profiles[value]; !ok {
					return output.ErrNotFound(fmt.Sprintf("profile '%s' not found", value))
				}
				cfg.DefaultProfile = value
			case "suppress-updateset-warning", "suppressupdatesetwarning":
				activeProfile := cfg.GetActiveProfile()
				if activeProfile == nil {
					return output.ErrAuth("no active profile")
				}
				switch strings.ToLower(value) {
				case "true", "1", "yes":
					activeProfile.SuppressUpdateSetWarning = true
				case "false", "0", "no":
					activeProfile.SuppressUpdateSetWarning = false
				default:
					return output.ErrUsage("value must be 'true' or 'false'")
				}
			default:
				return output.ErrUsage(fmt.Sprintf("unknown config key: %s", key))
			}

			if err := cfg.Save(); err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			fmt.Printf("Set %s = %s\n", key, value)
			return nil
		},
	}
}

// newConfigUnsetCommand unsets a config value
func newConfigUnsetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "unset <key>",
		Short: "Unset a configuration value",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			key := args[0]

			switch strings.ToLower(key) {
			case "default-profile", "defaultprofile":
				cfg.DefaultProfile = ""
			case "suppress-updateset-warning", "suppressupdatesetwarning":
				activeProfile := cfg.GetActiveProfile()
				if activeProfile == nil {
					return output.ErrAuth("no active profile")
				}
				activeProfile.SuppressUpdateSetWarning = false
			default:
				return output.ErrUsage(fmt.Sprintf("unknown config key: %s", key))
			}

			if err := cfg.Save(); err != nil {
				return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
			}

			fmt.Printf("Unset %s\n", key)
			return nil
		},
	}
}
