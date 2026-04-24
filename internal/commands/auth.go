// Package commands provides CLI commands.
package commands

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
)

// NewAuthCmd creates the auth command group.
func NewAuthCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage OAuth authentication",
		Long: `Manage OAuth authentication to ServiceNow instances.

Each ServiceNow instance is stored separately with its own OAuth tokens.
Uses ServiceNow SDK-style OAuth flow (copy-paste authorization code).

GETTING STARTED:
  1. Login to your ServiceNow instance:
     jsn auth login https://dev12345.service-now.com

  2. This opens your browser - complete authentication there

  3. Copy the authorization code shown and paste it back

  4. Check your authentication status:
     jsn auth status

INSTANCE URL FORMATS:
  • https://dev12345.service-now.com
  • https://acme.service-now.com
  • https://acmedev.servicenowservices.com`,
	}

	cmd.AddCommand(newAuthLoginCmd())
	cmd.AddCommand(newAuthRefreshCmd())
	cmd.AddCommand(newAuthLogoutCmd())
	cmd.AddCommand(newAuthStatusCmd())

	return cmd
}

func newAuthLoginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login [instance-url|profile-name]",
		Short: "Login to a ServiceNow instance via OAuth",
		Long: `Authenticate with a ServiceNow instance using OAuth 2.0 + PKCE.

This uses ServiceNow's SDK-style OAuth flow:
1. Opens browser to ServiceNow OAuth page
2. You complete authentication in browser
3. ServiceNow shows authorization code on page
4. Copy and paste that code back to CLI

You can specify either a full URL or a profile name (e.g., "dev373698").

REQUIREMENTS:
  • Your ServiceNow instance must have OAuth enabled
  • You need permissions to approve OAuth applications

EXAMPLES:
  # Login with URL
  jsn auth login https://dev12345.service-now.com

  # Login with profile name
  jsn auth login dev373698

  # From environment variable (automation/CI)
  export SERVICENOW_OAUTH_TOKEN=your-token
  jsn auth status`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			// Get instance URL - accept profile names or URLs
			var instanceURL string
			if len(args) > 0 {
				// Check if it's a profile name first
				if profile, ok := app.Config.Profiles[args[0]]; ok {
					instanceURL = profile.InstanceURL
				} else {
					instanceURL = args[0]
				}
			} else if app.Config.GetEffectiveInstance() != "" {
				instanceURL = app.Config.GetEffectiveInstance()
			} else {
				// Show interactive picker or error
				profiles := getProfileItems(app)
				if len(profiles) > 0 && app.IsInteractive() {
					picker := tui.NewProfilePicker(profiles)
					selected, err := picker.Run()
					if err != nil {
						return fmt.Errorf("profile selection failed: %w", err)
					}
					if selected == nil {
						return output.ErrUsage("No instance selected")
					}
					instanceURL = selected.Instance
				} else {
					return output.ErrUsage(`Instance URL required.

Examples:
  jsn auth login https://dev12345.service-now.com
  jsn auth login dev373698
  jsn auth login https://acme.service-now.com

Find your instance URL in your browser's address bar when logged into ServiceNow.`,
					)
				}
			}

			instanceURL = config.NormalizeInstanceURL(instanceURL)

			// Start OAuth flow
			if err := app.Auth.Login(instanceURL); err != nil {
				return err
			}

			// Create temporary auth provider for the new instance
			var username string
			newInstanceAuth := &instanceAuthProvider{
				instance: instanceURL,
				auth:     app.Auth,
			}
			tempSDK := sdk.NewClient(instanceURL, newInstanceAuth)
			if user, err := tempSDK.GetCurrentUser(context.Background()); err == nil {
				username = user.UserName
			}

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

			// Save as default instance if this is the first one
			setDefault := app.Config.InstanceURL == ""
			if setDefault {
				app.Config.InstanceURL = instanceURL
				app.Config.DefaultProfile = profileName
				if err := app.Config.Save(); err != nil {
					// Non-fatal - credentials are saved
					fmt.Fprintf(os.Stderr, "Warning: failed to save config: %v\n", err)
				}
			} else {
				// Still save the profile even if not setting as default
				if err := app.Config.Save(); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to save profile: %v\n", err)
				}
			}

			result := map[string]string{
				"message":  "Login successful",
				"instance": instanceURL,
			}
			if username != "" {
				result["username"] = username
			}
			if setDefault {
				result["default"] = "true"
			}

			summary := fmt.Sprintf("✓ Authenticated to %s", instanceURL)
			if username != "" {
				summary = fmt.Sprintf("✓ Authenticated to %s as %s", instanceURL, username)
			}

			return app.OK(result, output.WithSummary(summary))
		},
	}
}

