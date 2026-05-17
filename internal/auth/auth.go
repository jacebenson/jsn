// Package auth provides OAuth authentication for ServiceNow.
package auth

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/jacebenson/jsn/internal/sdk"
	"golang.org/x/term"
)

// DefaultOAuthClientID is the default ServiceNow OAuth client ID
const DefaultOAuthClientID = "543e5655f77746a28228c6009a599dfb"

// ServiceNowSDKRedirectURI is the redirect URI used by ServiceNow's SDK OAuth flow
const ServiceNowSDKRedirectURI = "/sdk-oauth.do"

// Manager handles OAuth authentication.
type Manager struct {
	cfg        ConfigProvider
	store      *Store
	httpClient *http.Client
}

// ConfigProvider provides configuration.
type ConfigProvider interface {
	GetEffectiveInstance() string
}

// PKCEParams holds PKCE parameters
type PKCEParams struct {
	CodeVerifier  string
	CodeChallenge string
	State         string
}

// NewManager creates a new auth manager.
func NewManager(cfg ConfigProvider) *Manager {
	return &Manager{
		cfg:   cfg,
		store: NewStore(),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// IsAuthenticated checks if we have valid OAuth credentials for the current instance.
// This will also attempt to refresh the token if it's about to expire.
func (m *Manager) IsAuthenticated() bool {
	// Check environment variable first
	if os.Getenv("SERVICENOW_OAUTH_TOKEN") != "" {
		return true
	}

	instance := m.cfg.GetEffectiveInstance()
	if instance == "" {
		return false
	}

	// Try to get credentials - this includes refresh logic
	_, err := m.GetCredentials()
	return err == nil
}

// IsAuthenticatedFor checks if we have valid credentials for a specific instance.
func (m *Manager) IsAuthenticatedFor(instance string) bool {
	if instance == "" {
		return false
	}

	creds, err := m.store.Load(instance)
	if err != nil {
		return false
	}

	// Check if token is expired
	if creds.ExpiresAt > 0 && time.Now().Unix() >= creds.ExpiresAt {
		return false
	}

	return creds.AccessToken != ""
}

// GetCredentials retrieves OAuth credentials for the current instance.
func (m *Manager) GetCredentials() (*sdk.Credentials, error) {
	// Check environment variable first
	if token := os.Getenv("SERVICENOW_OAUTH_TOKEN"); token != "" {
		return &sdk.Credentials{
			AuthMethod:  "oauth",
			AccessToken: token,
		}, nil
	}

	instance := m.cfg.GetEffectiveInstance()
	if instance == "" {
		return nil, fmt.Errorf("no instance configured")
	}

	return m.GetCredentialsFor(instance)
}

// GetCredentialsFor retrieves credentials for a specific instance.
func (m *Manager) GetCredentialsFor(instance string) (*sdk.Credentials, error) {
	creds, err := m.store.Load(instance)
	if err != nil {
		return nil, fmt.Errorf("not authenticated for %s: %w", instance, err)
	}

	// Check if token needs refresh
	if creds.ExpiresAt > 0 && time.Now().Unix() >= creds.ExpiresAt-300 {
		// Token expires in less than 5 minutes, try to refresh
		if creds.RefreshToken != "" {
			refreshed, err := m.refreshToken(instance, creds)
			if err == nil {
				return refreshed, nil
			}
			// Refresh failed, return error
			return nil, fmt.Errorf("token expired, please login again")
		}
	}

	return creds, nil
}

// generatePKCE generates PKCE parameters for OAuth flow
func generatePKCE() (*PKCEParams, error) {
	// Generate code verifier (random 32 bytes, base64url encoded = 43 chars)
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return nil, fmt.Errorf("generating code verifier: %w", err)
	}
	codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

	// Generate code challenge (SHA256 of verifier, base64url encoded)
	hash := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(hash[:])

	// Generate state parameter (random 16 bytes, base64url encoded)
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return nil, fmt.Errorf("generating state: %w", err)
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)

	return &PKCEParams{
		CodeVerifier:  codeVerifier,
		CodeChallenge: codeChallenge,
		State:         state,
	}, nil
}

// getOAuthClientID returns the OAuth client ID to use
func getOAuthClientID() string {
	if id := os.Getenv("SERVICENOW_OAUTH_CLIENT_ID"); id != "" {
		return id
	}
	return DefaultOAuthClientID
}

