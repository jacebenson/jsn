// Package dev provides development-related commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
)

// updateSetListColumns are the columns shown in the update set list view
// Order: name, application, state, parent, updates
var updateSetListColumns = []string{"name", "application", "state", "parent", "updates"}

// NewUpdateSetsCmd creates the update sets command group.
func NewUpdateSetsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "updatesets [name|sys_id]",
		Aliases: []string{"updateset", "us"},
		Short:   "Manage update sets",
		Args:    cobra.ArbitraryArgs,
		Long: `Manage update sets in ServiceNow.

Update sets are collections of configuration changes that can be moved between 
ServiceNow instances. This command allows you to list, view, and set the current
update set for your session.

Examples:
  # List all update sets (interactive picker in TTY mode)
  jsn dev updatesets list

  # Show a specific update set by name
  jsn dev updatesets show "My Update Set"

  # Show a specific update set by sys_id
  jsn dev updatesets show abc123def456

  # List with filter
  jsn dev updatesets list --query "state=in progress"

  # Set the current update set (interactive picker in TTY mode)
  jsn dev updatesets set

  # Set a specific update set
  jsn dev updatesets set "My Update Set"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No args - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newUpdateSetsListCmd(),
		newUpdateSetsShowCmd(),
		newUpdateSetsSetCmd(),
	)

	return cmd
}

func newUpdateSetsListCmd() *cobra.Command {
	var (
		query  string
		limit  int
		offset int
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List update sets",
		Long: `List update sets with update counts and optional filtering.

Pagination:
  Use --limit and --offset to paginate through results.
  For example: jsn dev updatesets list --limit 20 --offset 20 (shows page 2)

Filtering:
  Use --query with ServiceNow encoded query syntax.
  Examples:
    # In-progress only
    jsn dev updatesets list --query "state=in progress"

    # Specific application
    jsn dev updatesets list --query "application=12345"

    # By completed-by user
    jsn dev updatesets list --query "completed_by=jsmith"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listUpdateSets(ctx, app, query, offset)
		},
	}

	cmd.Flags().StringVarP(&query, "query", "", "", "Encoded query string (e.g., 'state=in progress')")
	cmd.Flags().IntVarP(&limit, "limit", "l", 20, "Maximum number of records to return")
	cmd.Flags().IntVarP(&offset, "offset", "o", 0, "Offset for pagination (number of records to skip)")

	return cmd
}

func newUpdateSetsShowCmd() *cobra.Command {
	var (
		scope  string
		simple bool
	)

	cmd := &cobra.Command{
		Use:   "show [name|sys_id]",
		Short: "Show an update set by name or sys_id",
		Long: `Retrieve and display a specific update set by its name or sys_id.

The enhanced show command displays:
- Update set details (name, scope, state, timestamps)
- Parent update set (if any)
- Child update sets (up to 10)
- Updates snapshot from sys_update_xml (up to 10, with total count)

When update set names are ambiguous (e.g., "Default" exists in multiple apps),
use the --scope flag to specify which application:

Examples:
  # Show update set by name (enhanced view)
  jsn dev updatesets show "My Update Set"

  # Show simple view (for scripts/automation)
  jsn dev updatesets show "My Update Set" --simple

  # Show "Default" update set in a specific scope
  jsn dev updatesets show "Default" --scope "x_my_app"

  # Show by sys_id (scope flag not needed)
  jsn dev updatesets show abc123def456`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()
			identifier := args[0]

			// Use enhanced show by default, simple view with --simple flag
			if simple {
				return getUpdateSet(ctx, app, identifier, scope)
			}
			return getUpdateSetEnhanced(ctx, app, identifier, scope)
		},
	}

	cmd.Flags().StringVarP(&scope, "scope", "s", "", "Filter by application scope (e.g., 'global', 'x_my_app')")
	cmd.Flags().BoolVarP(&simple, "simple", "", false, "Show simple output (for scripts/automation)")

	return cmd
}

func newUpdateSetsSetCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set [name|sys_id]",
		Short: "Set the current update set",
		Long: `Set the current update set for the session.

Without an argument, an interactive picker is shown to select an update set.
This command will look up the update set by name or sys_id and set it as the
current update set for your ServiceNow session.

Examples:
  # Interactive picker
  jsn dev updatesets set

  # Set by name
  jsn dev updatesets set "My Update Set"

  # Set by sys_id
  jsn dev updatesets set abc123def456`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			var identifier string

			if len(args) == 0 {
				// No argument provided - show interactive picker
				selected, err := pickUpdateSet(ctx, app)
				if err != nil {
					return err
				}
				if selected == nil {
					return fmt.Errorf("no update set selected")
				}
				identifier = selected.SysID
			} else {
				identifier = args[0]
			}

			// Find the update set
			updateSet, err := findUpdateSet(ctx, app, identifier, "")
			if err != nil {
				return err
			}

			sysID := getStringField(updateSet, "sys_id")
			name := getStringField(updateSet, "name")

			// Get the application/scope sys_id from the update set
			// apps.current_app needs the sys_id, not the display name
			appSysID := getStringField(updateSet, "application")
			if appSysID == "" {
				appSysID = "global"
			}

			// Get current user sys_id
			currentUser, err := getCurrentUser(ctx, app)
			if err != nil {
				return fmt.Errorf("failed to get current user: %w", err)
			}
			userSysID := getStringField(currentUser, "sys_id")
			userName := getStringField(currentUser, "user_name")

			// Set the user preferences for update set and application
			if err := setUserPreference(ctx, app, userSysID, "sys_update_set", sysID); err != nil {
				return fmt.Errorf("failed to set update set preference: %w", err)
			}
			if err := setUserPreference(ctx, app, userSysID, "apps.current_app", appSysID); err != nil {
				return fmt.Errorf("failed to set application preference: %w", err)
			}

			return app.OK(map[string]any{
				"action":            "set_current_update_set",
				"update_set_sys_id": sysID,
				"update_set_name":   name,
				"application":       appSysID,
				"user":              userSysID,
				"user_name":         userName,
				"status":            "success",
			},
				output.WithSummary(fmt.Sprintf("Update set '%s' set as current", name)),
				output.WithBreadcrumbs(
					output.Breadcrumb{
						Action:      "view",
						Cmd:         fmt.Sprintf("jsn dev updatesets show %s", sysID),
						Description: "View update set details",
					},
					output.Breadcrumb{
						Action:      "list",
						Cmd:         "jsn dev updatesets list",
						Description: "Back to update sets",
					},
				),
			)
		},
	}

	return cmd
}

// UpdateSetListItem represents an update set with its update count
type UpdateSetListItem struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	State       string `json:"state"`
	Parent      string `json:"parent"`
	Application string `json:"application"`
	UpdateCount int    `json:"updates"`
}

// UpdateSetDetail represents detailed update set information for the enhanced show command
type UpdateSetDetail struct {
	SysID       string            `json:"sys_id"`
	Name        string            `json:"name"`
	State       string            `json:"state"`
	Application map[string]string `json:"application"` // name, scope, sys_id
	Timestamps  map[string]string `json:"timestamps"`  // created_on, updated_on, created_by, updated_by
	Parent      *UpdateSetRef     `json:"parent,omitempty"`
	Children    []UpdateSetRef    `json:"children,omitempty"`
	Updates     struct {
		Count    int              `json:"count"`
		Snapshot []UpdateSnapshot `json:"snapshot"`
		HasMore  bool             `json:"has_more"`
	} `json:"updates"`
}

// UpdateSetRef is a lightweight reference to another update set
type UpdateSetRef struct {
	SysID string `json:"sys_id"`
	Name  string `json:"name"`
}

// UpdateSnapshot represents a single update record from sys_update_xml
type UpdateSnapshot struct {
	SysID      string `json:"sys_id"`
	Type       string `json:"type"`        // table name like sys_script_include
	TargetName string `json:"target_name"` // name of the record being updated
	Action     string `json:"action"`      // INSERT, UPDATE, DELETE
	UpdatedBy  string `json:"updated_by"`
	UpdatedOn  string `json:"updated_on"`
}