// instanceAuthProvider is a custom auth provider for a specific instance.
type instanceAuthProvider struct {
	instance string
	auth     *auth.Manager
}

func (p *instanceAuthProvider) GetCredentials() (*sdk.Credentials, error) {
	return p.auth.GetCredentialsFor(p.instance)
}

func newAuthRefreshCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "refresh [instance-url|profile-name|number]",
		Short: "Refresh OAuth token for an instance",
		Long: `Refresh the OAuth access token using the stored refresh token.

This allows you to renew authentication without going through the full login flow.
Only works if you have a valid refresh token stored.

Examples:
  # Refresh current instance
  jsn auth refresh

  # Refresh specific instance by URL
  jsn auth refresh https://dev12345.service-now.com

  # Refresh by profile name
  jsn auth refresh dev12345

  # Refresh by profile number
  jsn auth refresh 1`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			var instanceURL string

			if len(args) == 0 {
				instanceURL = app.Config.GetEffectiveInstance()
				if instanceURL == "" {
					return output.ErrUsage(`No instance specified and no default configured.

Examples:
  jsn auth refresh
  jsn auth refresh https://dev12345.service-now.com
  jsn auth refresh dev12345
  jsn auth refresh 1`)
				}
			} else {
				// Check if it's a number
				profiles := getProfileItems(app)
				if num := parseProfileNumber(args[0]); num > 0 && num <= len(profiles) {
					instanceURL = profiles[num-1].Instance
				} else if profile, ok := app.Config.Profiles[args[0]]; ok {
					instanceURL = profile.InstanceURL
				} else {
					instanceURL = config.NormalizeInstanceURL(args[0])
				}
			}

			// Try to refresh the token
			creds, err := app.Auth.RefreshToken(instanceURL)
			if err != nil {
				return output.ErrAuth(fmt.Sprintf("Failed to refresh token for %s: %v", instanceURL, err))
			}

			return app.OK(map[string]any{
				"message":    "Token refreshed successfully",
				"instance":   instanceURL,
				"expires_at": creds.ExpiresAt,
			}, output.WithSummary(fmt.Sprintf("✓ Token refreshed for %s", instanceURL)))
		},
	}
}

func newAuthLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout [instance-url]",
		Short: "Logout from a ServiceNow instance",
		Long: `Remove stored OAuth credentials for a ServiceNow instance.

If no instance is specified, logs out from the current default instance.

Examples:
  # Logout from current instance
  jsn auth logout

  # Logout from specific instance
  jsn auth logout https://dev12345.service-now.com`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			var instanceURL string
			if len(args) > 0 {
				instanceURL = args[0]
			} else if app.Config.GetEffectiveInstance() != "" {
				instanceURL = app.Config.GetEffectiveInstance()
			} else {
				return output.ErrUsage(`No instance specified.

Examples:
  jsn auth logout
  jsn auth logout https://dev12345.service-now.com`)
			}

			instanceURL = config.NormalizeInstanceURL(instanceURL)

			if err := app.Auth.Logout(instanceURL); err != nil {
				return err
			}

			return app.OK(map[string]string{
				"message":  "Logout successful",
				"instance": instanceURL,
			}, output.WithSummary(fmt.Sprintf("✓ Logged out from %s", instanceURL)))
		},
	}
}

func newAuthStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show detailed authentication status",
		Long: `Show detailed OAuth authentication status.

Note: The context header already shows your current auth status.
Use this command for detailed information or troubleshooting.

Examples:
  # Show detailed status
  jsn auth status

  # Check all profile auth statuses
  jsn auth status --all`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			defaultInstance := app.Config.GetEffectiveInstance()

			// Build detailed status
			status := map[string]any{
				"default_instance": defaultInstance,
				"authenticated":    app.Auth.IsAuthenticated(),
			}

			// Check environment auth
			if token := os.Getenv("SERVICENOW_OAUTH_TOKEN"); token != "" {
				status["environment_auth"] = true
				status["environment_source"] = "SERVICENOW_OAUTH_TOKEN"
			}

			// Add profile list with auth status
			profiles := []map[string]any{}
			for name, profile := range app.Config.Profiles {
				isAuth := app.Auth.IsAuthenticatedFor(profile.InstanceURL)
				profiles = append(profiles, map[string]any{
					"name":          name,
					"instance":      profile.InstanceURL,
					"authenticated": isAuth,
					"is_default":    profile.InstanceURL == defaultInstance,
				})
			}
			status["profiles"] = profiles

			return app.OK(status, output.WithSummary(fmt.Sprintf("%d profile(s)", len(profiles))))
		},
	}
}
