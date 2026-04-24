// Package commands provides CLI commands.
package commands

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
)

// mockTransport is a mock HTTP transport for testing
type mockTransport struct {
	capturedPath   string
	capturedQuery  string
	capturedBody   []byte
	responseBody   string
	responseStatus int
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.capturedPath = req.URL.Path
	m.capturedQuery = req.URL.RawQuery

	if req.Body != nil {
		body, _ := io.ReadAll(req.Body)
		m.capturedBody = body
		req.Body.Close()
	}

	if m.responseStatus == 0 {
		m.responseStatus = 200
	}

	return &http.Response{
		StatusCode: m.responseStatus,
		Body:       io.NopCloser(bytes.NewReader([]byte(m.responseBody))),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

// mockAuthProvider is a mock auth provider for testing
type mockAuthProvider struct {
	creds *sdk.Credentials
}

func (m *mockAuthProvider) GetCredentials() (*sdk.Credentials, error) {
	if m.creds == nil {
		return &sdk.Credentials{
			AuthMethod:  "token",
			AccessToken: "test-token",
		}, nil
	}
	return m.creds, nil
}

// setupTestApp creates a test app with default settings
func setupTestApp(t *testing.T) (*appctx.App, *bytes.Buffer) {
	t.Helper()

	buf := &bytes.Buffer{}
	cfg := &config.Config{
		InstanceURL: "https://test-instance.service-now.com",
		Profiles: map[string]*config.Profile{
			"test-instance": {
				InstanceURL: "https://test-instance.service-now.com",
				Username:    "test.user",
			},
		},
	}

	authProvider := &mockAuthProvider{}
	client := sdk.NewClient("https://test-instance.service-now.com", authProvider)
	out := output.New(output.Options{
		Format: output.FormatJSON,
		Writer: buf,
	})

	app := &appctx.App{
		Config: cfg,
		Auth:   auth.NewManager(cfg),
		SDK:    client,
		Output: out,
	}
	return app, buf
}

// setupTestAppWithTransport creates a test app with a mock HTTP transport
func setupTestAppWithTransport(t *testing.T, transport http.RoundTripper) (*appctx.App, *bytes.Buffer) {
	t.Helper()

	buf := &bytes.Buffer{}
	cfg := &config.Config{
		InstanceURL: "https://test-instance.service-now.com",
		Profiles: map[string]*config.Profile{
			"test-instance": {
				InstanceURL: "https://test-instance.service-now.com",
				Username:    "test.user",
			},
		},
	}

	// Create HTTP client with mock transport
	httpClient := &http.Client{Transport: transport}

	// Create auth provider
	authProvider := &mockAuthProvider{}

	// Create SDK client with custom HTTP client
	client := sdk.NewClient("https://test-instance.service-now.com", authProvider, sdk.WithHTTPClient(httpClient))

	out := output.New(output.Options{
		Format: output.FormatJSON,
		Writer: buf,
	})

	app := &appctx.App{
		Config: cfg,
		Auth:   auth.NewManager(cfg),
		SDK:    client,
		Output: out,
	}
	return app, buf
}

// executeCommand executes a cobra command with the given app and args
func executeCommand(cmd *cobra.Command, app *appctx.App, args ...string) error {
	// Set args
	cmd.SetArgs(args)

	// Capture output
	buf := &bytes.Buffer{}
	cmd.SetOut(buf)
	cmd.SetErr(buf)

	// Create context with app
	ctx := appctx.WithApp(context.Background(), app)
	cmd.SetContext(ctx)

	// Execute
	return cmd.Execute()
}
