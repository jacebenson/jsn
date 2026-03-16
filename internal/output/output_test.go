package output

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWriter_OK_JSON(t *testing.T) {
	var buf bytes.Buffer
	w := New(Options{
		Format: FormatJSON,
		Writer: &buf,
	})

	data := map[string]string{"key": "value"}
	err := w.OK(data, WithSummary("Test summary"))
	if err != nil {
		t.Fatalf("OK() error = %v", err)
	}

	// Parse the JSON output
	var resp Response
	if err := json.Unmarshal(buf.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse JSON: %v", err)
	}

	if !resp.OK {
		t.Error("Expected OK to be true")
	}

	if resp.Summary != "Test summary" {
		t.Errorf("Summary = %v, want 'Test summary'", resp.Summary)
	}
}

func TestWriter_OK_Quiet(t *testing.T) {
	var buf bytes.Buffer
	w := New(Options{
		Format: FormatQuiet,
		Writer: &buf,
	})

	data := map[string]string{"key": "value"}
	err := w.OK(data)
	if err != nil {
		t.Fatalf("OK() error = %v", err)
	}

	// In quiet mode, should only have the data, no envelope
	var result map[string]string
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		t.Fatalf("Failed to parse JSON: %v", err)
	}

	if result["key"] != "value" {
		t.Errorf("key = %v, want 'value'", result["key"])
	}
}

func TestWriter_Err(t *testing.T) {
	var buf bytes.Buffer
	w := New(Options{
		Format: FormatJSON,
		Writer: &buf,
	})

	testErr := ErrAuth("invalid credentials")
	err := w.Err("auth_failed", testErr, "Check your token")
	if err != nil {
		t.Fatalf("Err() error = %v", err)
	}

	var resp ErrorResponse
	if err := json.Unmarshal(buf.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse JSON: %v", err)
	}

	if resp.OK {
		t.Error("Expected OK to be false")
	}

	if resp.Code != "auth_failed" {
		t.Errorf("Code = %v, want 'auth_failed'", resp.Code)
	}

	if resp.Hint != "Check your token" {
		t.Errorf("Hint = %v, want 'Check your token'", resp.Hint)
	}
}

func TestFormatFromString(t *testing.T) {
	tests := []struct {
		input    string
		expected Format
	}{
		{"json", FormatJSON},
		{"json", FormatJSON},
		{"md", FormatMarkdown},
		{"markdown", FormatMarkdown},
		{"styled", FormatStyled},
		{"quiet", FormatQuiet},
		{"", FormatAuto},
		{"unknown", FormatAuto},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := FormatFromString(tt.input)
			if result != tt.expected {
				t.Errorf("FormatFromString(%q) = %v, want %v", tt.input, result, tt.expected)
			}
		})
	}
}

func TestErrorFunctions(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		contains string
	}{
		{"ErrUsage", ErrUsage("bad args"), "usage: bad args"},
		{"ErrAuth", ErrAuth("no token"), "auth: no token"},
		{"ErrNotFound", ErrNotFound("missing"), "not found: missing"},
		{"ErrAPI", ErrAPI(500, "server error"), "api error 500: server error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(tt.err.Error(), tt.contains) {
				t.Errorf("error = %v, should contain %q", tt.err.Error(), tt.contains)
			}
		})
	}
}
