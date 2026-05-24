// Package dev provides developer utility commands.
package dev

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// formatRecordForDisplay formats a record for display, extracting display values
func formatRecordForDisplay(record map[string]any, columns []string) map[string]string {
	result := make(map[string]string)

	// Always include sys_id for hyperlinks
	result["sys_id"] = getSysID(record)

	for _, col := range columns {
		if val, ok := record[col]; ok && val != nil {
			switch v := val.(type) {
			case string:
				result[col] = v
			case map[string]any:
				// Handle display value objects from sysparm_display_value=true
				if display, ok := v["display_value"].(string); ok {
					result[col] = display
				} else if value, ok := v["value"].(string); ok {
					result[col] = value
				} else {
					result[col] = fmt.Sprintf("%v", v)
				}
			default:
				result[col] = fmt.Sprintf("%v", v)
			}
		} else {
			result[col] = ""
		}
	}
	return result
}

// scopeDefaultColumns are the default columns to show for scopes
var scopeDefaultColumns = []string{"name", "scope", "short_description", "active"}

// NewScopesCmd creates the scopes command.
func NewScopesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scopes",
		Short: "List ServiceNow application scopes",
		Args:  cobra.NoArgs,
Long: `List and search ServiceNow application scopes from the sys_scope table.

Examples:
  # List all scopes (interactive picker in TTY mode)
  jsn dev scopes list

  # Search for scopes by name
  jsn dev scopes list --query "nameLIKEglobal"

  # Show a specific scope
  jsn dev scopes show "Global"

  # List with custom columns
  jsn dev scopes list --columns "name,scope,sys_id"

  # Create a new scope (also creates sys_app record)
  jsn dev scopes create --name "My App"`,

		RunE: func(cmd *cobra.Command, args []string) error {
			// No args - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newScopesListCmd(),
		newScopesShowCmd(),
		newScopesCreateCmd(),
	)

	return cmd
}

func newScopesListCmd() *cobra.Command {
	var (
		query   string
		columns string
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List application scopes",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return listScopes(ctx, app, query, cols)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string")
	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")

	return cmd
}

func newScopesShowCmd() *cobra.Command {
	var (
		columns string
	)

	cmd := &cobra.Command{
		Use:   "show [scope-name-or-sys-id]",
		Short: "Show a scope by name or sys_id",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			var cols []string
			if columns != "" {
				cols = strings.Split(columns, ",")
			} else {
				cols = scopeDefaultColumns
			}

			return getScope(ctx, app, identifier, cols)
		},
	}

	cmd.Flags().StringVarP(&columns, "columns", "c", "", "Comma-separated columns to display")

	return cmd
}

