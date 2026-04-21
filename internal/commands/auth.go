package commands

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func NewAuthCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage ServiceNow authentication",
		Long: `Manage ServiceNow authentication including login, logout, and status.
Run with no args to see authentication status (like git status).

Authentication methods:
  - OAuth: Browser-based OAuth 2.0 with PKCE (recommended, most secure)
  - Basic Auth: Username and password
  - g_ck Token: Session token from browser

To get a g_ck token:
  1. Log into your ServiceNow instance in a browser
  2. Open DevTools console (F12)
  3. Type: g_ck
  4. Copy the token that appears`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand given - show status (git-style behavior)
			return runAuthStatus(cmd, false)
		},
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
		Long: `Authenticate with your ServiceNow instance using either Basic Auth, OAuth, g_ck token, or by pasting a curl command.

This command authenticates using the active profile's instance URL.
To set up a profile first, use: jsn setup

Authentication methods:
  - Basic Auth: Username and password
  - OAuth: Browser-based OAuth 2.0 with PKCE (most secure)
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
			// Only check for curl if method is not explicitly set to oauth
			if method != "oauth" {
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
					fmt.Println("  2) OAuth (browser-based, most secure)")
					fmt.Println("  3) g_ck Token (glide cookie from browser)")
					fmt.Print("\nMethod [2]: ")

					input, _ := reader.ReadString('\n')
					input = strings.TrimSpace(input)

					if input == "" || input == "2" {
						method = "oauth"
					} else if input == "1" {
						method = "basic"
					} else if input == "3" {
						method = "gck"
					} else {
						method = "oauth"
					}
				}
			}

			if method == "oauth" {
				// OAuth flow
				creds, err := auth.OAuthFlow(instanceURL)
				if err != nil {
					return output.ErrAuth(fmt.Sprintf("OAuth authentication failed: %v", err))
				}

				if err := authManager.StoreCredentials(creds); err != nil {
					return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
				}

				// Update profile with auth method
				profile.AuthMethod = "oauth"
				if err := cfg.Save(); err != nil {
					return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", err))
				}

				fmt.Printf("\nSuccessfully authenticated with %s (OAuth)\n", instanceURL)
				return nil
			} else if method == "basic" {
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
					if term.IsTerminal(int(syscall.Stdin)) {
						bytePass, err := term.ReadPassword(int(syscall.Stdin))
						if err == nil {
							password = string(bytePass)
							fmt.Println(" ********")
						} else {
							p, _ := reader.ReadString('\n')
							password = strings.TrimSpace(p)
						}
					} else {
						p, _ := reader.ReadString('\n')
						password = strings.TrimSpace(p)
					}
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
				fmt.Println("  5. Paste below and press Enter")
				fmt.Println()

				curlInput, err := readCurlHidden(reader)
				if err != nil {
					return output.ErrUsage(err.Error())
				}

				if curlInput == "" {
					return output.ErrUsage("no input received. Run: jsn auth login --curl '<curl command>'")
				}

				return loginFromCurl(cmd, cfg, authManager, curlInput)
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&username, "username", "", "Username (for Basic Auth)")
	cmd.Flags().StringVar(&password, "password", "", "Password (for Basic Auth)")
	cmd.Flags().StringVar(&token, "token", "", "g_ck token")
	cmd.Flags().StringVar(&method, "method", "", "Auth method (basic, oauth, or gck)")
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

// extractBaseURL extracts the base URL (scheme + host) from a full URL
// e.g., "https://store.servicenow.com/appStore.do" -> "https://store.servicenow.com"
func extractBaseURL(fullURL string) string {
	// Remove any path, query, or fragment by finding the third slash
	// https://host -> https://host (no change)
	// https://host/path -> https://host
	if idx := strings.Index(fullURL[8:], "/"); idx != -1 {
		return fullURL[:8+idx]
	}
	return fullURL
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

// filterServiceNowCookies strips non-essential cookies from a cookie string.
// Only keeps cookies needed for ServiceNow session authentication, reducing
// credential size to avoid keyring storage limits.
func filterServiceNowCookies(cookies string) string {
	essential := map[string]bool{
		"JSESSIONID":           true,
		"glide_session_store":  true,
		"glide_user_route":     true,
		"glide_user_activity":  true,
		"glide_node_id_for_js": true,
	}

	var kept []string
	for _, cookie := range strings.Split(cookies, ";") {
		cookie = strings.TrimSpace(cookie)
		if cookie == "" {
			continue
		}
		name := cookie
		if idx := strings.Index(cookie, "="); idx != -1 {
			name = cookie[:idx]
		}
		if essential[strings.TrimSpace(name)] {
			kept = append(kept, cookie)
		}
	}

	if len(kept) == 0 {
		return cookies // keep original if no essential cookies found
	}
	return strings.Join(kept, "; ")
}

// readCurlHidden reads a pasted curl command with terminal echo disabled.
// Shows "********" while pasting, completes when a line doesn't end with \
// (shell continuation), or on Ctrl+D/Ctrl+C. For non-terminal input, reads
// readCurlHidden reads a curl command with echo disabled.
// For interactive terminals, disables echo so pasted text is hidden.
// For non-interactive input, reads lines from the buffered reader until EOF.
func readCurlHidden(reader *bufio.Reader) (string, error) {
	if !term.IsTerminal(int(syscall.Stdin)) {
		// Non-interactive: read until EOF
		var lines []string
		for {
			input, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			lines = append(lines, input)
		}
		return joinCurlLines(lines), nil
	}

	// Disable echo via raw mode (cross-platform)
	fd := int(syscall.Stdin)
	oldState, err := term.MakeRaw(fd)
	if err != nil {
		// Fallback to normal read
		var lines []string
		for {
			input, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			lines = append(lines, input)
		}
		return joinCurlLines(lines), nil
	}

	// In raw mode, output processing is disabled, so use \r\n for newlines
	fmt.Fprint(os.Stderr, "  (input hidden) ")

	var lines []string
	var line []byte
	buf := make([]byte, 1)

	for {
		n, err := os.Stdin.Read(buf)
		if err != nil || n == 0 {
			break
		}
		b := buf[0]

		if b == 0x03 { // Ctrl+C
			_ = term.Restore(fd, oldState)
			fmt.Fprint(os.Stderr, "\r\n")
			return "", fmt.Errorf("cancelled")
		}
		if b == 0x04 { // Ctrl+D
			if len(line) > 0 {
				lines = append(lines, string(line))
			}
			break
		}

		if b == '\r' || b == '\n' {
			lineStr := string(line)
			lines = append(lines, lineStr)
			line = nil

			// If this line doesn't end with \, the curl command is complete
			trimmed := strings.TrimRight(lineStr, " \t")
			if !strings.HasSuffix(trimmed, "\\") {
				break
			}
		} else {
			line = append(line, b)
		}
	}

	_ = term.Restore(fd, oldState)
	fmt.Fprint(os.Stderr, "✓\r\n")

	return joinCurlLines(lines), nil
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

	// Extract base URL (scheme + host) from the parsed URL for the profile
	// The curl command may include a path (e.g., /appStore.do), but we only want the base URL
	baseURL := extractBaseURL(parsed.InstanceURL)

	// Ensure profile exists for this instance
	profileName := cfg.DefaultProfile
	if profileName == "" {
		// Extract instance name from URL for profile name
		parts := strings.Split(strings.TrimPrefix(baseURL, "https://"), ".")
		profileName = parts[0]
	}

	profile, ok := cfg.Profiles[profileName]
	if !ok {
		profile = &config.Profile{
			InstanceURL: baseURL,
		}
		cfg.Profiles[profileName] = profile
	}

	// Update profile URL if different (using base URL, not full URL with path)
	if profile.InstanceURL != baseURL {
		profile.InstanceURL = baseURL
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
			Cookies:   filterServiceNowCookies(parsed.Cookies),
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
	var force bool

	cmd := &cobra.Command{
		Use:   "logout",
		Short: "Remove stored credentials",
		Long: `Remove stored credentials for the active profile.