// pickUpdateSet shows an interactive picker to select an update set.
// Returns the selected update set item or nil if cancelled.
func pickUpdateSet(ctx context.Context, app *appctx.App) (*tui.UpdateSetItem, error) {
	// Fetch update sets with their update counts
	params := url.Values{}
	params.Set("sysparm_limit", "50")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_fields", "sys_id,application,name,state,parent")
	params.Set("sysparm_query", "ORDERBYDESCsys_created_on")

	records, err := app.SDK.List(ctx, "sys_update_set", params)
	if err != nil {
		return nil, fmt.Errorf("failed to list update sets: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("no update sets found")
	}

	// Fetch update counts concurrently
	type countResult struct {
		sysID string
		count int
	}
	countChan := make(chan countResult, len(records))
	var wg sync.WaitGroup

	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		if sysID == "" {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			count, _ := app.SDK.AggregateCount(ctx, "sys_update_xml", fmt.Sprintf("update_set=%s", id))
			countChan <- countResult{id, count}
		}(sysID)
	}

	go func() {
		wg.Wait()
		close(countChan)
	}()

	// Build update count map
	updateCounts := make(map[string]int)
	for result := range countChan {
		updateCounts[result.sysID] = result.count
	}

	// Convert records to picker items
	items := make([]tui.UpdateSetItem, 0, len(records))
	for i, record := range records {
		sysID := getStringField(record, "sys_id")
		if sysID == "" {
			continue
		}

		appName := getDisplayField(record, "application")
		if appName == "" {
			appName = "Global"
		}

		items = append(items, tui.UpdateSetItem{
			Number:      i + 1,
			Name:        getStringField(record, "name"),
			Application: appName,
			State:       getStringField(record, "state"),
			UpdateCount: updateCounts[sysID],
			SysID:       sysID,
		})
	}

	if len(items) == 0 {
		return nil, fmt.Errorf("no update sets available")
	}

	// Show interactive picker
	picker := tui.NewUpdateSetPicker(items)
	return picker.Run()
}

// listUpdateSets lists update sets with update counts
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listUpdateSets(ctx context.Context, app *appctx.App, query string, offset int) error {
	// Check if we're in an interactive terminal (and no query/offset filters set)
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive, no format forced, and no specific query/offset, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto && query == "" && offset == 0 {
		return listUpdateSetsInteractive(ctx, app)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", "20")
	params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
	params.Set("sysparm_display_value", "all")
	// Fetch fields needed for the list view
	// Use reference fields (application, parent) - API returns both value and display_value
	fetchColumns := []string{"sys_id", "application", "name", "state", "parent"}
	params.Set("sysparm_fields", strings.Join(fetchColumns, ","))
	// Sort by sys_created_on descending (newest first)
	if query != "" {
		params.Set("sysparm_query", query+"^ORDERBYDESCsys_created_on")
	} else {
		params.Set("sysparm_query", "ORDERBYDESCsys_created_on")
	}

	records, err := app.SDK.List(ctx, "sys_update_set", params)
	if err != nil {
		return fmt.Errorf("failed to list update sets: %w", err)
	}

	// Fetch update counts concurrently
	var wg sync.WaitGroup
	countChan := make(chan struct {
		sysID string
		count int
	}, len(records))

	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		if sysID == "" {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			count, _ := app.SDK.AggregateCount(ctx, "sys_update_xml", fmt.Sprintf("update_set=%s", id))
			countChan <- struct {
				sysID string
				count int
			}{id, count}
		}(sysID)
	}

	// Close channel when all goroutines done
	go func() {
		wg.Wait()
		close(countChan)
	}()

	// Build update count map
	updateCounts := make(map[string]int)
	for result := range countChan {
		updateCounts[result.sysID] = result.count
	}

	// Build display items with truncated values
	var items []UpdateSetListItem
	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		item := UpdateSetListItem{
			SysID:       sysID,
			Name:        truncateString(getStringField(record, "name"), 20),
			State:       truncateString(getStringField(record, "state"), 20),
			Parent:      truncateString(getDisplayField(record, "parent"), 20),
			Application: truncateString(getDisplayField(record, "application"), 20),
			UpdateCount: updateCounts[sysID],
		}
		items = append(items, item)
	}

	// Format as table data with columns: name, application, state, parent, updates
	var displayRecords []map[string]string
	for _, item := range items {
		displayRecords = append(displayRecords, map[string]string{
			"sys_id":      item.SysID,
			"name":        item.Name,
			"application": item.Application,
			"state":       item.State,
			"parent":      item.Parent,
			"updates":     fmt.Sprintf("%d", item.UpdateCount),
		})
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn dev updatesets show \"...\"",
			Description: "Show details for a specific update set",
		},
		{
			Action:      "show-scoped",
			Cmd:         "jsn dev updatesets show \"Default\" --scope \"global\"",
			Description: "Show scoped update set (useful for duplicate names)",
		},
		{
			Action:      "set",
			Cmd:         "jsn dev updatesets set",
			Description: "Select an update set to be your current one",
		},
		{
			Action:      "filter",
			Cmd:         "jsn dev updatesets list --query \"state=in progress\"",
			Description: "Filter: in-progress update sets only",
		},
	}

	// Add pagination breadcrumbs if applicable
	if len(records) == 20 {
		nextOffset := offset + 20
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "next",
			Cmd:         fmt.Sprintf("jsn dev updatesets list --offset %d%s", nextOffset, buildQuerySuffix(query)),
			Description: fmt.Sprintf("Next page (offset %d)", nextOffset),
		})
	}

	if offset > 0 {
		prevOffset := offset - 20
		if prevOffset < 0 {
			prevOffset = 0
		}
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "prev",
			Cmd:         fmt.Sprintf("jsn dev updatesets list --offset %d%s", prevOffset, buildQuerySuffix(query)),
			Description: "Previous page",
		})
	}

	return app.OK(map[string]any{
		"table":   "sys_update_set",
		"count":   len(items),
		"columns": updateSetListColumns,
		"records": displayRecords,
		"pagination": map[string]any{
			"limit":  20,
			"offset": offset,
		},
		"context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
		},
	},
		output.WithSummary(fmt.Sprintf("%d update set(s)", len(items))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// listUpdateSetsInteractive shows an interactive picker for update sets
// When an update set is selected, it shows details (used by list subcommand)
func listUpdateSetsInteractive(ctx context.Context, app *appctx.App) error {
	fetcher := tui.NewListFetcher("sys_update_set").
		WithColumns("name", "application", "state", "sys_scope").
		WithOrderBy("ORDERBYDESCsys_created_on").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringField(record, "name")
			state := getStringField(record, "state")
			appName := getDisplayField(record, "application")
			sysID := getStringField(record, "sys_id")

			if appName == "" {
				appName = "Global"
			}

			// Format: NAME | App | State
			display := fmt.Sprintf("%s  | %s  | %s", name, appName, state)

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
		// Show the update set details (for list subcommand)
		return getUpdateSet(ctx, app, selected.ID, "")
	}

	return nil
}

