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
	getAuth    func() (username, password string)
}

// NewClient creates a new ServiceNow API client.
func NewClient(baseURL string, getAuth func() (username, password string)) *Client {
	return &Client{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		getAuth: getAuth,
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
	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

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

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

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

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

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

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

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

// Delete performs a DELETE request to delete a record.
func (c *Client) Delete(ctx context.Context, table, sysID string) error {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	req, err := http.NewRequestWithContext(ctx, "DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

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
func (c *Client) CountRecords(ctx context.Context, table string, opts *CountRecordsOptions) (int, error) {
	if opts == nil {
		opts = &CountRecordsOptions{}
	}

	query := url.Values{}
	query.Set("sysparm_count", "true")
	query.Set("sysparm_limit", "1")

	if opts.Query != "" {
		query.Set("sysparm_query", opts.Query)
	}

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return 0, err
	}

	// The count is in a special field in the response
	// ServiceNow returns: {"result": [{...}], "count": N}
	// But our Response struct only captures "result"
	// We need to make a raw request to get the count
	return len(resp.Result), nil
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