WARNING: This will permanently delete your stored authentication credentials.
You will need to run "jsn auth login" again to authenticate.

Use --force to skip the confirmation prompt (for scripts/automation).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			if app == nil {
				return output.ErrAuth("app not initialized")
			}

			cfg := app.Config.(*config.Config)
			profile := cfg.GetActiveProfile()
			authManager := app.Auth.(*auth.Manager)

			if profile == nil {
				return output.ErrAuth("no active profile configured")
			}

			// Check if we have credentials to delete
			if !authManager.IsAuthenticated() {
				fmt.Println("No credentials found for the active profile")
				return nil
			}

			// Require confirmation unless --force is used
			if !force {
				fmt.Printf("⚠️  WARNING: This will remove stored credentials for profile '%s' (%s)\n", cfg.DefaultProfile, profile.InstanceURL)
				fmt.Print("Are you sure? [y/N]: ")

				reader := bufio.NewReader(os.Stdin)
				response, _ := reader.ReadString('\n')
				response = strings.TrimSpace(strings.ToLower(response))

				if response != "y" && response != "yes" {
					fmt.Println("Logout cancelled")
					return nil
				}
			}

			if err := authManager.DeleteCredentials(); err != nil {
				return output.ErrAuth(fmt.Sprintf("failed to remove credentials: %v", err))
			}

			fmt.Println("✓ Successfully logged out")
			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

