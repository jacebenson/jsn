// Package sdk provides a client for the ServiceNow Table API.
package sdk

import (
	"strconv"
)

// Response represents a ServiceNow Table API response (array result).
type Response struct {
	Result []map[string]interface{} `json:"result"`
}

// SingleResponse represents a ServiceNow Table API response for single record operations.
type SingleResponse struct {
	Result map[string]interface{} `json:"result"`
}

// InstanceInfo holds ServiceNow instance information.
type InstanceInfo struct {
	Version         string            `json:"version"`
	Build           string            `json:"build"`
	BuildDate       string            `json:"build_date"`
	Patch           string            `json:"patch"`
	InstanceName    string            `json:"instance_name"`
	TimeZone        string            `json:"time_zone"`
	UserName        string            `json:"user_name"`
	UserSysID       string            `json:"user_sys_id"`
	GlideProperties map[string]string `json:"glide_properties"`
}

// Helper functions

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case bool:
			return val
		case string:
			return val == "true" || val == "1"
		}
	}
	return false
}

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key]; ok && v != nil {
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

// getDisplayValue extracts a display value from a field that may be either
// a string or an object with a display_value property.
func getDisplayValue(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]interface{}:
			if dv, ok := val["display_value"].(string); ok {
				return dv
			}
		}
	}
	return ""
}
