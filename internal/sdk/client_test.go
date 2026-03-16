package sdk

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGetDisplayValue(t *testing.T) {
	tests := []struct {
		name     string
		record   map[string]interface{}
		key      string
		expected string
	}{
		{
			name:     "string value",
			record:   map[string]interface{}{"operation": "write"},
			key:      "operation",
			expected: "write",
		},
		{
			name: "object with display_value",
			record: map[string]interface{}{
				"operation": map[string]interface{}{
					"display_value": "write",
					"link":          "https://example.com/write",
				},
			},
			key:      "operation",
			expected: "write",
		},
		{
			name:     "missing key",
			record:   map[string]interface{}{},
			key:      "operation",
			expected: "",
		},
		{
			name:     "nil value",
			record:   map[string]interface{}{"operation": nil},
			key:      "operation",
			expected: "",
		},
		{
			name: "object without display_value",
			record: map[string]interface{}{
				"operation": map[string]interface{}{
					"link": "https://example.com/write",
				},
			},
			key:      "operation",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := getDisplayValue(tt.record, tt.key)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestACLFromRecordWithDisplayValue(t *testing.T) {
	// Test that aclFromRecord correctly handles display_value objects
	record := map[string]interface{}{
		"sys_id":     "abc123",
		"name":       "incident.*",
		"active":     "true",
		"operation":  map[string]interface{}{"display_value": "write"},
		"type":       map[string]interface{}{"display_value": "record"},
		"field_name": "",
	}

	acl := aclFromRecord(record)

	assert.Equal(t, "abc123", acl.SysID)
	assert.Equal(t, "incident.*", acl.Name)
	assert.Equal(t, "write", acl.Operation)
	assert.Equal(t, "record", acl.Type)
	assert.True(t, acl.Active)
}