// buildQuerySuffix returns query flag string if query is set
func buildQuerySuffix(query string) string {
	if query != "" {
		return fmt.Sprintf(" --query \"%s\"", query)
	}
	return ""
}

// getUpdateSet retrieves an update set by name or sys_id
func getUpdateSet(ctx context.Context, app *appctx.App, identifier string, scope string) error {
	record, err := findUpdateSet(ctx, app, identifier, scope)
	if err != nil {
		return err
	}

	sysID := getStringField(record, "sys_id")

	// Fetch update count
	updateCount, _ := app.SDK.AggregateCount(ctx, "sys_update_xml", fmt.Sprintf("update_set=%s", sysID))

	// Add context and formatted data
	record["_context"] = map[string]any{
		"instance_url": app.Config.GetEffectiveInstance(),
		"table":        "sys_update_set",
		"update_count": updateCount,
	}

	return app.OK(record,
		output.WithSummary(fmt.Sprintf("Update set %s (%d updates)", getStringField(record, "name"), updateCount)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "set",
				Cmd:         fmt.Sprintf("jsn dev updatesets set %s", identifier),
				Description: "Set as current update set",
			},
			output.Breadcrumb{
				Action:      "view-updates",
				Cmd:         fmt.Sprintf("jsn records list --table sys_update_xml --query \"update_set=%s\"", sysID),
				Description: "View updates in this set",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev updatesets list",
				Description: "Back to all update sets",
			},
		),
	)
}

// findUpdateSet finds an update set by name or sys_id
// When scope is provided and searching by name, it filters to that application
func findUpdateSet(ctx context.Context, app *appctx.App, identifier string, scope string) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", "1")

	// Try to find by sys_id first (32-character hex string)
	// sys_id is unique, so scope filter not needed
	if len(identifier) == 32 && isHexString(identifier) {
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sys_update_set", params)
		if err != nil {
			return nil, fmt.Errorf("failed to find update set: %w", err)
		}

		if len(records) > 0 {
			return records[0], nil
		}
	}

	// Fall back to searching by name
	query := "name=" + identifier
	if scope != "" {
		// Filter by application scope when provided
		query = query + "^application.scope=" + scope
	}
	params.Set("sysparm_query", query)

	records, err := app.SDK.List(ctx, "sys_update_set", params)
	if err != nil {
		return nil, fmt.Errorf("failed to find update set: %w", err)
	}

	if len(records) == 0 {
		if scope != "" {
			return nil, fmt.Errorf("update set not found: %s in scope %s", identifier, scope)
		}
		return nil, fmt.Errorf("update set not found: %s", identifier)
	}

	return records[0], nil
}

