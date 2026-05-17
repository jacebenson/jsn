// Package dev provides development-related commands for ServiceNow.
package dev

import (
	"context"
	"fmt"

	"github.com/jacebenson/jsn/internal/appctx"
)

// Common status icons used across dev commands
const (
	IconActive   = "🟢"
	IconInactive = "⚪"
	IconModified = "🟡"
	IconError    = "🔴"
)

// Common field extraction helpers

// getStringField extracts a string field from a record.
// Handles both plain string values and display value objects from sysparm_display_value=all.
func getStringField(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects
			if value, ok := v["value"].(string); ok {
				return value
			}
			if display, ok := v["display_value"].(string); ok {
				return display
			}
		}
	}
	return ""
}

// getDisplayField extracts the display value from a reference field.
// Used when sysparm_display_value=all is set and you want the human-readable value.
func getDisplayField(record map[string]any, field string) string {
	if val, ok := record[field]; ok && val != nil {
		switch v := val.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects from sysparm_display_value=all
			if display, ok := v["display_value"].(string); ok && display != "" {
				return display
			}
			if value, ok := v["value"].(string); ok {
				return value
			}
		}
	}
	return ""
}

// getSysID extracts the sys_id value from a record, handling both plain strings
// and ServiceNow display value objects {display_value, value}.
func getSysID(record map[string]any) string {
	if sysID, ok := record["sys_id"]; ok && sysID != nil {
		switch v := sysID.(type) {
		case string:
			return v
		case map[string]any:
			// Handle display value objects from sysparm_display_value=all
			if value, ok := v["value"].(string); ok && value != "" {
				return value
			}
			if display, ok := v["display_value"].(string); ok {
				return display
			}
		}
	}
	return ""
}

// wrapRecordWithContext wraps a record with _context containing instance_url and table
// for link generation in styled output.
func wrapRecordWithContext(record map[string]any, table, instanceURL string) map[string]any {
	wrapped := make(map[string]any, len(record)+1)
	for k, v := range record {
		wrapped[k] = v
	}
	wrapped["_context"] = map[string]any{
		"instance_url": instanceURL,
		"table":        table,
	}
	return wrapped
}

// isHexString checks if a string contains only hexadecimal characters (0-9, a-f, A-F).
// Used to identify sys_id values which are 32-character hex strings.
func isHexString(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// truncateString truncates a string to max length, adding "..." if truncated.
// If maxLen is 3 or less, returns the string truncated to maxLen without adding "...".
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}

// ScopeValidator validates record scope against the current user's scope.
// This helps prevent accidental modifications to records in different application scopes.
type ScopeValidator struct {
	app          *appctx.App
	currentScope string // cached current scope
}

// NewScopeValidator creates a new scope validator for the given app.
func NewScopeValidator(app *appctx.App) *ScopeValidator {
	return &ScopeValidator{
		app: app,
	}
}

// CheckScope validates that the record's scope matches or is compatible with the current scope.
// Returns an error if the scopes don't match (helping prevent cross-scope modifications).
// This is a validation helper - actual scope enforcement is done by ServiceNow ACLs.
func (sv *ScopeValidator) CheckScope(ctx context.Context, recordScope string) error {
	currentScope, err := sv.GetCurrentScope(ctx)
	if err != nil {
		// If we can't determine current scope, allow the operation
		// ServiceNow ACLs will enforce the actual restrictions
		return nil
	}

	// Global scope can access all records
	if currentScope == "global" {
		return nil
	}

	// Same scope is always allowed
	if currentScope == recordScope {
		return nil
	}

	// Different scopes - this is a warning scenario
	// The actual enforcement is done by ServiceNow, but we can warn the user
	if recordScope == "global" {
		// Writing to global from a scoped app - ServiceNow may block this
		return fmt.Errorf("record is in global scope but current scope is %s; cross-scope operations may be restricted", currentScope)
	}

	return fmt.Errorf("record scope (%s) differs from current scope (%s); cross-scope operations may be restricted", recordScope, currentScope)
}

// GetCurrentScope retrieves the current application scope for the user.
// Caches the result to avoid repeated API calls.
func (sv *ScopeValidator) GetCurrentScope(ctx context.Context) (string, error) {
	// Return cached value if available
	if sv.currentScope != "" {
		return sv.currentScope, nil
	}

	// Get current user to find their scope preference
	currentUser, err := sv.app.SDK.GetCurrentUser(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get current user: %w", err)
	}

	// Get the current application scope for the user
	app, err := sv.app.SDK.GetCurrentApplication(ctx, currentUser.SysID)
	if err != nil {
		return "", fmt.Errorf("failed to get current application: %w", err)
	}

	sv.currentScope = app.Scope

	return sv.currentScope, nil
}

// ResetCache clears the cached current scope, forcing a fresh lookup on next use.
func (sv *ScopeValidator) ResetCache() {
	sv.currentScope = ""
}
