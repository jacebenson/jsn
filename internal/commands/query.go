package commands

import (
	"fmt"
	"net/url"
	"strings"
)

// ServiceNow query operators
// Reference: https://sn.jace.pro/docs/gliderecord/
var servicenowOperators = []string{
	// Basic comparison
	"=", "!=", "<", ">", "<=", ">=",
	// Logical operators
	"^", "^OR", "^NQ",
	// String operators
	"LIKE", "NOT LIKE", "STARTSWITH", "ENDSWITH", "CONTAINS", "DOES NOT CONTAIN",
	// Set operators
	"IN", "NOT IN", "ISEMPTY", "ISNOTEMPTY", "ANYTHING", "EMPTYSTRING",
	// Field comparison
	"SAMEAS", "NSAMEAS", "GT_FIELD", "LT_FIELD", "GT_OR_EQUALS_FIELD", "LT_OR_EQUALS_FIELD",
	// Change operators
	"CHANGES", "CHANGESFROM", "CHANGESTO", "VALCHANGES",
	// Date/Time operators
	"BETWEEN", "DATEPART", "RELATIVE", "RELATIVEEE", "RELATIVEGE", "RELATIVEGT", "RELATIVELE", "RELATIVELT",
	"MORETHAN", "LESSTHAN", "ONToday", "NOTONToday",
	// Dynamic
	"DYNAMIC",
	// URL-encoded versions
	"%3D", "%21%3D", "%3C", "%3E", "%5E", "%5EOR", "%5ENQ",
}

// isEncodedQuery checks if a string contains ServiceNow query operators
func isEncodedQuery(query string) bool {
	if query == "" {
		return false
	}
	for _, op := range servicenowOperators {
		if strings.Contains(query, op) {
			return true
		}
	}
	return false
}

// commonDisplayColumns is the fallback chain for display columns
var commonDisplayColumns = []string{"name", "short_description", "title", "u_name", "u_title"}

// getDisplayColumnForTable returns the appropriate display column for a table.
// It checks common patterns and returns the first matching column.
// For metadata tables (sys_*), typically returns "name".
func getDisplayColumnForTable(table string) string {
	// Special cases for known tables
	switch table {
	case "incident", "problem", "change_request", "sc_request", "sc_req_item", "sc_task":
		return "short_description"
	case "sys_user":
		return "name"
	case "sys_user_group":
		return "name"
	case "sys_hub_flow", "sys_script", "sys_script_include", "sysauto_script":
		return "name"
	default:
		// For unknown tables, try common display columns
		// In practice, "name" works for most metadata tables
		return "name"
	}
}

// wrapSimpleQuery converts a simple search term to a field LIKE query.
// If the query already contains operators, it's returned unchanged.
// The table parameter is used to determine the display column.
func wrapSimpleQuery(query string, table ...string) string {
	if query == "" || isEncodedQuery(query) {
		return query
	}
	// Determine display column based on table
	field := "name"
	if len(table) > 0 && table[0] != "" {
		field = getDisplayColumnForTable(table[0])
	}
	// Simple term - wrap in fieldLIKE query
	return fmt.Sprintf("%sLIKE%s", field, query)
}

// buildFilterLink creates a ServiceNow list view URL for encoded queries.
// Returns empty string if the query doesn't contain ServiceNow operators.
// This is used to create clickable links in output when a filter is applied.
func buildFilterLink(instanceURL, table, query string) string {
	if !isEncodedQuery(query) {
		// Query doesn't have valid operators - can't build a filter link
		return ""
	}

	// Standard encoded query with operators
	encodedQuery := url.QueryEscape(query)
	return fmt.Sprintf("%s/%s_list.do?sysparm_query=%s", instanceURL, table, encodedQuery)
}

// buildSysparmQuery builds a ServiceNow sysparm_query string from parts.
// Each part is joined with ^ (AND operator).
// Simple query terms are automatically wrapped with wrapSimpleQuery.
func buildSysparmQuery(parts ...string) string {
	var wrappedParts []string
	for _, part := range parts {
		if part != "" {
			wrappedParts = append(wrappedParts, wrapSimpleQuery(part))
		}
	}
	return strings.Join(wrappedParts, "^")
}

// hasFilter returns true if the query contains ServiceNow operators
// and can be used to build a filter link.
func hasFilter(query string) bool {
	return isEncodedQuery(query)
}