func newScopesCreateCmd() *cobra.Command {
	var (
		name            string
		scope           string
		shortDescription string
		version         string
		active          bool
		data            string
	)

	const maxScopeLength = 17

	// sanitizeScopeName converts an app name to a valid scope name part:
	// lowercase, non-alphanumeric replaced with underscores
	sanitizeScopeName := func(appName string) string {
		sanitized := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				return r
			}
			if r >= 'A' && r <= 'Z' {
				return r + 32 // lowercase
			}
			return '_'
		}, appName)

		// Collapse multiple underscores
		for strings.Contains(sanitized, "__") {
			sanitized = strings.ReplaceAll(sanitized, "__", "_")
		}
		// Trim leading/trailing underscores
		sanitized = strings.Trim(sanitized, "_")

		return sanitized
	}

	// generateScope builds the scope value from the app name using vendor conventions.
	// Returns the scope, the stem (scope without suffix), and whether it was truncated.
	generateScope := func(vendorCode, appName string) (string, string, bool) {
		sanitized := sanitizeScopeName(appName)
		if sanitized == "" {
			return "", "", false
		}

		// Determine prefix. If no vendor code, this is a non-vendor app.
		prefix := ""
		if vendorCode != "" {
			prefix = fmt.Sprintf("x_%s_", vendorCode)
		}
		full := prefix + sanitized

		if len(full) <= maxScopeLength {
			return full, full, false
		}

		// Truncation needed: reserve 2 chars for "_N" suffix
		available := maxScopeLength - len(prefix)
		namePart := strings.TrimRight(sanitized[:available-2], "_")
		scopeVal := prefix + namePart + "_0"
		stem := prefix + namePart
		return scopeVal, stem, true
	}

	// resolveScopeCollision checks if the generated scope already exists and
	// finds the next available suffix (_0, _1, _2, ...).
	resolveScopeCollision := func(ctx context.Context, app *appctx.App, scopeVal, stem string) (string, error) {
		// Check if the scope already exists
		checkParams := url.Values{}
		checkParams.Set("sysparm_query", fmt.Sprintf("scope=%s", scopeVal))
		checkParams.Set("sysparm_limit", "1")
		checkParams.Set("sysparm_fields", "sys_id,scope")
		existing, err := app.SDK.List(ctx, "sys_scope", checkParams)
		if err != nil {
			return scopeVal, err
		}
		if len(existing) == 0 {
			return scopeVal, nil // No collision
		}

		// Collision — find all scopes matching the stem
		listParams := url.Values{}
		listParams.Set("sysparm_query", fmt.Sprintf("scopeSTARTSWITH%s", stem))
		listParams.Set("sysparm_fields", "scope")
		listParams.Set("sysparm_limit", "100")
		allMatching, err := app.SDK.List(ctx, "sys_scope", listParams)
		if err != nil {
			return "", fmt.Errorf("failed to check existing scopes: %w", err)
		}

		maxSuffix := -1
		stemLen := len(stem)
		for _, rec := range allMatching {
			s, _ := rec["scope"].(string)
			if s == stem {
				// The stem itself is a scope — counts as suffix -1, so next is 0
				if maxSuffix < -1 {
					maxSuffix = -1
				}
				continue
			}
			// Extract trailing _N suffix
			if strings.HasPrefix(s, stem) && len(s) > stemLen {
				suffix := s[stemLen:]
				var n int
				if _, err := fmt.Sscanf(suffix, "_%d", &n); err == nil && n > maxSuffix {
					maxSuffix = n
				}
			}
		}

		nextSuffix := maxSuffix + 1
		newScope := fmt.Sprintf("%s_%d", stem, nextSuffix)

		if len(newScope) > maxScopeLength {
			return "", fmt.Errorf("cannot generate unique scope — all suffixes exhausted for stem %q", stem)
		}

		return newScope, nil
	}

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new application scope",
		Long: `Create a new application scope in ServiceNow.

The scope value is auto-generated from the app name when --scope is not provided.
For vendor/custom scopes, the format is: x_<vendor>_<app> (max 17 characters).
The vendor code comes from the glide.appcreator.company.code system property.

If the generated scope exceeds 17 characters, it is truncated and suffixed with _0.

A corresponding sys_app record is also created automatically.

Examples:
  jsn dev scopes create --name "My App"
  jsn dev scopes create --name "My App" --short-description "My custom application"
  jsn dev scopes create --name "My App" --scope "x_8821_my_app"
  jsn dev scopes create --name "My App" --scope "x_8821_my_app" --active false
  jsn dev scopes create --name "My App" --version "2.0.0"
  jsn dev scopes create --data '{"name":"My App","scope":"x_8821_my_app"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			recordData := make(map[string]any)

			// Parse --data if provided
			if data != "" {
				if err := json.Unmarshal([]byte(data), &recordData); err != nil {
					return fmt.Errorf("invalid JSON in --data: %w", err)
				}
			}

			// Apply flag values (flags override --data)
			if name != "" {
				recordData["name"] = name
			}
			if shortDescription != "" {
				recordData["short_description"] = shortDescription
			}
			if cmd.Flags().Changed("active") {
				recordData["active"] = active
			}

			// Validate required fields
			if recordData["name"] == nil || recordData["name"] == "" {
				return fmt.Errorf("name is required (use --name or --data)")
			}

			// Auto-generate scope if not explicitly provided
			if scope != "" {
				recordData["scope"] = scope
			} else if _, exists := recordData["scope"]; !exists || recordData["scope"] == "" {
				// Fetch vendor code from system property
				vendorCode := ""
				propParams := url.Values{}
				propParams.Set("sysparm_query", "name=glide.appcreator.company.code")
				propParams.Set("sysparm_fields", "value")
				propParams.Set("sysparm_limit", "1")
				props, err := app.SDK.List(ctx, "sys_properties", propParams)
				if err == nil && len(props) > 0 {
					if v, ok := props[0]["value"].(string); ok && v != "" {
						vendorCode = v
					}
				}

				appName := fmt.Sprintf("%v", recordData["name"])
				generated, stem, truncated := generateScope(vendorCode, appName)
				if generated == "" {
					return fmt.Errorf("could not generate scope from name %q", appName)
				}

				// Check for collisions with existing scopes
				resolved, err := resolveScopeCollision(ctx, app, generated, stem)
				if err != nil {
					return fmt.Errorf("failed to check scope availability: %w", err)
				}
				recordData["scope"] = resolved
				if truncated || resolved != generated {
					fmt.Fprintf(os.Stderr, "# Scope truncated to 17 chars: %s\n", resolved)
				}
				fmt.Fprintf(os.Stderr, "# Using vendor code: %s\n", vendorCode)
			}

			// Validate the scope value
			scopeVal := fmt.Sprintf("%v", recordData["scope"])
			if scopeVal == "" {
				return fmt.Errorf("scope value is required (use --scope, --data, or provide a --name to auto-generate)")
			}
			if len(scopeVal) > maxScopeLength {
				return fmt.Errorf("scope value %q is %d characters (max %d). Use a shorter name or specify --scope manually", scopeVal, len(scopeVal), maxScopeLength)
			}

			// Check for collisions when --scope was explicitly provided
			if scope != "" || (data != "") {
				checkParams := url.Values{}
				checkParams.Set("sysparm_query", fmt.Sprintf("scope=%s", scopeVal))
				checkParams.Set("sysparm_limit", "1")
				checkParams.Set("sysparm_fields", "sys_id")
				existing, err := app.SDK.List(ctx, "sys_scope", checkParams)
				if err == nil && len(existing) > 0 {
					return fmt.Errorf("scope %q already exists. Use a different --scope value or omit --scope to auto-generate", scopeVal)
				}
			}

			// Create the sys_scope record
			scopeRecord, err := app.SDK.Create(ctx, "sys_scope", recordData)
			if err != nil {
				return fmt.Errorf("failed to create scope: %w", err)
			}

			createdName := getStringValue(scopeRecord, "name")
			createdScope := getStringValue(scopeRecord, "scope")

			// Also create the required sys_app record
			appVersion := version
			if appVersion == "" {
				appVersion = "1.0.0"
			}

			appRecord := map[string]any{
				"name":                     createdName,
				"scope":                    createdScope,
				"source":                   createdScope,
				"active":                   true,
				"can_edit_in_studio":       true,
				"enforce_license":          "none",
				"hide_on_ui":               false,
				"ide_created":              "SNS",
				"installed_as_dependency":  false,
				"js_level":                 "es_latest",
				"licensable":               true,
				"license_category":         "none",
				"license_model":            "none",
				"private":                  false,
				"restrict_table_access":    false,
				"runtime_access_tracking":  "permissive",
				"scoped_administration":    false,
				"trackable":                true,
				"uninstall_blocked":        false,
				"version":                  appVersion,
			}

			createdApp, err := app.SDK.Create(ctx, "sys_app", appRecord)
			if err != nil {
				// Scope was created but app record failed — warn but don't fail
				fmt.Fprintf(os.Stderr, "# Warning: sys_scope created but sys_app creation failed: %v\n", err)
			}

			result := map[string]any{
				"sys_scope": scopeRecord,
			}
			if createdApp != nil {
				result["sys_app"] = createdApp
			}

			return app.OK(result,
				output.WithSummary(fmt.Sprintf("Created scope '%s' (%s)", createdName, createdScope)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "show",
						Cmd:         fmt.Sprintf("jsn dev scopes show %s", createdName),
						Description: "View the new scope",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev scopes list",
						Description: "Back to all scopes",
					},
				),
			)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Scope name (required — auto-generates scope value)")
	cmd.Flags().StringVarP(&scope, "scope", "s", "", "Scope value, e.g. x_8821_my_app (optional — auto-generated from --name if omitted)")
	cmd.Flags().StringVarP(&shortDescription, "short-description", "d", "", "Short description of the scope")
	cmd.Flags().StringVar(&version, "version", "1.0.0", "Application version (default: 1.0.0)")
	cmd.Flags().BoolVar(&active, "active", true, "Set active status (default: true)")
	cmd.Flags().StringVar(&data, "data", "", "Raw JSON data for additional fields")

	return cmd
}

func listScopes(ctx context.Context, app *appctx.App, query string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" {
		return listScopesInteractive(ctx, app, columns)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", "20")
	params.Set("sysparm_display_value", "all")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Default ordering: most recently updated first
	// Append ORDERBYDESC to any existing query
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_updated_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_updated_on")
	}

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to list scopes: %w", err)
	}

	var displayRecords []map[string]string
	for _, record := range records {
		displayRecords = append(displayRecords, formatRecordForDisplay(record, columns))
	}

	return app.OK(map[string]any{
		"table":   "sys_scope",
		"count":   len(records),
		"columns": columns,
		"records": displayRecords,
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d scope(s)", len(records))),
	)
}

// listScopesInteractive shows an interactive picker for scopes
// When a scope is selected, it sets it as the current application scope
func listScopesInteractive(ctx context.Context, app *appctx.App, columns []string) error {
	fetcher := tui.NewListFetcher("sys_scope").
		WithColumns("name", "scope", "short_description", "active", "sys_id").
		WithOrderBy("ORDERBYDESCsys_updated_on").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringValue(record, "name")
			scopeVal := getStringValue(record, "scope")
			desc := getStringValue(record, "short_description")
			active := getBoolValue(record, "active")
			sysID := getStringValue(record, "sys_id")

			// Format: NAME (scope) | description [inactive]
			display := name
			if scopeVal != "" {
				display = fmt.Sprintf("%s (%s)", name, scopeVal)
			}
			if desc != "" {
				display = fmt.Sprintf("%s  | %s", display, desc)
			}
			if !active {
				display += " [inactive]"
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: display,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, 20)
	if err != nil {
		return err
	}

	if selected != nil {
		// Set the selected scope as current
		return setScopeAsCurrent(ctx, app, selected.ID)
	}

	return nil
}

// setScopeAsCurrent sets an application scope as the current scope for the user
func setScopeAsCurrent(ctx context.Context, app *appctx.App, identifier string) error {
	// Find the scope
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,name,scope")

	// Try to find by name or scope field first, then by sys_id
	query := fmt.Sprintf("name=%s^ORscope=%s^ORsys_id=%s", identifier, identifier, identifier)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to find scope: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("scope not found: %s", identifier)
	}

	scope := records[0]
	sysID := getStringValue(scope, "sys_id")
	name := getStringValue(scope, "name")
	scopeVal := getStringValue(scope, "scope")

	// Get current user sys_id
	currentUser, err := app.SDK.GetCurrentUser(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}
	userSysID := currentUser.SysID
	userName := currentUser.UserName

	// Set the user preference for current application
	// Use the scope value (e.g., "global", "x_my_app") for the preference
	prefValue := scopeVal
	if prefValue == "" {
		prefValue = sysID
	}

	if err := setUserPreference(ctx, app, userSysID, "apps.current_app", prefValue); err != nil {
		return fmt.Errorf("failed to set scope preference: %w", err)
	}

	return app.OK(map[string]any{
		"action":       "set_current_scope",
		"scope_sys_id": sysID,
		"scope_name":   name,
		"scope_value":  scopeVal,
		"user":         userSysID,
		"user_name":    userName,
		"status":       "success",
	},
		output.WithSummary(fmt.Sprintf("Scope '%s' set as current", name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "view",
				Cmd:         fmt.Sprintf("jsn dev scopes show %s", sysID),
				Description: "View scope details",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev scopes list",
				Description: "Back to scopes",
			},
		),
	)
}

func getScope(ctx context.Context, app *appctx.App, identifier string, columns []string) error {
	if len(columns) == 0 {
		columns = scopeDefaultColumns
	}

	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")
	fetchColumns := append([]string{"sys_id"}, columns...)
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))

	// Try to find by name or scope field first, then by sys_id
	query := fmt.Sprintf("name=%s^ORscope=%s^ORsys_id=%s", identifier, identifier, identifier)
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_scope", params)
	if err != nil {
		return fmt.Errorf("failed to get scope: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("scope not found: %s", identifier)
	}

	return app.OK(wrapRecordWithContext(records[0], "sys_scope", app.Config.GetEffectiveInstance()),
		output.WithSummary(fmt.Sprintf("Scope: %s", identifier)),
	)
}
