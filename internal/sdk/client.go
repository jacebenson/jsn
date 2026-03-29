package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a ServiceNow API client.
type Client struct {
	baseURL    string
	httpClient *http.Client
	// getAuth returns (token, cookiesOrUsername, isGCK)
	// For g_ck: token = X-UserToken, cookiesOrUsername = Cookie header value
	// For basic: token = password, cookiesOrUsername = username
	getAuth func() (token, cookiesOrUsername string, isGCK bool)
}

// NewClient creates a new ServiceNow API client.
func NewClient(baseURL string, getAuth func() (token, cookiesOrUsername string, isGCK bool)) *Client {
	return &Client{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		getAuth: getAuth,
	}
}

// setAuth applies authentication headers to a request.
func (c *Client) setAuth(req *http.Request) {
	token, cookiesOrUsername, isGCK := c.getAuth()
	if isGCK {
		req.Header.Set("X-UserToken", token)
		if cookiesOrUsername != "" {
			req.Header.Set("Cookie", cookiesOrUsername)
		}
	} else {
		req.SetBasicAuth(cookiesOrUsername, token)
	}
}

// Get performs a GET request to the Table API.
func (c *Client) Get(ctx context.Context, table string, query url.Values) (*Response, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)
	if query != nil {
		endpoint = endpoint + "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	// Set headers
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	// Set auth
	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result Response
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Post performs a POST request to create a record.
func (c *Client) Post(ctx context.Context, table string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Put performs a PUT request to update a record.
func (c *Client) Put(ctx context.Context, table, sysID string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Patch performs a PATCH request to update a record.
func (c *Client) Patch(ctx context.Context, table, sysID string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PATCH", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// RawRequest performs an arbitrary HTTP request to any endpoint on the instance.
// The path should start with "/" (e.g., "/api/now/table/incident" or "/api/x_custom/myapi").
// For GET/DELETE, body can be nil. For POST/PATCH/PUT, body is sent as JSON.
// Returns the raw response body as parsed JSON (interface{}) along with the HTTP status code.
func (c *Client) RawRequest(ctx context.Context, method, path string, body map[string]interface{}, headers map[string]string) (interface{}, int, error) {
	endpoint := c.baseURL + path

	var reqBody io.Reader
	if body != nil && (method == "POST" || method == "PATCH" || method == "PUT") {
		bodyData, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshaling request body: %w", err)
		}
		reqBody = strings.NewReader(string(bodyData))
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	if body != nil && (method == "POST" || method == "PATCH" || method == "PUT") {
		req.Header.Set("Content-Type", "application/json")
	}

	// Apply custom headers
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("reading response body: %w", err)
	}

	// Try to parse as JSON; if it fails, return as string
	var result interface{}
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			// Not JSON, return as string
			result = string(respBody)
		}
	}

	return result, resp.StatusCode, nil
}

// GetBaseURL returns the instance base URL.
func (c *Client) GetBaseURL() string {
	return c.baseURL
}

// Delete performs a DELETE request to delete a record.
func (c *Client) Delete(ctx context.Context, table, sysID string) error {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	req, err := http.NewRequestWithContext(ctx, "DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	c.setAuth(req)

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

// CountRecordsOptions holds options for counting records.
type CountRecordsOptions struct {
	Query string
}

// CountRecords returns the count of records in a table matching the query.
// Uses the Aggregate API (/api/now/stats) for accurate counts without limit issues.
func (c *Client) CountRecords(ctx context.Context, table string, opts *CountRecordsOptions) (int, error) {
	if opts == nil {
		opts = &CountRecordsOptions{}
	}

	query := url.Values{}
	query.Set("sysparm_count", "true")

	if opts.Query != "" {
		query.Set("sysparm_query", opts.Query)
	}

	// Use Aggregate API for accurate counts
	endpoint := fmt.Sprintf("%s/api/now/stats/%s", c.baseURL, table)
	if query != nil {
		endpoint = endpoint + "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return 0, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Aggregate API returns: {"result": {"stats": {"count": "42"}}}
	var result struct {
		Result struct {
			Stats struct {
				Count string `json:"count"`
			} `json:"stats"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, fmt.Errorf("parsing response: %w", err)
	}

	count, err := strconv.Atoi(result.Result.Stats.Count)
	if err != nil {
		return 0, fmt.Errorf("parsing count: %w", err)
	}

	return count, nil
}

// getString extracts a string value from a record map, handling display_value objects.
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		// Check if it's a display_value object (from sysparm_display_value=all)
		if obj, ok := v.(map[string]interface{}); ok {
			// Try display_value first, then value
			if displayVal, ok := obj["display_value"]; ok && displayVal != nil {
				if s, ok := displayVal.(string); ok {
					return s
				}
			}
			if val, ok := obj["value"]; ok && val != nil {
				if s, ok := val.(string); ok {
					return s
				}
			}
			return ""
		}
		// Direct string value
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// getInt extracts an int value from a record map, handling display_value objects.
func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key]; ok && v != nil {
		// Check if it's a display_value object (from sysparm_display_value=all)
		if obj, ok := v.(map[string]interface{}); ok {
			// Try display_value first, then value
			if displayVal, ok := obj["display_value"]; ok && displayVal != nil {
				switch dv := displayVal.(type) {
				case int:
					return dv
				case float64:
					return int(dv)
				case string:
					if i, err := strconv.Atoi(dv); err == nil {
						return i
					}
				}
			}
			// Fallback to value field
			if val, ok := obj["value"]; ok && val != nil {
				switch fv := val.(type) {
				case int:
					return fv
				case float64:
					return int(fv)
				case string:
					if i, err := strconv.Atoi(fv); err == nil {
						return i
					}
				}
			}
			return 0
		}
		// Direct value
		switch val := v.(type) {
		case int:
			return val
		case float64:
			return int(val)
		case string:
			if i, err := strconv.Atoi(val); err == nil {
				return i
			}
		}
	}
	return 0
}

// getBool extracts a bool value from a record map, handling display_value objects.
func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key]; ok && v != nil {
		// Check if it's a display_value object (from sysparm_display_value=all)
		if obj, ok := v.(map[string]interface{}); ok {
			// Try display_value first, then value
			if displayVal, ok := obj["display_value"]; ok && displayVal != nil {
				switch dv := displayVal.(type) {
				case bool:
					return dv
				case string:
					return dv == "true" || dv == "1"
				}
			}
			if val, ok := obj["value"]; ok && val != nil {
				switch fv := val.(type) {
				case bool:
					return fv
				case string:
					return fv == "true" || fv == "1"
				}
			}
			return false
		}
		// Direct value
		switch val := v.(type) {
		case bool:
			return val
		case string:
			return val == "true" || val == "1"
		}
	}
	return false
}