func newAuthStatusCommand() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show authentication status for all profiles",
		Long: `Show authentication status for all configured profiles.

This command tests each profile by attempting to connect to its ServiceNow instance
and displays the results in a simple table format.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAuthStatus(cmd, jsonOutput)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output as JSON")

	return cmd
}

// runAuthStatus shows authentication status for all profiles.
// Used by both the status subcommand and the parent auth command (git-style).
func runAuthStatus(cmd *cobra.Command, jsonOutput bool) error {
	app := appctx.FromContext(cmd.Context())
	if app == nil {
		return output.ErrAuth("app not initialized")
	}

	cfg := app.Config.(*config.Config)
	authManager := app.Auth.(*auth.Manager)

	if len(cfg.Profiles) == 0 {
		if jsonOutput {
			w := output.New(output.Options{Format: output.FormatJSON, Writer: os.Stdout})
			return w.OK(map[string]interface{}{
				"profiles": []map[string]interface{}{},
			})
		}
		fmt.Println("No profiles configured. Run: jsn config add")
		return nil
	}

	type profileStatus struct {
		Profile    string `json:"profile"`
		Instance   string `json:"instance"`
		User       string `json:"user"`
		AuthType   string `json:"auth_type"`
		StatusCode int    `json:"status_code"`
		Status     string `json:"status"`
	}

	var results []profileStatus

	// Get the original active profile to restore later
	originalProfile := cfg.DefaultProfile

	for profileName, profile := range cfg.Profiles {
		result := profileStatus{
			Profile:  profileName,
			Instance: profile.InstanceURL,
		}

		// Temporarily set this as the active profile to test it
		cfg.DefaultProfile = profileName

		// Check if we have credentials
		creds, err := authManager.GetCredentialsForProfile(profileName)
		if err != nil || creds == nil || (creds.Token == "" && creds.AccessToken == "") {
			result.StatusCode = 0
			result.Status = "no credentials"
			result.AuthType = profile.AuthMethod
			if result.AuthType == "" {
				result.AuthType = "-"
			}
			results = append(results, result)
			continue
		}

		// Determine auth method
		authMethod := profile.AuthMethod
		if creds.AuthMethod != "" {
			authMethod = creds.AuthMethod
		}
		result.AuthType = authMethod
		if result.AuthType == "" {
			result.AuthType = "basic"
		}

		// Create a temporary SDK client for this profile
		testClient := sdk.NewClient(profile.InstanceURL, func() (string, string, string) {
			switch authMethod {
			case "oauth":
				return creds.AccessToken, "", "oauth"
			case "gck":
				return creds.Token, creds.Cookies, "gck"
			default:
				return creds.Token, creds.Username, "basic"
			}
		})

		// Test the connection - try to get current user
		user, err := testClient.GetCurrentUser(cmd.Context())
		if err != nil {
			// For OAuth, try a simpler API call as fallback
			if authMethod == "oauth" {
				_, _, apiErr := testClient.RawRequest(cmd.Context(), "GET", "/api/now/table/sys_user?sysparm_limit=1", nil, nil)
				if apiErr == nil {
					result.StatusCode = 200
					result.Status = "ok"
					result.User = "OAuth User"
				} else {
					result.StatusCode = 401
					result.Status = "auth failed"
				}
			} else {
				result.StatusCode = 401
				result.Status = "auth failed"
			}
		} else {
			result.StatusCode = 200
			result.Status = "ok"
			result.User = user.UserName

			// Update last tested timestamp
			creds.LastTested = time.Now().Unix()
			_ = authManager.StoreCredentials(creds)
		}

		results = append(results, result)
	}

	// Restore the original active profile
	cfg.DefaultProfile = originalProfile

	if jsonOutput {
		w := output.New(output.Options{Format: output.FormatJSON, Writer: os.Stdout})
		return w.OK(map[string]interface{}{
			"profiles": results,
		})
	}

	// Print simple table output
	fmt.Printf("%-20s %-35s %-10s %-20s %s\n", "PROFILE", "INSTANCE", "TYPE", "USER", "STATUS")
	fmt.Println(strings.Repeat("-", 105))

	for _, r := range results {
		instance := r.Instance
		if len(instance) > 33 {
			instance = instance[:30] + "..."
		}

		user := r.User
		if user == "" {
			user = "-"
		}
		if len(user) > 18 {
			user = user[:15] + "..."
		}

		authType := r.AuthType
		if authType == "" {
			authType = "-"
		}

		statusStr := fmt.Sprintf("%d %s", r.StatusCode, r.Status)
		if r.StatusCode == 0 {
			statusStr = r.Status
		}

		fmt.Printf("%-20s %-35s %-10s %-20s %s\n", r.Profile, instance, authType, user, statusStr)
	}

	return nil
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

// formatDuration formats a duration in seconds to a human-readable string
func formatDuration(seconds int64) string {
	if seconds < 0 {
		return "expired"
	}
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm", seconds/60)
	}
	if seconds < 86400 {
		return fmt.Sprintf("%dh", seconds/3600)
	}
	return fmt.Sprintf("%dd", seconds/86400)
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

			// Check OAuth environment variable first
			if os.Getenv("SERVICENOW_OAUTH_TOKEN") != "" {
				fmt.Println("Token: map[source:env type:oauth value:***]")
				return nil
			}

			// Check environment variable first
			if os.Getenv("SERVICENOW_TOKEN") != "" {
				fmt.Println("Token: map[source:env type:basic value:***]")
				return nil
			}

			if profile == nil {
				fmt.Println("Token: map[source:none type: value:]")
				return nil
			}

			creds, err := authManager.GetCredentials()
			if err != nil || creds == nil {
				fmt.Println("Token: map[source:none type: value:]")
				return nil
			}

			// Determine auth type and token
			var tokenValue, authType string
			if creds.IsOAuth() {
				authType = "oauth"
				tokenValue = creds.AccessToken
			} else if profile.AuthMethod == "gck" {
				authType = "gck"
				tokenValue = creds.Token
			} else {
				authType = "basic"
				tokenValue = creds.Token
			}

			if tokenValue == "" {
				fmt.Println("Token: map[source:none type: value:]")
				return nil
			}

			// Redact the token
			if len(tokenValue) > 8 {
				tokenValue = tokenValue[:4] + "..." + tokenValue[len(tokenValue)-4:]
			} else {
				tokenValue = "***"
			}

			// Show OAuth-specific info
			if creds.IsOAuth() && creds.ExpiresAt > 0 {
				expiresIn := creds.ExpiresAt - time.Now().Unix()
				expiresStr := formatDuration(expiresIn)
				fmt.Printf("Token: map[source:keyring type:%s value:%s expires:%s]\n", authType, tokenValue, expiresStr)
			} else {
				fmt.Printf("Token: map[source:keyring type:%s value:%s]\n", authType, tokenValue)
			}

			return nil
		},
	}

	return cmd
}
