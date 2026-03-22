package commands

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

func NewAuthCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage ServiceNow authentication",
		Long: `Manage ServiceNow authentication including login, logout, and status.

Authentication methods:
  - Basic Auth: Username and password
  - g_ck Token: Session token from browser

To get a g_ck token:
  1. Log into your ServiceNow instance in a browser
  2. Open DevTools console (F12)
  3. Type: g_ck
  4. Copy the token that appears`,
	}

	cmd.AddCommand(newAuthLoginCommand())
	cmd.AddCommand(newAuthLogoutCommand())
	cmd.AddCommand(newAuthRefreshCommand())
	cmd.AddCommand(newAuthStatusCommand())
	cmd.AddCommand(newAuthTokenCommand())

	return cmd
}

func newAuthLoginCommand() *cobra.Command {
	var (
		username string
		password string
		token    string
		method   string
		curlCmd  string
	)

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with the active ServiceNow profile",
		Long: `Authenticate with your ServiceNow instance using either Basic Auth, g_ck token, or by pasting a curl command.

This command authenticates using the active profile's instance URL.
To set up a profile first, use: jsn setup

Authentication methods:
  - Basic Auth: Username and password
  - g_ck Token: Paste curl command from browser DevTools
  - From curl: Copy a request as curl from browser Network tab

To get auth from curl:
  1. Log into your ServiceNow instance in a browser
  2. Open DevTools (F12) → Network tab
  3. Filter for API requests (type "api" in filter)
  4. Right-click any api/now/* request → Copy → Copy as cURL
  5. Paste the curl command when prompted`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			authManager := app.Auth.(*auth.Manager)

			// Handle curl-based login - read from flag, args, or stdin
			if curlCmd == "" && len(args) > 0 {
				curlCmd = args[0]
			}
			if curlCmd == "" {
				// Check if there's data on stdin
				stat, _ := os.Stdin.Stat()
				if (stat.Mode() & os.ModeCharDevice) == 0 {
					// stdin has data, read it
					data, _ := io.ReadAll(os.Stdin)
					curlCmd = strings.TrimSpace(string(data))
				}
			}
			if curlCmd != "" {
				return loginFromCurl(cmd, cfg, authManager, curlCmd)
			}

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
				// g_ck Token flow - requires curl command to extract token + cookies
				fmt.Println("\nTo authenticate with g_ck, paste a curl command from your browser.")
				fmt.Println()
				fmt.Println("Steps:")
				fmt.Println("  1. Log into your ServiceNow instance in a browser")
				fmt.Println("  2. Open DevTools (F12) → Network tab")
				fmt.Println("  3. Filter for API requests (type 'api' in the filter)")
				fmt.Println("  4. Right-click any api/now/* request → Copy → Copy as cURL")
				fmt.Println("  5. Paste below and press Enter, then Ctrl+D")
				fmt.Println()

				var curlLines []string
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						break // EOF
					}
					curlLines = append(curlLines, line)
				}

				if len(curlLines) == 0 {
					return output.ErrUsage("no input received. Run: jsn auth login --curl '<curl command>'")
				}

				curlInput := strings.TrimSpace(strings.Join(curlLines, " "))
				return loginFromCurl(cmd, cfg, authManager, curlInput)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&username, "username", "", "Username (for Basic Auth)")
	cmd.Flags().StringVar(&password, "password", "", "Password (for Basic Auth)")
	cmd.Flags().StringVar(&token, "token", "", "g_ck token")
	cmd.Flags().StringVar(&method, "method", "", "Auth method (basic or gck)")
	cmd.Flags().StringVar(&curlCmd, "curl", "", "Paste a curl command from browser DevTools")

	return cmd
}

// parsedCurl holds auth info extracted from a curl command
type parsedCurl struct {
	InstanceURL string
	Token       string
	Cookies     string
	Username    string
	Password    string
	IsGCK       bool
}

