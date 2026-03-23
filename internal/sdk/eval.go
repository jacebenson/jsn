package sdk

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// EvalResult holds the result of a background script execution.
type EvalResult struct {
	Output     string `json:"output"`                // Script output (gs.print/gs.info lines)
	Error      string `json:"error,omitempty"`       // Compilation or runtime error
	Duration   string `json:"duration,omitempty"`    // Execution time reported by server
	Scope      string `json:"scope,omitempty"`       // Scope the script ran in
	HistoryURL string `json:"history_url,omitempty"` // Link to execution history record
}

// EvalOptions configures background script execution.
type EvalOptions struct {
	Scope             string // Application scope (default: "global")
	RecordForRollback bool   // Create rollback record (default: true)
	QuotaManaged      bool   // Cancel after 4 hours (default: true)
}

// DefaultEvalOptions returns the default eval options.
func DefaultEvalOptions() EvalOptions {
	return EvalOptions{
		Scope:             "global",
		RecordForRollback: true,
		QuotaManaged:      true,
	}
}

// Eval executes a background script on the ServiceNow instance.
//
// This uses the sys.scripts.do page (same as "Scripts - Background" in the UI).
// The flow is:
//  1. Establish a session (basic auth: REST call to get cookies; g_ck: already has cookies)
//  2. GET /sys.scripts.do to retrieve the CSRF token (sysparm_ck)
//  3. POST /sys.scripts.do with the script as form data
//  4. Parse the HTML response to extract script output
func (c *Client) Eval(ctx context.Context, script string, opts EvalOptions) (*EvalResult, error) {
	// Create a client with cookie jar for session management
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("creating cookie jar: %w", err)
	}

	sessionClient := &http.Client{
		Timeout: 120 * time.Second, // scripts can take a while
		Jar:     jar,
	}

	_, cookies, isGCK := c.getAuth()

	// Step 1: Establish session
	if isGCK && cookies != "" {
		// g_ck auth: seed the cookie jar with existing cookies
		if err := c.seedCookieJar(jar); err != nil {
			return nil, fmt.Errorf("seeding cookies: %w", err)
		}
	} else {
		// Basic auth (or g_ck without cookies): make a REST call to establish a session
		if err := c.establishSession(ctx, sessionClient); err != nil {
			return nil, fmt.Errorf("establishing session: %w", err)
		}
	}

	// Step 2: GET /sys.scripts.do to retrieve CSRF token
	csrfToken, err := c.getCSRFToken(ctx, sessionClient)
	if err != nil {
		return nil, fmt.Errorf("getting CSRF token: %w", err)
	}

	// Step 3: POST the script
	htmlResponse, err := c.postScript(ctx, sessionClient, script, csrfToken, opts)
	if err != nil {
		return nil, fmt.Errorf("executing script: %w", err)
	}

	// Step 4: Parse the response
	return parseEvalResponse(htmlResponse, opts.Scope), nil
}

// seedCookieJar parses the stored cookie string and seeds the jar.
func (c *Client) seedCookieJar(jar *cookiejar.Jar) error {
	_, cookies, _ := c.getAuth()
	if cookies == "" {
		return fmt.Errorf("no cookies available for g_ck auth")
	}

	u, err := url.Parse(c.baseURL)
	if err != nil {
		return err
	}

	var httpCookies []*http.Cookie
	for _, part := range strings.Split(cookies, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eqIdx := strings.IndexByte(part, '=')
		if eqIdx < 0 {
			continue
		}
		httpCookies = append(httpCookies, &http.Cookie{
			Name:  strings.TrimSpace(part[:eqIdx]),
			Value: strings.TrimSpace(part[eqIdx+1:]),
		})
	}

	jar.SetCookies(u, httpCookies)
	return nil
}

// establishSession makes a lightweight REST API call with basic auth to establish a session.
func (c *Client) establishSession(ctx context.Context, sessionClient *http.Client) error {
	endpoint := c.baseURL + "/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id"

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Accept", "application/json")

	// Always use basic auth for session establishment, regardless of configured auth method.
	// For g_ck without cookies, the token/username fields hold basic auth credentials anyway.
	token, cookiesOrUsername, isGCK := c.getAuth()
	if isGCK {
		// g_ck mode but no cookies — the credentials are likely basic auth stored under gck config.
		// token = password-like value, cookiesOrUsername = username
		req.SetBasicAuth(cookiesOrUsername, token)
	} else {
		req.SetBasicAuth(cookiesOrUsername, token)
	}

	resp, err := sessionClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != 200 {
		return fmt.Errorf("session auth failed with status %d", resp.StatusCode)
	}

	// Check if we're logged in
	if resp.Header.Get("X-Is-Logged-In") == "false" {
		return fmt.Errorf("authentication failed: not logged in")
	}

	return nil
}

