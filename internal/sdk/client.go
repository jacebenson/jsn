// Package sdk provides a ServiceNow API client.
//
// ARCHITECTURE GUIDELINES:
//
// This SDK should remain lean - only core HTTP operations and shared utilities.
// DO NOT add domain-specific helper methods here (e.g., ListFormViews, GetSPPage).
//
// Correct pattern:
//   - Commands define local types and call app.SDK.List() directly
//   - See internal/commands/dev/forms.go for the reference implementation
//
// Anti-pattern (don't do this):
//   - Adding ListFormViews(), ListSPPages() to the Client
//   - Creating SDK types like FormSection, SPPage that commands import
//
// Why? This keeps the SDK simple and puts query logic where it belongs - in the
// commands that need it. Complex multi-table queries happen inline in command
// files using goroutines, not in SDK wrappers.
//
// If you need to add a method here, ask: "Will more than 3 commands use this?"
// If no, put it in the command file instead.
package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

// Credentials holds authentication credentials.
type Credentials struct {
	AuthMethod   string `json:"auth_method"`
	Username     string `json:"username,omitempty"`
	Password     string `json:"password,omitempty"`
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	CreatedAt    int64  `json:"created_at,omitempty"`
}

// AuthProvider provides authentication for API requests.
type AuthProvider interface {
	GetCredentials() (*Credentials, error)
}

// Client is a ServiceNow API client.
type Client struct {
	baseURL    string
	httpClient *http.Client
	auth       AuthProvider
}

// ClientOption is a functional option for configuring the Client.
type ClientOption func(*Client)

// WithHTTPClient sets a custom HTTP client.
func WithHTTPClient(httpClient *http.Client) ClientOption {
	return func(c *Client) {
		c.httpClient = httpClient
	}
}

// NewClient creates a new ServiceNow API client.
func NewClient(baseURL string, auth AuthProvider, opts ...ClientOption) *Client {
	jar, _ := cookiejar.New(nil)
	client := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Jar:     jar,
		},
		auth: auth,
	}

	for _, opt := range opts {
		opt(client)
	}

	return client
}

