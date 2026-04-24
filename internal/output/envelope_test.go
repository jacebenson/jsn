// Package output provides response formatting and error handling.
package output

import (
	"testing"
)

func TestStripAnsi(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "no ANSI codes",
			input:    "hello world",
			expected: "hello world",
		},
		{
			name:     "OSC 8 hyperlink",
			input:    "\x1b]8;;https://example.com\x07INC0010001\x1b]8;;\x07",
			expected: "INC0010001",
		},
		{
			name:     "simple color codes",
			input:    "\x1b[31mred\x1b[0m",
			expected: "red",
		},
		{
			name:     "bold formatting",
			input:    "\x1b[1mbold\x1b[0m text",
			expected: "bold text",
		},
		{
			name:     "mixed content",
			input:    "\x1b[32mgreen\x1b[0m and \x1b[34mblue\x1b[0m",
			expected: "green and blue",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripAnsi(tt.input)
			if got != tt.expected {
				t.Errorf("stripAnsi() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestVisibleWidth(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected int
	}{
		{
			name:     "plain text",
			input:    "hello",
			expected: 5,
		},
		{
			name:     "hyperlink",
			input:    "\x1b]8;;https://example.com\x07INC0010001\x1b]8;;\x07",
			expected: 10,
		},
		{
			name:     "empty string",
			input:    "",
			expected: 0,
		},
		{
			name:     "unicode characters",
			input:    "こんにちは",
			expected: 15, // 5 chars, 3 bytes each = 15
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := visibleWidth(tt.input)
			if got != tt.expected {
				t.Errorf("visibleWidth() = %d, want %d", got, tt.expected)
			}
		})
	}
}

func TestHyperlink(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		url      string
		expected string
	}{
		{
			name:     "with URL",
			text:     "INC0010001",
			url:      "https://instance.service-now.com/incident.do?sys_id=abc123",
			expected: "\x1b]8;;https://instance.service-now.com/incident.do?sys_id=abc123\x07INC0010001\x1b]8;;\x07",
		},
		{
			name:     "empty URL returns text unchanged",
			text:     "INC0010001",
			url:      "",
			expected: "INC0010001",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Hyperlink(tt.text, tt.url)
			if got != tt.expected {
				t.Errorf("Hyperlink() = %q, want %q", got, tt.expected)
			}
		})
	}
}