// getCurrentUser retrieves the current user's sys_user record using the same
// method as the header display - uses javascript:gs.getUserID() to get the
// currently authenticated user based on the session.
func getCurrentUser(ctx context.Context, app *appctx.App) (map[string]any, error) {
	params := url.Values{}
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,user_name,name")
	// This query uses gs.getUserID() to get the current session's user
	// just like the SDK's GetCurrentUser method used in the header
	params.Set("sysparm_query", "sys_id=javascript:gs.getUserID()")

	records, err := app.SDK.List(ctx, "sys_user", params)
	if err != nil {
		return nil, fmt.Errorf("failed to query current user: %w", err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("could not determine current user from session")
	}

	return records[0], nil
}

// setUserPreference sets a user preference in sys_user_preference
// Creates the record if it doesn't exist, updates if it does
func setUserPreference(ctx context.Context, app *appctx.App, userSysID, name, value string) error {
	// First, try to find an existing preference
	params := url.Values{}
	params.Set("sysparm_query", fmt.Sprintf("user=%s^name=%s", userSysID, name))
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id")

	records, err := app.SDK.List(ctx, "sys_user_preference", params)
	if err != nil {
		return fmt.Errorf("failed to query preference: %w", err)
	}

	recordData := map[string]any{
		"user":  userSysID,
		"name":  name,
		"value": value,
	}

	if len(records) > 0 {
		// Update existing preference
		existingSysID := getStringField(records[0], "sys_id")
		_, err := app.SDK.Update(ctx, "sys_user_preference", existingSysID, recordData)
		if err != nil {
			return fmt.Errorf("failed to update preference: %w", err)
		}
	} else {
		// Create new preference
		_, err := app.SDK.Create(ctx, "sys_user_preference", recordData)
		if err != nil {
			return fmt.Errorf("failed to create preference: %w", err)
		}
	}

	return nil
}

// getUpdateSetEnhanced retrieves an update set by name or sys_id with detailed information
// including parent, children, and updates snapshot. Used for the enhanced show command.
func getUpdateSetEnhanced(ctx context.Context, app *appctx.App, identifier string, scope string) error {
	record, err := findUpdateSet(ctx, app, identifier, scope)
	if err != nil {
		return err
	}

	sysID := getStringField(record, "sys_id")

	// Build the detailed response
	detail := &UpdateSetDetail{
		SysID: sysID,
		Name:  getStringField(record, "name"),
		State: getStringField(record, "state"),
		Application: map[string]string{
			"sys_id": getStringField(record, "application"),
			"name":   getDisplayField(record, "application"),
			"scope":  getStringField(record, "application.scope"),
		},
		Timestamps: map[string]string{
			"created_on": getStringField(record, "sys_created_on"),
			"updated_on": getStringField(record, "sys_updated_on"),
			"created_by": getDisplayField(record, "sys_created_by"),
			"updated_by": getDisplayField(record, "sys_updated_by"),
		},
	}

	// Fetch total update count
	updateCount, _ := app.SDK.AggregateCount(ctx, "sys_update_xml", fmt.Sprintf("update_set=%s", sysID))
	detail.Updates.Count = updateCount

	// Fetch parent if exists
	parentSysID := getStringField(record, "parent")
	if parentSysID != "" {
		parent, err := fetchUpdateSetParent(ctx, app, parentSysID)
		if err == nil && parent != nil {
			detail.Parent = parent
		}
	}

	// Fetch children and updates concurrently
	var wg sync.WaitGroup
	var children []UpdateSetRef
	var snapshot []UpdateSnapshot
	var childrenErr, snapshotErr error

	wg.Add(2)

	go func() {
		defer wg.Done()
		children, childrenErr = fetchUpdateSetChildren(ctx, app, sysID)
	}()

	go func() {
		defer wg.Done()
		snapshot, snapshotErr = fetchUpdatesSnapshot(ctx, app, sysID)
	}()

	wg.Wait()

	if childrenErr == nil {
		detail.Children = children
	}
	if snapshotErr == nil {
		detail.Updates.Snapshot = snapshot
		detail.Updates.HasMore = updateCount > len(snapshot)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "set",
			Cmd:         fmt.Sprintf("jsn dev updatesets set %s", sysID),
			Description: "Set as current update set",
		},
		{
			Action:      "view-updates",
			Cmd:         fmt.Sprintf("jsn records list --table sys_update_xml --query \"update_set=%s\"", sysID),
			Description: "View all updates in this set",
		},
	}

	// Add parent breadcrumb if exists
	if detail.Parent != nil {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "view-parent",
			Cmd:         fmt.Sprintf("jsn dev updatesets show %s", detail.Parent.SysID),
			Description: fmt.Sprintf("View parent: %s", detail.Parent.Name),
		})
	}

	// Add children breadcrumb if exists
	if len(detail.Children) > 0 {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "view-children",
			Cmd:         fmt.Sprintf("jsn dev updatesets list --query \"parent=%s\"", sysID),
			Description: fmt.Sprintf("View all %d child update sets", len(detail.Children)),
		})
	}

	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn dev updatesets list",
		Description: "Back to all update sets",
	})

	// Add context and formatted data
	result := map[string]any{
		"detail": detail,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_update_set",
		},
	}

	return app.OK(result,
		output.WithSummary(fmt.Sprintf("Update set: %s (%d updates, %d children)", detail.Name, updateCount, len(detail.Children))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// fetchUpdateSetParent fetches a parent update set reference by sys_id
func fetchUpdateSetParent(ctx context.Context, app *appctx.App, parentSysID string) (*UpdateSetRef, error) {
	params := url.Values{}
	params.Set("sysparm_query", "sys_id="+parentSysID)
	params.Set("sysparm_limit", "1")
	params.Set("sysparm_fields", "sys_id,name")
	params.Set("sysparm_display_value", "all")

	records, err := app.SDK.List(ctx, "sys_update_set", params)
	if err != nil {
		return nil, err
	}

	if len(records) == 0 {
		return nil, nil
	}

	return &UpdateSetRef{
		SysID: getStringField(records[0], "sys_id"),
		Name:  getStringField(records[0], "name"),
	}, nil
}

// fetchUpdateSetChildren fetches child update sets for a given parent sys_id
// Returns up to 10 children
func fetchUpdateSetChildren(ctx context.Context, app *appctx.App, parentSysID string) ([]UpdateSetRef, error) {
	params := url.Values{}
	params.Set("sysparm_query", "parent="+parentSysID+"^ORDERBYDESCsys_created_on")
	params.Set("sysparm_limit", "10")
	params.Set("sysparm_fields", "sys_id,name")
	params.Set("sysparm_display_value", "all")

	records, err := app.SDK.List(ctx, "sys_update_set", params)
	if err != nil {
		return nil, err
	}

	children := make([]UpdateSetRef, 0, len(records))
	for _, record := range records {
		children = append(children, UpdateSetRef{
			SysID: getStringField(record, "sys_id"),
			Name:  getStringField(record, "name"),
		})
	}

	return children, nil
}

// fetchUpdatesSnapshot fetches a snapshot of updates from sys_update_xml
// Returns up to 10 most recent updates
func fetchUpdatesSnapshot(ctx context.Context, app *appctx.App, updateSetSysID string) ([]UpdateSnapshot, error) {
	params := url.Values{}
	params.Set("sysparm_query", "update_set="+updateSetSysID+"^ORDERBYDESCsys_updated_on")
	params.Set("sysparm_limit", "10")
	params.Set("sysparm_fields", "sys_id,type,target_name,action,sys_updated_by,sys_updated_on")
	params.Set("sysparm_display_value", "all")

	records, err := app.SDK.List(ctx, "sys_update_xml", params)
	if err != nil {
		return nil, err
	}

	snapshot := make([]UpdateSnapshot, 0, len(records))
	for _, record := range records {
		snapshot = append(snapshot, UpdateSnapshot{
			SysID:      getStringField(record, "sys_id"),
			Type:       getStringField(record, "type"),
			TargetName: getStringField(record, "target_name"),
			Action:     getStringField(record, "action"),
			UpdatedBy:  getDisplayField(record, "sys_updated_by"),
			UpdatedOn:  getStringField(record, "sys_updated_on"),
		})
	}

	return snapshot, nil
}

// Ensure SDK has the AggregateCount method
var _ interface {
	AggregateCount(ctx context.Context, table string, query string) (int, error)
} = (*sdk.Client)(nil)