// Login initiates OAuth login flow for an instance using ServiceNow SDK style.
func (m *Manager) Login(instanceURL string) error {
	instanceURL = normalizeURL(instanceURL)
	clientID := getOAuthClientID()

	// Generate PKCE parameters
	pkce, err := generatePKCE()
	if err != nil {
		return err
	}

	// Build authorization URL using SDK-style redirect
	authURL := buildAuthURL(instanceURL, clientID, pkce)

	// Print instructions and open browser
	fmt.Println()
	fmt.Println("Opening browser for OAuth authentication...")
	fmt.Println("If the browser doesn't open automatically, visit:")
	fmt.Println(authURL)
	fmt.Println()

	// Try to open browser (ignore errors)
	_ = openBrowser(authURL)

	// Prompt user for the authorization code
	fmt.Println("After authenticating in the browser, copy the authorization code shown on the page.")
	fmt.Println("(input is hidden for security — just paste and press Enter)")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	var authCode string
	for {
		fmt.Print("Authorization code (hidden on paste for security): ")
		if term.IsTerminal(int(syscall.Stdin)) {
			byteCode, err := term.ReadPassword(int(syscall.Stdin))
			if err != nil {
				input, _ := reader.ReadString('\n')
				authCode = strings.TrimSpace(input)
			} else {
				authCode = string(byteCode)
				fmt.Println()
			}
		} else {
			input, _ := reader.ReadString('\n')
			authCode = strings.TrimSpace(input)
		}
		if authCode != "" {
			break
		}
		fmt.Println("Authorization code is required.")
	}

	// Exchange code for tokens
	fmt.Println("\nExchanging authorization code for tokens...")
	creds, err := m.exchangeCode(instanceURL, clientID, authCode, pkce)
	if err != nil {
		return err
	}

	// Store credentials
	return m.store.Save(instanceURL, creds)
}

// buildAuthURL builds the ServiceNow OAuth authorization URL
func buildAuthURL(instanceURL, clientID string, pkce *PKCEParams) string {
	u, _ := url.Parse(instanceURL)
	u.Path = "/oauth_auth.do"

	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", ServiceNowSDKRedirectURI)
	q.Set("state", pkce.State)
	q.Set("code_challenge", pkce.CodeChallenge)
	q.Set("code_challenge_method", "S256")
	q.Set("scope", "openid")
	u.RawQuery = q.Encode()

	return u.String()
}

// exchangeCode exchanges the authorization code for access/refresh tokens
func (m *Manager) exchangeCode(instanceURL, clientID, code string, pkce *PKCEParams) (*sdk.Credentials, error) {
	tokenURL := strings.TrimSuffix(instanceURL, "/") + "/oauth_token.do"

	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", clientID)
	data.Set("code", code)
	data.Set("redirect_uri", ServiceNowSDKRedirectURI)
	data.Set("code_verifier", pkce.CodeVerifier)

	req, err := http.NewRequest("POST", tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("creating token request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchanging code for token: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		TokenType    string `json:"token_type"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("parsing token response: %w", err)
	}

	expiresAt := time.Now().Unix() + int64(tokenResp.ExpiresIn)
	return &sdk.Credentials{
		AuthMethod:   "oauth",
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		ExpiresAt:    expiresAt,
		CreatedAt:    time.Now().Unix(),
	}, nil
}

// RefreshToken explicitly refreshes the OAuth token for an instance.
// This can be called manually to renew a token before it expires.
func (m *Manager) RefreshToken(instance string) (*sdk.Credentials, error) {
	instance = normalizeURL(instance)

	// Load existing credentials
	creds, err := m.store.Load(instance)
	if err != nil {
		return nil, fmt.Errorf("no credentials found for %s: %w", instance, err)
	}

	// Check if we have a refresh token
	if creds.RefreshToken == "" {
		return nil, fmt.Errorf("no refresh token available, please login again")
	}

	// Try to refresh
	return m.refreshToken(instance, creds)
}

// refreshToken refreshes an expired OAuth token
func (m *Manager) refreshToken(instance string, creds *sdk.Credentials) (*sdk.Credentials, error) {
	tokenURL := strings.TrimSuffix(instance, "/") + "/oauth_token.do"
	clientID := getOAuthClientID()

	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("client_id", clientID)
	data.Set("refresh_token", creds.RefreshToken)

	resp, err := m.httpClient.PostForm(tokenURL, data)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("token refresh failed: %s", string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, err
	}

	newCreds := &sdk.Credentials{
		AuthMethod:   "oauth",
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		CreatedAt:    time.Now().Unix(),
	}

	if tokenResp.ExpiresIn > 0 {
		newCreds.ExpiresAt = time.Now().Unix() + int64(tokenResp.ExpiresIn)
	}

	// Save refreshed credentials
	if err := m.store.Save(instance, newCreds); err != nil {
		return nil, err
	}

	return newCreds, nil
}

// Logout removes stored credentials for an instance.
func (m *Manager) Logout(instance string) error {
	if instance == "" {
		return fmt.Errorf("no instance specified")
	}
	return m.store.Delete(instance)
}

// normalizeURL ensures consistent URL format.
func normalizeURL(url string) string {
	url = strings.TrimSuffix(url, "/")
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		url = "https://" + url
	}
	return url
}
