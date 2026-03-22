package commands

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"os"
	"regexp"
	"strings"
	"syscall"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// NewSetupCommand creates the setup command for interactive first-time setup.
func NewSetupCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Interactive first-time setup",
		Long: `Walk through instance configuration and authentication setup.

This command will guide you through:
  1. Instance URL configuration
  2. Authentication setup (Basic Auth or g_ck token)
  3. Saving your configuration`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			return runSetup(cmd, app)
		},
	}

	return cmd
}

func runSetup(cmd *cobra.Command, app *appctx.App) error {
	if app == nil {
		return fmt.Errorf("app not initialized")
	}

	fmt.Println()
	fmt.Println("╔═══════════════════════════════════════╗")
	fmt.Println("║     Welcome to ServiceNow CLI         ║")
	fmt.Println("╚═══════════════════════════════════════╝")
	fmt.Println()
	fmt.Println("Let's get you set up. This will only take a moment.")
	fmt.Println()

	cfg := app.Config.(*config.Config)

	// Step 1: Instance URL
	instanceURL, err := setupInstanceURL(cfg)
	if err != nil {
		return err
	}

	// Step 2: Profile name
	profileName, err := setupProfileName(cfg)
	if err != nil {
		return err
	}

	// Step 3: Authentication
	if err := setupAuth(cmd, app, instanceURL, profileName); err != nil {
		return err
	}

	// Show completion
	fmt.Println()
	fmt.Println("───────────────────────────────────────")
	fmt.Println("✓ Setup complete!")
	fmt.Println("───────────────────────────────────────")
	fmt.Println()
	fmt.Printf("Instance: %s\n", instanceURL)
	fmt.Printf("Profile:  %s\n", profileName)
	fmt.Println()
	fmt.Println("Try these commands:")
	fmt.Printf("  jsn tables list          List available tables\n")
	fmt.Printf("  jsn tables get incident  Get an incident record\n")
	fmt.Printf("  jsn auth status          Check authentication status\n")
	fmt.Println()

	return nil
}

func setupInstanceURL(cfg *config.Config) (string, error) {
	fmt.Println("Step 1: Instance URL")
	fmt.Println()
	fmt.Println("Enter your ServiceNow instance URL.")
	fmt.Println("Examples:")
	fmt.Println("  https://mycompany.service-now.com")
	fmt.Println("  https://dev12345.service-now.com")
	fmt.Println()

	// Check if we already have profiles
	var defaultURL string
	if len(cfg.Profiles) > 0 {
		for _, profile := range cfg.Profiles {
			defaultURL = profile.InstanceURL
			break
		}
	}

	var instanceURL string
	reader := bufio.NewReader(os.Stdin)
	for {
		if defaultURL != "" {
			fmt.Printf("Instance URL [%s]: ", defaultURL)
		} else {
			fmt.Print("Instance URL: ")
		}

		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		if input == "" && defaultURL != "" {
			instanceURL = defaultURL
			break
		}

		if input == "" {
			fmt.Println("Instance URL is required.")
			continue
		}

		instanceURL = normalizeInstanceURL(input)
		break
	}

	fmt.Printf("  ✓ Using: %s\n", instanceURL)
	fmt.Println()
	return instanceURL, nil
}

func setupProfileName(cfg *config.Config) (string, error) {
	fmt.Println("Step 2: Profile Name")
	fmt.Println()
	fmt.Println("Choose a name for this configuration profile.")
	fmt.Println("Examples: prod, dev, sandbox, mycompany")
	fmt.Println()

	// Suggest a default based on instance URL
	defaultName := "default"
	if cfg.DefaultProfile != "" {
		defaultName = cfg.DefaultProfile
	}

	fmt.Printf("Profile name [%s]: ", defaultName)

	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)

	var profileName string
	if input == "" {
		profileName = defaultName
	} else {
		profileName = input
	}

	fmt.Printf("  ✓ Profile: %s\n", profileName)
	fmt.Println()
	return profileName, nil
}

