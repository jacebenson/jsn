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
	"net/url"
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
	client := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
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

// AggregateCount retrieves the count of records matching the query using the aggregate API.
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
