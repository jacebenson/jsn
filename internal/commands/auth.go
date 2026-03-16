package commands

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

func NewAuthCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Authentication commands",
	}

	cmd.AddCommand(newAuthLoginCommand())
	cmd.AddCommand(newAuthLogoutCommand())
	cmd.AddCommand(newAuthStatusCommand())

	return cmd
}

func newAuthLoginCommand() *cobra.Command {
	var (
		username string
		password string
		token    string
		method   string
	)

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with the active ServiceNow profile",
		Long: `Authenticate with your ServiceNow instance using either Basic Auth or g_ck token.

This command authenticates using the active profile's instance URL.
To set up a profile first, use: jsn setup

Authentication methods:
  - Basic Auth: Username and password
  - g_ck Token: Glide cookie token from browser

To get a g_ck token:
  Quick method: Open DevTools console (F12) on any ServiceNow page and type: g_ck
  Alternative: DevTools → Application/Storage → Cookies → find 'g_ck'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			authManager := app.Auth.(*auth.Manager)

			// Get active profile
			profile := cfg.GetActiveProfile()
			if profile == nil {
				return output.ErrAuth("no active profile configured. Run: jsn setup")
			}

			instanceURL := profile.InstanceURL
			reader := bufio.NewReader(os.Stdin)

			// Determine auth method from profile or prompt
			if method == "" {
				if profile.AuthMethod != "" {
					method = profile.AuthMethod
				} else {
					fmt.Println("\nChoose authentication method:")
					fmt.Println("  1) Basic Auth (username/password)")
					fmt.Println("  2) g_ck Token (glide cookie from browser)")
					fmt.Print("\nMethod [1]: ")

					input, _ := reader.ReadString('\n')
					input = strings.TrimSpace(input)

					if input == "" || input == "1" {
						method = "basic"
					} else if input == "2" {
						method = "gck"
					} else {
						method = "basic"
					}
				}
			}

			if method == "basic" {
				// Basic Auth flow
				if username == "" {
					// Use username from profile if available
					if profile.Username != "" {
						username = profile.Username
						fmt.Printf("Username: %s\n", username)
					} else {
						fmt.Print("\nUsername: ")
						u, _ := reader.ReadString('\n')
						username = strings.TrimSpace(u)
					}
				}

				if password == "" {
					fmt.Print("Password: ")
					p, _ := reader.ReadString('\n')
					password = strings.TrimSpace(p)
				}

				creds := &auth.Credentials{
					Token:     password,
					Username:  username,
					CreatedAt: time.Now().Unix(),
				}

				if err := authManager.StoreCredentials(creds); err != nil {
					return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
				}

				// Update profile with auth method and username
				profile.AuthMethod = "basic"
				if profile.Username == "" {
					profile.Username = username
				}
				if err := cfg.Save(); err != nil {
					return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
				}

				fmt.Printf("\nSuccessfully authenticated with %s (Basic Auth)\n", instanceURL)
			} else {
				// g_ck Token flow
				if token == "" {
					fmt.Println("\nTo get your g_ck token, choose either method:")
					fmt.Println("  Quick: Open DevTools console (F12) and type: g_ck")
					fmt.Println("  Or: DevTools → Application/Storage → Cookies → find 'g_ck'")
					fmt.Print("\ng_ck token: ")
					tok, _ := reader.ReadString('\n')
					token = strings.TrimSpace(tok)
				}

				creds := &auth.Credentials{
					Token:     token,
					CreatedAt: time.Now().Unix(),
				}

				if err := authManager.StoreCredentials(creds); err != nil {
					return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
				}

				// Update profile with auth method
				profile.AuthMethod = "gck"
				if err := cfg.Save(); err != nil {
					return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
				}

				fmt.Printf("\nSuccessfully authenticated with %s (g_ck token)\n", instanceURL)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&username, "username", "", "Username (for Basic Auth)")
	cmd.Flags().StringVar(&password, "password", "", "Password (for Basic Auth)")
	cmd.Flags().StringVar(&token, "token", "", "g_ck token")
	cmd.Flags().StringVar(&method, "method", "", "Auth method (basic or gck)")

	return cmd
}

func newAuthLogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove stored credentials",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			authManager := app.Auth.(*auth.Manager)
			if err := authManager.DeleteCredentials(); err != nil {
				return output.ErrAuth(fmt.Sprintf("failed to remove credentials: %v", err))
			}

			fmt.Println("Successfully logged out")
			return nil
		},
	}
}

func newAuthStatusCommand() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show authentication status",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			profile := cfg.GetActiveProfile()
			authManager := app.Auth.(*auth.Manager)
			authenticated := authManager.IsAuthenticated()

			if jsonOutput {
				source := "file"
				if os.Getenv("SERVICENOW_TOKEN") != "" {
					source = "env"
				}

				result := map[string]interface{}{
					"authenticated": authenticated,
					"source":        source,
				}

				if profile != nil {
					result["instance"] = profile.InstanceURL
					result["profile"] = cfg.DefaultProfile
				}

				w := output.New(output.Options{Format: output.FormatJSON, Writer: os.Stdout})
				return w.OK(result)
			}

			if profile == nil {
				fmt.Println("Not authenticated (no profile configured)")
				return nil
			}

			if authenticated {
				fmt.Printf("Authenticated with %s\n", profile.InstanceURL)
				if os.Getenv("SERVICENOW_TOKEN") != "" {
					fmt.Println("Source: environment variable")
				} else {
					fmt.Println("Source: stored credentials")
				}
			} else {
				fmt.Printf("Not authenticated with %s\n", profile.InstanceURL)
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output as JSON")

	return cmd
}