// parseCurlCommand parses a curl command and extracts auth info
func parseCurlCommand(curlCmd string) (*parsedCurl, error) {
	result := &parsedCurl{}

	// Extract URL from curl command
	urlMatch := regexp.MustCompile(`curl\s+['"]?(https?://[^'"\s]+)['"]?`).FindStringSubmatch(curlCmd)
	if len(urlMatch) < 2 {
		// Try alternative format with -X GET and URL
		urlMatch2 := regexp.MustCompile(`-X\s+GET\s+['"]?(https?://[^'"\s]+)['"]?`).FindStringSubmatch(curlCmd)
		if len(urlMatch2) < 2 {
			return nil, fmt.Errorf("could not find URL in curl command")
		}
		result.InstanceURL = urlMatch2[1]
	} else {
		result.InstanceURL = urlMatch[1]
	}

	// Extract X-UserToken header (case insensitive - Chrome lowercases it)
	tokenPatterns := []string{
		`(?i)-H\s+['"]x-usertoken:\s*([^'"]+)['"]`,
		`(?i)x-usertoken:\s*([^\s'"]+)`,
	}
	for _, pattern := range tokenPatterns {
		tokenMatch := regexp.MustCompile(pattern).FindStringSubmatch(curlCmd)
		if len(tokenMatch) >= 2 {
			result.Token = strings.TrimSpace(tokenMatch[1])
			result.IsGCK = true
			break
		}
	}

	// Extract Cookie header (from -H or -b flags)
	// Chrome's "Copy as cURL" uses: -b 'cookie1=val1; cookie2=val2'
	cookiePatterns := []string{
		`(?i)-H\s+['"]cookie:\s*([^'"]+)['"]`,
		`-b\s+'([^']+)'`,
		`-b\s+"([^"]+)"`,
		`-b\s+(\S+)`,
	}
	for _, pattern := range cookiePatterns {
		cookieMatch := regexp.MustCompile(pattern).FindStringSubmatch(curlCmd)
		if len(cookieMatch) >= 2 {
			result.Cookies = strings.TrimSpace(cookieMatch[1])
			break
		}
	}

	// Extract Authorization header (Basic Auth)
	authMatch := regexp.MustCompile(`-H\s+['"]Authorization:\s*(.+?)['"]`).FindStringSubmatch(curlCmd)
	if len(authMatch) >= 2 {
		auth := strings.TrimSpace(authMatch[1])
		if strings.HasPrefix(auth, "Basic ") {
			// Decode Basic Auth
			encoded := strings.TrimPrefix(auth, "Basic ")
			decoded, err := base64Decode(encoded)
			if err == nil {
				parts := strings.SplitN(decoded, ":", 2)
				if len(parts) == 2 {
					result.Username = parts[0]
					result.Password = parts[1]
				}
			}
		}
	}

	// Extract -u username:password format
	userMatch := regexp.MustCompile(`-u\s+['"]?([^'"\s:]+):([^'"\s]+)['"]?`).FindStringSubmatch(curlCmd)
	if len(userMatch) >= 3 {
		result.Username = userMatch[1]
		result.Password = userMatch[2]
	}

	return result, nil
}

// base64Decode decodes a base64 string
func base64Decode(s string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(s)
		if err != nil {
			return "", err
		}
	}
	return string(data), nil
}