// getCSRFToken fetches the sys.scripts.do page and extracts the sysparm_ck token.
func (c *Client) getCSRFToken(ctx context.Context, sessionClient *http.Client) (string, error) {
	endpoint := c.baseURL + "/sys.scripts.do"

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return "", err
	}

	resp, err := sessionClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("sys.scripts.do returned status %d", resp.StatusCode)
	}

	html := string(body)
	if len(html) == 0 {
		return "", fmt.Errorf("empty response from sys.scripts.do (session may not be authenticated)")
	}

	// Parse: <input name="sysparm_ck" type="hidden" value="...">
	re := regexp.MustCompile(`name="sysparm_ck"[^>]*value="([^"]*)"`)
	matches := re.FindStringSubmatch(html)
	if len(matches) < 2 {
		return "", fmt.Errorf("could not find CSRF token in sys.scripts.do response")
	}

	return matches[1], nil
}

// postScript submits the script to sys.scripts.do as a form POST.
func (c *Client) postScript(ctx context.Context, sessionClient *http.Client, script, csrfToken string, opts EvalOptions) (string, error) {
	endpoint := c.baseURL + "/sys.scripts.do"

	scope := opts.Scope
	if scope == "" {
		scope = "global"
	}

	form := url.Values{}
	form.Set("script", script)
	form.Set("sysparm_ck", csrfToken)
	form.Set("runscript", "Run script")
	form.Set("sys_scope", scope)
	if opts.RecordForRollback {
		form.Set("record_for_rollback", "on")
	}
	if opts.QuotaManaged {
		form.Set("quota_managed_transaction", "on")
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := sessionClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("script execution returned status %d", resp.StatusCode)
	}

	return string(body), nil
}

// parseEvalResponse extracts script output from the HTML response.
//
// Successful response format:
//
//	[0:00:00.061] <HTML><BODY>Script completed in scope global: script<HR/>
//	...execution history link...<HR/>
//	<PRE>*** Script: output here<BR/></PRE><HR/></BODY></HTML>
//
// Error response format:
//
//	<PRE>Script compilation error: ...error details...<BR/></PRE>
func parseEvalResponse(html string, scope string) *EvalResult {
	result := &EvalResult{
		Scope: scope,
	}

	// Extract duration: [0:00:00.061]
	if durationRe := regexp.MustCompile(`\[(\d+:\d+:\d+\.\d+)\]`); true {
		if matches := durationRe.FindStringSubmatch(html); len(matches) >= 2 {
			result.Duration = matches[1]
		}
	}

	// Extract execution history URL
	historyRe := regexp.MustCompile(`HREF='([^']*sys_script_execution_history[^']*)'`)
	if matches := historyRe.FindStringSubmatch(html); len(matches) >= 2 {
		result.HistoryURL = matches[1]
	}

	// Extract content from <PRE>...</PRE>
	preRe := regexp.MustCompile(`(?s)<PRE>(.*?)</PRE>`)
	preMatches := preRe.FindStringSubmatch(html)
	if len(preMatches) < 2 {
		// No PRE block — return raw HTML stripped of tags as fallback
		result.Output = stripHTML(html)
		return result
	}

	preContent := preMatches[1]

	// Check for compilation/runtime errors
	if strings.Contains(preContent, "Script compilation error") || strings.Contains(preContent, "Script runtime error") {
		errText := stripHTML(preContent)
		errText = strings.TrimSpace(errText)
		result.Error = errText
		return result
	}

	// Extract script output lines: "*** Script: <output><BR/>"
	outputRe := regexp.MustCompile(`\*\*\* Script: (.*?)(?:<BR/>|$)`)
	outputMatches := outputRe.FindAllStringSubmatch(preContent, -1)

	var lines []string
	for _, m := range outputMatches {
		if len(m) >= 2 {
			lines = append(lines, m[1])
		}
	}

	if len(lines) > 0 {
		result.Output = strings.Join(lines, "\n")
	} else {
		// No *** Script: lines — might be other output
		cleaned := stripHTML(preContent)
		cleaned = strings.TrimSpace(cleaned)
		if cleaned != "" {
			result.Output = cleaned
		}
	}

	return result
}

// stripHTML removes HTML tags from a string.
func stripHTML(s string) string {
	re := regexp.MustCompile(`<[^>]*>`)
	cleaned := re.ReplaceAllString(s, "")
	// Collapse whitespace but preserve newlines
	cleaned = strings.ReplaceAll(cleaned, "\r\n", "\n")
	return cleaned
}