func setupAuth(cmd *cobra.Command, app *appctx.App, instanceURL, profileName string) error {
	fmt.Println("Step 3: Save Location")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	authManager := app.Auth.(*auth.Manager)

	// Ask where to save config
	fmt.Println("Where should this configuration be saved?")
	fmt.Println("  1) Local (.servicenow/config.json) - project-specific [default]")
	fmt.Println("  2) Global (~/.config/servicenow/config.json) - system-wide")
	fmt.Println()

	var configScope string
	for {
		fmt.Print("Location [1]: ")
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		if input == "" || input == "1" {
			configScope = "local"
			break
		} else if input == "2" {
			configScope = "global"
			break
		} else {
			fmt.Println("Please enter 1 or 2.")
		}
	}
	fmt.Println()

	// Ask which auth method to use
	fmt.Println("Choose authentication method:")
	fmt.Println("  1) Basic Auth (username/password)")
	fmt.Println("  2) g_ck Token (glide cookie)")
	fmt.Println()

	var authMethod string
	for {
		fmt.Print("Method [1]: ")
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		if input == "" || input == "1" {
			authMethod = "basic"
			break
		} else if input == "2" {
			authMethod = "gck"
			break
		} else {
			fmt.Println("Please enter 1 or 2.")
		}
	}
	fmt.Println()

	cfg := app.Config.(*config.Config)

	if authMethod == "basic" {
		return setupBasicAuth(reader, cfg, authManager, instanceURL, profileName, configScope)
	}
	return setupGCKAuth(reader, cfg, authManager, instanceURL, profileName, configScope)
}

func setupBasicAuth(reader *bufio.Reader, cfg *config.Config, authManager *auth.Manager, instanceURL, profileName, configScope string) error {
	fmt.Println("Basic Authentication")
	fmt.Println()
	fmt.Println("Enter your ServiceNow username and password.")
	fmt.Println()

	// Username
	var username string
	for {
		fmt.Print("Username: ")
		input, _ := reader.ReadString('\n')
		username = strings.TrimSpace(input)
		if username != "" {
			break
		}
		fmt.Println("Username is required.")
	}

	// Password input
	var password string
	for {
		if term.IsTerminal(int(syscall.Stdin)) {
			fmt.Print("Password: ")
			bytePassword, err := term.ReadPassword(int(syscall.Stdin))
			if err != nil {
				// Fallback to regular input
				input, _ := reader.ReadString('\n')
				password = strings.TrimSpace(input)
			} else {
				password = string(bytePassword)
				fmt.Println() // Newline after hidden input
			}
		} else {
			// Non-terminal mode - prompt without "Password: " prefix since it was already printed
			input, _ := reader.ReadString('\n')
			password = strings.TrimSpace(input)
		}

		if password != "" {
			break
		}
		if term.IsTerminal(int(syscall.Stdin)) {
			fmt.Println("Password is required.")
		}
	}

	// Save profile with auth method
	profile := &config.Profile{
		InstanceURL: instanceURL,
		Username:    username,
		AuthMethod:  "basic",
	}

	cfg.Profiles[profileName] = profile
	if cfg.DefaultProfile == "" {
		cfg.DefaultProfile = profileName
	}

	// Save to appropriate location
	var saveErr error
	if configScope == "local" {
		saveErr = cfg.SaveLocal()
	} else {
		saveErr = cfg.Save()
	}
	if saveErr != nil {
		return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", saveErr))
	}

	// Store credentials
	creds := &auth.Credentials{
		Token:     password,
		Username:  username,
		CreatedAt: 0,
	}

	if err := authManager.StoreCredentials(creds); err != nil {
		return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
	}

	fmt.Println()
	fmt.Println("  ✓ Basic auth credentials saved.")
	fmt.Println()

	return nil
}