// List retrieves records from a table with optional query parameters.
func (c *Client) List(ctx context.Context, table string, params url.Values) ([]map[string]any, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)
	if params != nil {
		endpoint = endpoint + "?" + params.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	if err := c.setAuth(req); err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Result []map[string]any `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return result.Result, nil
}

// Get retrieves a single record by sys_id.
func (c *Client) Get(ctx context.Context, table, sysID string) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	if err := c.setAuth(req); err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return result.Result, nil
}

// Create creates a new record in a table.
func (c *Client) Create(ctx context.Context, table string, data map[string]any) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(bodyData))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	if err := c.setAuth(req); err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return result.Result, nil
}

// Update updates an existing record by sys_id.
func (c *Client) Update(ctx context.Context, table, sysID string, data map[string]any) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, bytes.NewReader(bodyData))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	if err := c.setAuth(req); err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return result.Result, nil
}

// Delete deletes a record by sys_id.
func (c *Client) Delete(ctx context.Context, table, sysID string) error {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	req, err := http.NewRequestWithContext(ctx, "DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	if err := c.setAuth(req); err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// setAuth sets the Authorization header.
func (c *Client) setAuth(req *http.Request) error {
	if c.auth == nil {
		return fmt.Errorf("no authentication configured")
	}

	creds, err := c.auth.GetCredentials()
	if err != nil {
		return err
	}

	switch creds.AuthMethod {
	case "basic":
		req.SetBasicAuth(creds.Username, creds.Password)
	case "token", "oauth":
		req.Header.Set("Authorization", "Bearer "+creds.AccessToken)
	default:
		// Try basic auth if we have username/password
		if creds.Username != "" && creds.Password != "" {
			req.SetBasicAuth(creds.Username, creds.Password)
		} else if creds.AccessToken != "" {
			req.Header.Set("Authorization", "Bearer "+creds.AccessToken)
		} else {
			return fmt.Errorf("no valid credentials")
		}
	}

	return nil
}

// User represents a ServiceNow user.

// Helper functions used across SDK

// getString extracts a string field from a record.
func getString(m map[string]any, key string) string {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]any:
			// Handle display_value objects from sysparm_display_value=all
			if value, ok := val["value"].(string); ok {
				return value
			}
			if display, ok := val["display_value"].(string); ok {
				return display
			}
		}
	}
	return ""
}

// ExecuteScript runs a background script on the ServiceNow instance via sys.scripts.do.
// Returns the script output text.
//
// For OAuth auth, this follows the session-establishment pattern used by the official
// ServiceNow VS Code extension:
//  1. Make a REST API call with the Bearer token to get session cookies
//  2. GET /sys.scripts.do with those cookies to extract the CSRF token
//  3. POST /sys.scripts.do with the script, CSRF token, and cookies
func (c *Client) ExecuteScript(ctx context.Context, script string) (string, error) {
	// Create a dedicated HTTP client with its own cookie jar for this session.
	jar, _ := cookiejar.New(nil)
	scriptClient := &http.Client{
		Timeout: 30 * time.Second,
		Jar:     jar,
	}

	// Step 1: Warm up session by hitting the REST API to get session cookies.
	// The Bearer/Basic auth on the REST API causes ServiceNow to set session
	// cookies that can be reused for UI pages like sys.scripts.do.
	if err := c.warmSessionWithClient(ctx, scriptClient); err != nil {
		// Non-fatal: we'll try without session cookies.
		// This may work for basic auth; OAuth may get a clearer error later.
		_ = err // intentionally ignored — proceed without session
	}

	// Step 2: GET /sys.scripts.do to extract the CSRF token (sysparm_ck).
	csrfToken, err := c.getScriptsPageCSRF(ctx, scriptClient)
	if err != nil {
		return "", fmt.Errorf("fetching scripts page: %w\n\n"+
			"Hints:\n"+
			"  - OAuth tokens may not establish a UI session on this instance.\n"+
			"  - Try using the browser: %s/sys.scripts.do\n"+
			"  - You may need basic auth credentials for script execution.", err, c.baseURL)
	}

	// Step 3: POST the script with form data including CSRF token.
	endpoint := fmt.Sprintf("%s/sys.scripts.do", c.baseURL)

	formData := url.Values{}
	formData.Set("script", script)
	formData.Set("sysparm_ck", csrfToken)
	formData.Set("runscript", "Run script")
	formData.Set("sys_scope", "global")
	formData.Set("record_for_rollback", "on")
	formData.Set("quota_managed_transaction", "on")

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(formData.Encode()))
	if err != nil {
		return "", fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := scriptClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("executing script: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("script execution failed (status %d): %s",
			resp.StatusCode, string(body[:min(len(body), 500)]))
	}

	output := extractScriptOutput(string(body))
	if output == "" || strings.TrimSpace(output) == "not authorized" {
		return "", fmt.Errorf("script execution returned no output — session may not be established\n\n"+
			"Hints:\n"+
			"  - OAuth tokens may not work with sys.scripts.do.\n"+
			"  - Run scripts in the browser: %s/sys.scripts.do",
			c.baseURL)
	}

	return output, nil
}

// warmSessionWithClient makes a REST API call to establish session cookies.
func (c *Client) warmSessionWithClient(ctx context.Context, client *http.Client) error {
	endpoint := fmt.Sprintf("%s/api/now/table/sys_user?sysparm_limit=1", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if err := c.setAuth(req); err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// getScriptsPageCSRF fetches /sys.scripts.do and extracts the sysparm_ck token.
func (c *Client) getScriptsPageCSRF(ctx context.Context, client *http.Client) (string, error) {
	endpoint := fmt.Sprintf("%s/sys.scripts.do", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return "", err
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, string(body[:min(len(body), 200)]))
	}

	// Extract sysparm_ck from the HTML form:
	// <input name="sysparm_ck" type="hidden" value="TOKEN_VALUE">
	bodyStr := string(body)
	marker := `<input name="sysparm_ck" type="hidden" value="`
	idx := strings.Index(bodyStr, marker)
	if idx == -1 {
		// Alternative: try without the type attribute
		marker = `name="sysparm_ck" value="`
		idx = strings.Index(bodyStr, marker)
		if idx == -1 {
			// Couldn't find the CSRF token. The page might be "not authorized".
			if strings.Contains(bodyStr, "not authorized") || strings.Contains(bodyStr, "login.do") {
				return "", fmt.Errorf("not authorized to access scripts page — session not established")
			}
			return "", fmt.Errorf("could not find CSRF token on scripts page (response: %s)",
				bodyStr[:min(len(bodyStr), 200)])
		}
		// Find the value after `value="`
		start := idx + len(marker)
		end := strings.Index(bodyStr[start:], `"`)
		if end == -1 {
			return "", fmt.Errorf("malformed CSRF token HTML")
		}
		return bodyStr[start : start+end], nil
	}

	start := idx + len(marker)
	end := strings.Index(bodyStr[start:], `">`)
	if end == -1 {
		end2 := strings.Index(bodyStr[start:], `"`)
		if end2 == -1 {
			return "", fmt.Errorf("malformed CSRF token HTML")
		}
		return bodyStr[start : start+end2], nil
	}
	return bodyStr[start : start+end], nil
}

