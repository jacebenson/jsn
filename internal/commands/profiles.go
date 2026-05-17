// Package commands provides CLI commands.
package commands

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// NewProfilesCmd creates the profiles command group.
func NewProfilesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "profiles",
		Aliases: []string{"profile"},
		Short:   "Manage ServiceNow instance profiles",
		Long: `Manage your ServiceNow instance profiles.

Each ServiceNow instance you authenticate to becomes a profile.
Use these commands to list, switch between, and manage your profiles.

Examples:
  # List all profiles
  jsn profiles list

  # Switch to a different profile
  jsn profiles use https://dev12345.service-now.com

  # Show current profile details
  jsn profiles show`,
	}

	cmd.AddCommand(newProfilesListCmd())
	cmd.AddCommand(newProfilesUseCmd())
	cmd.AddCommand(newProfilesShowCmd())
	cmd.AddCommand(newProfilesRemoveCmd())

	return cmd
}

func newProfilesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all profiles",
		Long:  "List all ServiceNow instance profiles you've authenticated to.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			// Get list of all instances from config
			instances := getAllInstances(app)

			if len(instances) == 0 {
				return app.OK(map[string]any{
					"profiles": []any{},
				}, output.WithSummary("No profiles found. Run: jsn auth login <instance-url>"))
			}

			// Build profile list with details
			var profiles []map[string]any
			defaultInstance := app.Config.GetEffectiveInstance()

			for _, instance := range instances {
				profile := map[string]any{
					"instance": instance,
					"default":  instance == defaultInstance,
				}

				// Check if authenticated
				if app.Auth.IsAuthenticatedFor(instance) {
					profile["authenticated"] = true
					profile["status"] = "authenticated"

					// Get username from profile config if available
					for _, p := range app.Config.Profiles {
						if p.InstanceURL == instance && p.Username != "" {
							profile["username"] = p.Username
							break
						}
					}
				} else {
					profile["authenticated"] = false
					profile["status"] = "not authenticated"
				}

				profiles = append(profiles, profile)
			}

			// Sort by instance name
			sort.Slice(profiles, func(i, j int) bool {
				return profiles[i]["instance"].(string) < profiles[j]["instance"].(string)
			})

			// Ensure default is first
			for i, p := range profiles {
				if p["default"].(bool) {
					// Move to front
					profiles = append([]map[string]any{p}, append(profiles[:i], profiles[i+1:]...)...)
					break
				}
			}

			count := len(profiles)
			summary := fmt.Sprintf("%d profile(s)", count)
			if count > 0 {
				summary = fmt.Sprintf("%d profile(s) - default: %s", count, defaultInstance)
			}

			return app.OK(map[string]any{
				"profiles": profiles,
				"default":  defaultInstance,
				"count":    count,
			}, output.WithSummary(summary))
		},
	}
}

func newProfilesUseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use [instance-url|profile-name|number]",
		Short: "Switch to a different profile",
		Long: `Set a different ServiceNow instance as the default profile.

Examples:
  # Interactive picker (shows list of profiles)
  jsn profiles use

  # Switch to a specific instance by URL
  jsn profiles use https://dev12345.service-now.com

  # Switch using profile name
  jsn profiles use dev12345

  # Switch using profile number from list
  jsn profiles use 2`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			var instanceURL string

			if len(args) == 0 {
				// No argument - show interactive picker
				profiles := getProfileItems(app)
				if len(profiles) == 0 {
					return output.ErrUsage("No profiles found. Run: jsn auth login <instance-url>")
				}

				if !app.IsInteractive() {
					return output.ErrUsage(`Instance URL, profile name, or number required.

Examples:
  jsn profiles use https://dev12345.service-now.com
  jsn profiles use dev12345
  jsn profiles use 2

Or run interactively:
  jsn profiles use`)
				}

				// Show interactive picker
				picker := tui.NewProfilePicker(profiles)
				selected, err := picker.Run()
				if err != nil {
					return fmt.Errorf("profile selection failed: %w", err)
				}
				if selected == nil {
					return output.ErrUsage("No profile selected")
				}
				instanceURL = selected.Instance
			} else {
				// Parse the argument - could be URL, profile name, or number
				arg := args[0]

				// Check if it's a number first
				if num := parseProfileNumber(arg); num > 0 {
					profiles := getProfileItems(app)
					if num <= len(profiles) {
						instanceURL = profiles[num-1].Instance
					} else {
						return output.ErrUsage(fmt.Sprintf("Invalid profile number: %d (only %d profiles available)", num, len(profiles)))
					}
				} else if profile, ok := app.Config.Profiles[arg]; ok {
					// It's a profile name
					instanceURL = profile.InstanceURL
				} else {
					// Assume it's a URL
					instanceURL = config.NormalizeInstanceURL(arg)
				}
			}

			// Check if we have credentials for this instance
			if !app.Auth.IsAuthenticatedFor(instanceURL) {
				// Try to refresh the token automatically
				_, refreshErr := app.Auth.RefreshToken(instanceURL)
				if refreshErr != nil {
					return output.ErrUsage(fmt.Sprintf(`Profile not authenticated: %s

This profile's OAuth token has expired and couldn't be refreshed automatically.
To re-authenticate, run:

  jsn auth login %s

Or try to refresh the token:

  jsn auth refresh %s`, instanceURL, instanceURL, instanceURL))
				}
				// Token refreshed successfully, continue with switch
			}

			// Set as default
			oldDefault := app.Config.InstanceURL
			app.Config.InstanceURL = instanceURL

			// Try to find profile name for this instance
			newProfileName := ""
			for name, profile := range app.Config.Profiles {
				if profile.InstanceURL == instanceURL {
					newProfileName = name
					break
				}
			}
			if newProfileName == "" {
				newProfileName = generateProfileName(instanceURL)
			}
			app.Config.DefaultProfile = newProfileName

			if err := app.Config.Save(); err != nil {
				return fmt.Errorf("failed to save config: %w", err)
			}

			return app.OK(map[string]any{
				"message":       "Switched default profile",
				"previous":      oldDefault,
				"current":       instanceURL,
				"authenticated": true,
			}, output.WithSummary(fmt.Sprintf("✓ Switched to %s", instanceURL)))
		},
	}
}

func newProfilesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [instance-url]",
		Short: "Show profile details",
		Long: `Show details for a specific profile or the current default.

Examples:
  # Show current profile
  jsn profiles show

  # Show specific profile
  jsn profiles show https://dev12345.service-now.com`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			var instanceURL string
			if len(args) > 0 {
				instanceURL = config.NormalizeInstanceURL(args[0])
			} else {
				instanceURL = app.Config.GetEffectiveInstance()
			}

			if instanceURL == "" {
				return output.ErrUsage("No instance specified and no default configured.")
			}

			// Build profile info
			profile := map[string]any{
				"instance": instanceURL,
				"default":  instanceURL == app.Config.GetEffectiveInstance(),
			}

			// Check auth status
			isAuth := app.Auth.IsAuthenticatedFor(instanceURL)
			profile["authenticated"] = isAuth

			if isAuth {
				profile["status"] = "authenticated"

				// Try to get current user info
				if instanceURL == app.Config.GetEffectiveInstance() && app.SDK != nil {
					if user, err := app.SDK.GetCurrentUser(context.Background()); err == nil {
						profile["user"] = map[string]string{
							"username": user.UserName,
							"name":     user.Name,
							"email":    user.Email,
						}
					}
				}
			} else {
				profile["status"] = "not authenticated"
			}

			summary := fmt.Sprintf("Profile: %s", instanceURL)
			if profile["default"].(bool) {
				summary += " (default)"
			}
			if isAuth {
				summary += " - authenticated"
			} else {
				summary += " - not authenticated"
			}

			return app.OK(profile, output.WithSummary(summary))
		},
	}
}

func newProfilesRemoveCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:     "remove [instance-url|profile-name|number]",
		Aliases: []string{"rm", "delete", "del"},
		Short:   "Remove a profile",
		Long: `Remove a ServiceNow instance profile and its stored credentials.

Examples:
  # Remove by instance URL
  jsn profiles remove https://dev12345.service-now.com

  # Remove by profile name
  jsn profiles remove dev12345

  # Remove by profile number from list
  jsn profiles remove 2

  # Skip confirmation prompt
  jsn profiles remove dev12345 --force`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			var instanceURL string

			if len(args) == 0 {
				// No argument - show interactive picker
				profiles := getProfileItems(app)
				if len(profiles) == 0 {
					return output.ErrUsage("No profiles found.")
				}

				if !app.IsInteractive() {
					return output.ErrUsage(`Instance URL, profile name, or number required.

Examples:
  jsn profiles remove https://dev12345.service-now.com
  jsn profiles remove dev12345
  jsn profiles remove 2`)
				}

				// Show interactive picker
				picker := tui.NewProfilePicker(profiles)
				selected, err := picker.Run()
				if err != nil {
					return fmt.Errorf("profile selection failed: %w", err)
				}
				if selected == nil {
					return output.ErrUsage("No profile selected")
				}
				instanceURL = selected.Instance
			} else {
				// Parse the argument - could be URL, profile name, or number
				arg := args[0]

				// Check if it's a number first
				if num := parseProfileNumber(arg); num > 0 {
					profiles := getProfileItems(app)
					if num <= len(profiles) {
						instanceURL = profiles[num-1].Instance
					} else {
						return output.ErrUsage(fmt.Sprintf("Invalid profile number: %d (only %d profiles available)", num, len(profiles)))
					}
				} else if profile, ok := app.Config.Profiles[arg]; ok {
					// It's a profile name
					instanceURL = profile.InstanceURL
				} else {
					// Assume it's a URL
					instanceURL = config.NormalizeInstanceURL(arg)
				}
			}

			if instanceURL == "" {
				return output.ErrUsage("No matching profile found.")
			}

			// Confirm deletion unless --force
			if !force && app.IsInteractive() {
				fmt.Fprintf(os.Stderr, "\nRemove profile %s? [y/N] ", instanceURL)
				reader := bufio.NewReader(os.Stdin)
				response, _ := reader.ReadString('\n')
				response = strings.TrimSpace(strings.ToLower(response))
				if response != "y" && response != "yes" {
					return app.OK(map[string]any{
						"removed": false,
					}, output.WithSummary("Removal cancelled"))
				}
			}

			// Remove from config profiles
			if app.Config.Profiles != nil {
				for name, p := range app.Config.Profiles {
					if p.InstanceURL == instanceURL {
						delete(app.Config.Profiles, name)
						break
					}
				}
			}

			// If this was the default, clear it
			wasDefault := instanceURL == app.Config.GetEffectiveInstance()
			if wasDefault {
				app.Config.InstanceURL = ""
				app.Config.DefaultProfile = ""
			}

			// Save config (both global and local)
			if err := app.Config.Save(); err != nil {
				return fmt.Errorf("failed to save config: %w", err)
			}
			_ = app.Config.SaveLocal() // also update local config if it exists

			// Remove stored credentials
			_ = app.Auth.Logout(instanceURL)

			return app.OK(map[string]any{
				"removed":     true,
				"instance":    instanceURL,
				"was_default": wasDefault,
			}, output.WithSummary(fmt.Sprintf("✓ Removed profile %s", instanceURL)))
		},
	}

	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")

	return cmd
}

// generateProfileName creates a profile name from an instance URL
func generateProfileName(instanceURL string) string {
	// Remove protocol
	name := strings.TrimPrefix(instanceURL, "https://")
	name = strings.TrimPrefix(name, "http://")
	// Remove common suffixes
	name = strings.TrimSuffix(name, ".service-now.com")
	name = strings.TrimSuffix(name, ".servicenowservices.com")
	// Replace dots and slashes with dashes
	name = strings.ReplaceAll(name, ".", "-")
	name = strings.ReplaceAll(name, "/", "-")
	return name
}

// getAllInstances returns a list of all instances from config and credentials.
func getAllInstances(app *appctx.App) []string {
	instanceMap := make(map[string]bool)

	// Get current default
	if defaultInstance := app.Config.GetEffectiveInstance(); defaultInstance != "" {
		instanceMap[defaultInstance] = true
	}

	// Check profiles in config
	if app.Config.Profiles != nil {
		for _, profile := range app.Config.Profiles {
			if profile.InstanceURL != "" {
				instanceMap[profile.InstanceURL] = true
			}
		}
	}

	// Convert map to slice
	var instances []string
	for instance := range instanceMap {
		instances = append(instances, instance)
	}

	return instances
}

// getProfileItems returns profile items for the interactive picker.
func getProfileItems(app *appctx.App) []tui.ProfileItem {
	instances := getAllInstances(app)
	var items []tui.ProfileItem

	// Sort instances to ensure consistent numbering
	sort.Strings(instances)

	// Find default instance index to put it first
	defaultInstance := app.Config.GetEffectiveInstance()
	var sortedInstances []string
	for _, instance := range instances {
		if instance == defaultInstance {
			sortedInstances = append([]string{instance}, sortedInstances...)
		} else {
			sortedInstances = append(sortedInstances, instance)
		}
	}

	for i, instance := range sortedInstances {
		name := generateProfileName(instance)
		// Check for profile name override in config
		for n, p := range app.Config.Profiles {
			if p.InstanceURL == instance {
				name = n
				break
			}
		}

		var status string
		username := ""

		if app.Auth.IsAuthenticatedFor(instance) {
			status = "valid"
			// Try to get username
			for _, p := range app.Config.Profiles {
				if p.InstanceURL == instance && p.Username != "" {
					username = p.Username
					break
				}
			}
		} else {
			status = "invalid"
		}

		items = append(items, tui.ProfileItem{
			Name:      name,
			Instance:  instance,
			IsDefault: instance == defaultInstance,
			Status:    status,
			Username:  username,
			Number:    i + 1,
		})
	}

	return items
}

// parseProfileNumber parses a string as a profile number.
// Returns 0 if not a valid number.
func parseProfileNumber(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 0
	}
	return n
}