func setupGCKAuth(reader *bufio.Reader, cfg *config.Config, authManager *auth.Manager, instanceURL, profileName, configScope string) error {
	fmt.Println("g_ck Token Authentication")
	fmt.Println()
	fmt.Println("To authenticate, paste a curl command from your browser.")
	fmt.Println()
	fmt.Println("Steps:")
	fmt.Println("  1. Log into your ServiceNow instance in a browser")
	fmt.Println("  2. Open DevTools (F12) → Network tab")
	fmt.Println("  3. Filter for API requests (type 'api' in the filter)")
	fmt.Println("  4. Right-click any api/now/* request")
	fmt.Println("  5. Select: Copy → Copy as cURL")
	fmt.Println("  6. Paste the command below and press Ctrl+D")
	fmt.Println()
	fmt.Println("(Press Ctrl+D when done, or Ctrl+C to cancel)")
	fmt.Println()

	// Read all stdin until EOF
	var curlLines []string
	for {
		input, err := reader.ReadString('\n')
		if err != nil {
			// EOF reached
			break
		}
		curlLines = append(curlLines, input)
	}

	if len(curlLines) == 0 {
		return output.ErrUsage("no input received")
	}

	curlCmd := strings.TrimSpace(strings.Join(curlLines, " "))

	// Parse the curl command
	token, cookies, err := parseCurlForAuth(curlCmd)
	if err != nil {
		return output.ErrUsage(fmt.Sprintf("failed to parse curl: %v", err))
	}

	if token == "" {
		return output.ErrUsage("no X-UserToken found in curl command")
	}
	if cookies == "" {
		return output.ErrUsage("no Cookie header found in curl command")
	}

	// Save profile with auth method
	profile := &config.Profile{
		InstanceURL: instanceURL,
		AuthMethod:  "gck",
	}

	cfg.Profiles[profileName] = profile
	if cfg.DefaultProfile == "" {
		cfg.DefaultProfile = profileName
	}

	// Save to appropriate location
	var saveErr error
	if configScope == "local" {
		saveErr = cfg.SaveLocal()
	} else {
		saveErr = cfg.Save()
	}
	if saveErr != nil {
		return output.ErrAPI(500, fmt.Sprintf("failed to save config: %v", saveErr))
	}

	// Store credentials
	creds := &auth.Credentials{
		Token:     token,
		Cookies:   cookies,
		CreatedAt: 0,
	}

	if err := authManager.StoreCredentials(creds); err != nil {
		return output.ErrAuth(fmt.Sprintf("failed to store credentials: %v", err))
	}

	fmt.Println()
	fmt.Println("  ✓ Authentication saved.")
	fmt.Println()

	return nil
}

// parseCurlForAuth extracts auth info from a curl command
func parseCurlForAuth(curlCmd string) (token, cookies string, err error) {
	// Extract X-UserToken header (case insensitive)
	tokenPatterns := []string{
		`(?i)x-usertoken:\s*([^\s'"]+)`,
		`-H\s+['"]X-UserToken:\s*([^'"]+)['"]`,
	}
	for _, pattern := range tokenPatterns {
		re := regexp.MustCompile(pattern)
		matches := re.FindStringSubmatch(curlCmd)
		if len(matches) >= 2 {
			token = strings.TrimSpace(matches[1])
			break
		}
	}

	// Extract Cookie header (from -H or -b flags)
	// Chrome's "Copy as cURL" uses: -b 'cookie1=val1; cookie2=val2'
	// The -b pattern must handle quoted strings containing spaces and semicolons
	cookiePatterns := []string{
		`(?i)-H\s+['"]cookie:\s*([^'"]+)['"]`,
		`-b\s+'([^']+)'`,
		`-b\s+"([^"]+)"`,
		`-b\s+(\S+)`,
	}
	for _, pattern := range cookiePatterns {
		re := regexp.MustCompile(pattern)
		matches := re.FindStringSubmatch(curlCmd)
		if len(matches) >= 2 {
			cookies = strings.TrimSpace(matches[1])
			break
		}
	}

	if token == "" && cookies == "" {
		// Try to extract Basic Auth
		authMatch := regexp.MustCompile(`-H\s+['"]Authorization:\s*Basic\s+([^'"]+)['"]`).FindStringSubmatch(curlCmd)
		if len(authMatch) >= 2 {
			decoded, decodeErr := base64.StdEncoding.DecodeString(authMatch[1])
			if decodeErr == nil {
				parts := strings.SplitN(string(decoded), ":", 2)
				if len(parts) == 2 {
					return parts[1], "", nil // password is the token
				}
			}
		}
	}

	return token, cookies, nil
}