// extractScriptOutput extracts the script output from a sys.scripts.do HTML response.
func extractScriptOutput(html string) string {
	// Try to find content between <PRE> tags (case-insensitive)
	// The output typically appears after "*** Script:" markers within the <pre> block
	htmlUpper := strings.ToUpper(html)

	preStart := strings.Index(htmlUpper, "<PRE")
	if preStart == -1 {
		// No <pre> tags - try to find the output in other containers
		// Look for content between <body> and </body> as fallback
		bodyStart := strings.Index(htmlUpper, "<BODY")
		if bodyStart == -1 {
			return strings.TrimSpace(html)
		}
		bodyEnd := strings.Index(htmlUpper[bodyStart:], "</BODY>")
		if bodyEnd == -1 {
			return strings.TrimSpace(html[bodyStart:])
		}
		return strings.TrimSpace(html[bodyStart : bodyStart+bodyEnd])
	}

	// Find the end of the <pre> opening tag
	preTagEnd := strings.Index(htmlUpper[preStart:], ">")
	if preTagEnd == -1 {
		return strings.TrimSpace(html[preStart:])
	}
	contentStart := preStart + preTagEnd + 1

	preEnd := strings.Index(htmlUpper[contentStart:], "</PRE>")
	if preEnd == -1 {
		return strings.TrimSpace(html[contentStart:])
	}

	rawOutput := html[contentStart : contentStart+preEnd]

	// Strip any remaining HTML tags
	output := stripHTMLTags(rawOutput)

	// Trim whitespace and common prefixes
	output = strings.TrimSpace(output)

	return output
}

// stripHTMLTags removes HTML tags from a string.
// <BR> and <BR/> are converted to newlines.
func stripHTMLTags(s string) string {
	// First convert BR tags to newlines for readability.
	replacer := strings.NewReplacer(
		"<BR/>", "\n",
		"<BR>", "\n",
		"<br/>", "\n",
		"<br>", "\n",
	)
	out := replacer.Replace(s)

	// Then strip remaining HTML tags.
	var result strings.Builder
	inTag := false
	for _, r := range out {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			result.WriteRune(r)
		}
	}

	// Clean up: trim each line and collapse blank lines.
	lines := strings.Split(result.String(), "\n")
	cleaned := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return strings.Join(cleaned, "\n")
}
func (c *Client) AggregateCount(ctx context.Context, table string, query string) (int, error) {
	params := url.Values{}
	params.Set("sysparm_count", "true")
	if query != "" {
		params.Set("sysparm_query", query)
	}

	endpoint := fmt.Sprintf("%s/api/now/stats/%s", c.baseURL, table)
	if len(params) > 0 {
		endpoint = endpoint + "?" + params.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return 0, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	if err := c.setAuth(req); err != nil {
		return 0, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse the aggregate response
	var result struct {
		Result struct {
			Stats any `json:"stats"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, fmt.Errorf("parsing response: %w", err)
	}

	// Handle different stats formats
	var statsMap map[string]any

	switch v := result.Result.Stats.(type) {
	case map[string]any:
		statsMap = v
	case string:
		// Stats is a JSON string, unmarshal it
		if err := json.Unmarshal([]byte(v), &statsMap); err != nil {
			return 0, fmt.Errorf("parsing stats string: %w", err)
		}
	default:
		return 0, fmt.Errorf("unexpected stats type: %T", v)
	}

	// Extract count from the stats structure
	if count, ok := statsMap["count"]; ok {
		switch v := count.(type) {
		case float64:
			return int(v), nil
		case int:
			return v, nil
		case string:
			var countInt int
			if _, err := fmt.Sscanf(v, "%d", &countInt); err == nil {
				return countInt, nil
			}
		}
	}

	// Check nested format: stats["*"]["count"]
	for _, value := range statsMap {
		switch nested := value.(type) {
		case map[string]any:
			if count, ok := nested["count"]; ok {
				switch v := count.(type) {
				case float64:
					return int(v), nil
				case int:
					return v, nil
				case string:
					var countInt int
					if _, err := fmt.Sscanf(v, "%d", &countInt); err == nil {
						return countInt, nil
					}
				}
			}
		}
	}

	return 0, nil
}