// loginFromCurl handles authentication by parsing a curl command
func loginFromCurl(cmd *cobra.Command, cfg *config.Config, authManager *auth.Manager, curlCmd string) error {
	parsed, err := parseCurlCommand(curlCmd)
	if err != nil {
		return output.ErrUsage(fmt.Sprintf("failed to parse curl command: %v\n\nMake sure you copied the full curl command including the URL.", err))
	}

	if parsed.InstanceURL == "" {
		return output.ErrUsage("could not find ServiceNow instance URL in curl command")
	}

	// Ensure profile exists for this instance
	profileName := cfg.DefaultProfile
	if profileName == "" {
		// Extract instance name from URL for profile name
		parts := strings.Split(strings.TrimPrefix(parsed.InstanceURL, "https://"), ".")
		profileName = parts[0]
	}

	profile, ok := cfg.Profiles[profileName]
	if !ok {
		profile = &config.Profile{
			InstanceURL: parsed.InstanceURL,
		}
		cfg.Profiles[profileName] = profile
	}

	// Update profile URL if different
	if profile.InstanceURL != parsed.InstanceURL {
		profile.InstanceURL = parsed.InstanceURL
	}

	// Store credentials
	var creds *auth.Credentials
	if parsed.IsGCK {
		if parsed.Token == "" {
			return output.ErrUsage("no X-UserToken found in curl command")
		}
		if parsed.Cookies == "" {
			return output.ErrUsage("no Cookie header found in curl command. Make sure you copied the full curl command.")
		}
		creds = &auth.Credentials{
			Token:     parsed.Token,
			Cookies:   parsed.Cookies,
			CreatedAt: time.Now().Unix(),
		}
		profile.AuthMethod = "gck"
		fmt.Printf("Auth method: g_ck token\n")
	} else if parsed.Username != "" {
		creds = &auth.Credentials{
			Token:     parsed.Password,
			Username:  parsed.Username,
			CreatedAt: time.Now().Unix(),
		}
		profile.AuthMethod = "basic"
		profile.Username = parsed.Username
		fmt.Printf("Auth method: Basic Auth\n")
	} else {
		return output.ErrUsage("could not find authentication info in curl command")
	}

	if err := authManager.StoreCredentials(creds); err != nil {
		return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
	}

	if err := cfg.Save(); err != nil {
		return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
	}

	fmt.Printf("Instance: %s\n", parsed.InstanceURL)
	fmt.Printf("Profile: %s\n", profileName)
	fmt.Printf("\nSuccessfully authenticated!\n")

	return nil
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
				fmt.Printf("Profile: %s\n", cfg.DefaultProfile)
				if profile.AuthMethod != "" {
					fmt.Printf("Auth:    %s\n", profile.AuthMethod)
				}
				if os.Getenv("SERVICENOW_TOKEN") != "" {
					fmt.Println("Source:  environment variable")
				} else if authManager.GetStore().UsingKeyring() {
					fmt.Println("Source:  system keyring")
				} else {
					fmt.Printf("Source:  %s\n", config.GlobalConfigDir()+"/credentials.json")
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

func newAuthRefreshCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "refresh",
		Short: "Verify authentication is working",
		Long: `Verify that your authentication is working by fetching your user record.

This command attempts to retrieve your user record from the sys_user table,
which verifies that your credentials (Basic Auth or g_ck token) are valid.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			profile := cfg.GetActiveProfile()
			if profile == nil {
				return output.ErrAuth("no active profile configured. Run: jsn setup")
			}

			sdkClient := app.SDK.(*sdk.Client)
			user, err := sdkClient.GetCurrentUser(cmd.Context())
			if err != nil {
				return output.ErrAuth(fmt.Sprintf("authentication failed: %v", err))
			}

			fmt.Printf("Authentication successful!\n")
			fmt.Printf("Instance: %s\n", profile.InstanceURL)
			fmt.Printf("User:     %s (%s)\n", user.Name, user.UserName)
			fmt.Printf("Email:    %s\n", user.Email)

			return nil
		},
	}

	return cmd
}

func newAuthTokenCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "token",
		Short: "Show current authentication token",
		Long: `Show information about the current authentication token.

Note: The actual token is never shown, only its status.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			profile := cfg.GetActiveProfile()
			authManager := app.Auth.(*auth.Manager)

			// Check environment variable first
			if os.Getenv("SERVICENOW_TOKEN") != "" {
				fmt.Println("Token: map[source:env value:***]")
				return nil
			}

			if profile == nil {
				fmt.Println("Token: map[source:none value:]")
				return nil
			}

			creds, err := authManager.GetCredentials()
			if err != nil || creds == nil || creds.Token == "" {
				fmt.Println("Token: map[source:none value:]")
				return nil
			}

			// Redact the token
			tokenValue := creds.Token
			if len(tokenValue) > 8 {
				tokenValue = tokenValue[:4] + "..." + tokenValue[len(tokenValue)-4:]
			} else {
				tokenValue = "***"
			}

			fmt.Printf("Token: map[source:keyring value:%s]\n", tokenValue)

			return nil
		},
	}

	return cmd
}
