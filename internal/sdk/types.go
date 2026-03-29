// Package sdk provides a client for the ServiceNow Table API.
package sdk

// Response represents a ServiceNow Table API response (array result).
type Response struct {
	Result []map[string]interface{} `json:"result"`
	Count  int                      `json:"count"`
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
