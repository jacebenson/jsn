package commands

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// updateSetListFlags holds the flags for the updateset list command.
type updateSetListFlags struct {
	limit int
	scope string
	state string
	all   bool
}

// updateSetCreateFlags holds the flags for the updateset create command.
type updateSetCreateFlags struct {
	scope       string
	description string
	parent      string
	setCurrent  bool
}

// NewUpdateSetCmd creates the updateset command group.
func NewUpdateSetCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "updateset",
		Short: "Manage update sets",
		Long:  "List, create, and manage ServiceNow update sets.",
	}

	cmd.AddCommand(
		newUpdateSetListCmd(),
		newUpdateSetShowCmd(),
		newUpdateSetUseCmd(),
		newUpdateSetCreateCmd(),
		newUpdateSetParentCmd(),
	)

	return cmd
}

// newUpdateSetListCmd creates the updateset list command.
func newUpdateSetListCmd() *cobra.Command {
	var flags updateSetListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List update sets",
		Long: `List update sets from sys_update_set.

Examples:
  jsn updateset list
  jsn updateset list --scope global
  jsn updateset list --state in_progress`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUpdateSetList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of update sets to fetch")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Filter by application scope")
	cmd.Flags().StringVar(&flags.state, "state", "", "Filter by state (in_progress, completed, etc.)")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all update sets (no limit)")

	return cmd
}

// runUpdateSetList executes the updateset list command.
func runUpdateSetList(cmd *cobra.Command, flags updateSetListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build query
	var queryParts []string

	if flags.scope != "" {
		if flags.scope == "global" {
			queryParts = append(queryParts, "applicationISEMPTY")
		} else {
			queryParts = append(queryParts, fmt.Sprintf("application.scope=%s^ORapplication.name=%s", flags.scope, flags.scope))
		}
	}

	if flags.state != "" {
		queryParts = append(queryParts, fmt.Sprintf("state=%s", flags.state))
	}

	sysparmQuery := strings.Join(queryParts, "^")

	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListUpdateSetsOptions{
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   "sys_updated_on",
		OrderDesc: true,
	}

	updateSets, err := sdkClient.ListUpdateSets(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list update sets: %w", err)
	}

	// Get current user to check current update set
	var currentUpdateSetID string
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err == nil && currentUser != nil {
		currentUpdateSet, _ := sdkClient.GetCurrentUpdateSet(cmd.Context(), currentUser.SysID)
		if currentUpdateSet != nil {
			currentUpdateSetID = currentUpdateSet.SysID
		}
	}

	// Convert to maps for output
	var data []map[string]any
	for _, us := range updateSets {
		scopeDisplay := us.AppName
		if scopeDisplay == "" {
			scopeDisplay = "global"
		}

		name := us.Name
		if us.SysID == currentUpdateSetID {
			name = "* " + name
		}

		row := map[string]any{
			"sys_id": us.SysID,
			"name":   name,
			"scope":  scopeDisplay,
		}

		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, us.SysID)
		}

		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d update sets", len(updateSets))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn updateset show <name>",
				Description: "Show update set details",
			},
			output.Breadcrumb{
				Action:      "create",
				Cmd:         "jsn updateset create <name> --scope <scope>",
				Description: "Create a new update set",
			},
		),
	)
}

// newUpdateSetShowCmd creates the updateset show command.
func newUpdateSetShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show update set details",
		Long:  "Display detailed information about an update set.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUpdateSetShow(cmd, args[0])
		},
	}
}

// runUpdateSetShow executes the updateset show command.
func runUpdateSetShow(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the update set
	updateSet, err := sdkClient.GetUpdateSet(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get update set: %w", err)
	}

	// Get current user to check if this is their current update set
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	isCurrent := false
	if err == nil && currentUser != nil {
		currentUpdateSet, _ := sdkClient.GetCurrentUpdateSet(cmd.Context(), currentUser.SysID)
		if currentUpdateSet != nil && currentUpdateSet.SysID == updateSet.SysID {
			isCurrent = true
		}
	}

	// Get children update sets
	children, _ := sdkClient.GetChildUpdateSets(cmd.Context(), updateSet.SysID)

	// Build output
	scopeDisplay := updateSet.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}

	result := map[string]any{
		"name":        updateSet.Name,
		"sys_id":      updateSet.SysID,
		"state":       updateSet.State,
		"scope":       scopeDisplay,
		"description": updateSet.Description,
		"created_by":  updateSet.CreatedBy,
		"created_on":  updateSet.CreatedOn,
		"updated_by":  updateSet.UpdatedBy,
		"updated_on":  updateSet.UpdatedOn,
		"is_current":  isCurrent,
	}

	if updateSet.Parent != "" && updateSet.ParentName != "" {
		result["parent"] = updateSet.ParentName
		if instanceURL != "" {
			result["parent_link"] = fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.Parent)
		}
	}

	if len(children) > 0 {
		var childNames []string
		for _, child := range children {
			childNames = append(childNames, child.Name)
		}
		result["children"] = childNames
		result["children_count"] = len(children)
	}

	// Build breadcrumbs
	var breadcrumbs []output.Breadcrumb

	if !isCurrent {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "use",
			Cmd:         fmt.Sprintf("jsn updateset use %s", updateSet.Name),
			Description: "Set as current update set",
		})
	}

	if updateSet.Parent == "" {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "parent",
			Cmd:         fmt.Sprintf("jsn updateset parent %s <parent_name>", updateSet.Name),
			Description: "Set parent update set",
		})
	}

	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn updateset list",
		Description: "List all update sets",
	})

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUpdateSetDetails(cmd, updateSet, children, isCurrent, instanceURL, breadcrumbs)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUpdateSetDetails(cmd, updateSet, children, isCurrent, instanceURL, breadcrumbs)
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("%s (%s)", updateSet.Name, updateSet.State)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// newUpdateSetUseCmd creates the updateset use command.
func newUpdateSetUseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use [<name>]",
		Short: "Set as current update set",
		Long:  "Set an update set as the current update set for the authenticated user. If no name is provided, an interactive selection will be shown.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) >= 1 {
				name = args[0]
			}
			return runUpdateSetUse(cmd, name)
		},
	}
}

// runUpdateSetUse executes the updateset use command.
func runUpdateSetUse(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get current user first
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Get current update set ID for marking
	var currentUpdateSetID string
	if currentUser != nil {
		currentUpdateSet, _ := sdkClient.GetCurrentUpdateSet(cmd.Context(), currentUser.SysID)
		if currentUpdateSet != nil {
			currentUpdateSetID = currentUpdateSet.SysID
		}
	}

	// Interactive selection if no name provided
	if name == "" {
		// Fetch update sets for interactive selection
		opts := &sdk.ListUpdateSetsOptions{
			Limit:     20,
			OrderBy:   "sys_updated_on",
			OrderDesc: true,
		}
		allUpdateSets, err := sdkClient.ListUpdateSets(cmd.Context(), opts)
		if err != nil {
			return fmt.Errorf("failed to list update sets: %w", err)
		}
		if len(allUpdateSets) == 0 {
			return fmt.Errorf("no update sets found")
		}

		// Build picker items
		var items []tui.PickerItem
		for _, us := range allUpdateSets {
			scope := us.AppName
			if scope == "" {
				scope = "global"
			}
			items = append(items, tui.PickerItem{
				ID:          us.SysID,
				Title:       us.Name,
				Description: scope,
			})
		}

		// Sort: current first
		tui.SortWithCurrentFirst(items, func(item tui.PickerItem) bool {
			return item.ID == currentUpdateSetID
		})

		selected, err := tui.Pick("Select update set to use:", items)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		name = selected.Title
	}

	// Get the update set
	updateSet, err := sdkClient.GetUpdateSet(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to find update set: %w", err)
	}

	// Set as current update set
	err = sdkClient.SetCurrentUpdateSet(cmd.Context(), currentUser.SysID, updateSet.SysID)
	if err != nil {
		return fmt.Errorf("failed to set current update set: %w", err)
	}

	// Get children for show output
	children, _ := sdkClient.GetChildUpdateSets(cmd.Context(), updateSet.SysID)

	// Build breadcrumbs
	var breadcrumbs []output.Breadcrumb
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "show",
		Cmd:         fmt.Sprintf("jsn updateset show %s", updateSet.Name),
		Description: "View update set details",
	})
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn updateset list",
		Description: "List all update sets",
	})

	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUpdateSetDetails(cmd, updateSet, children, true, instanceURL, breadcrumbs)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUpdateSetDetails(cmd, updateSet, children, true, instanceURL, breadcrumbs)
	}

	// JSON/quiet output
	scopeDisplay := updateSet.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}

	result := map[string]any{
		"name":        updateSet.Name,
		"sys_id":      updateSet.SysID,
		"state":       updateSet.State,
		"scope":       scopeDisplay,
		"description": updateSet.Description,
		"created_by":  updateSet.CreatedBy,
		"created_on":  updateSet.CreatedOn,
		"updated_by":  updateSet.UpdatedBy,
		"updated_on":  updateSet.UpdatedOn,
		"is_current":  true,
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Set '%s' as current update set", updateSet.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// newUpdateSetCreateCmd creates the updateset create command.
func newUpdateSetCreateCmd() *cobra.Command {
	var flags updateSetCreateFlags

	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a new update set",
		Long: `Create a new update set in the specified scope.

The name will be auto-formatted as: <username>-yyyy-mm-dd-<description>
Example: If your username is "jsmith" and you provide "fix-login", the name becomes "jsm-2026-03-15-fix-login"

Examples:
  jsn updateset create "fix-login-bug" --scope "my_app"
  jsn updateset create "emergency-fix" --scope "global" --description "Hotfix for production issue"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUpdateSetCreate(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.scope, "scope", "global", "Application scope (default: global)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Update set description")
	cmd.Flags().StringVar(&flags.parent, "parent", "", "Parent update set name or sys_id")
	cmd.Flags().BoolVar(&flags.setCurrent, "set-current", true, "Set as current update set after creation")

	return cmd
}

// runUpdateSetCreate executes the updateset create command.
func runUpdateSetCreate(cmd *cobra.Command, name string, flags updateSetCreateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get current user for initials
	currentUser, err := sdkClient.GetCurrentUser(cmd.Context())
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Format name: <initials>-yyyy-mm-dd-<name>
	today := time.Now().Format("2006-01-02")

	// Get initials from first name + last name if available
	initials := ""
	if currentUser.Name != "" {
		// Split name and get first letter of each part
		parts := strings.Fields(currentUser.Name)
		for _, part := range parts {
			if len(part) > 0 {
				initials += strings.ToLower(string(part[0]))
			}
		}
	}

	// Fallback to username if no initials from name
	if initials == "" {
		initials = currentUser.UserName
		if initials == "" {
			initials = "usr"
		}
	}

	// Truncate to max 3 chars
	if len(initials) > 3 {
		initials = initials[:3]
	}

	formattedName := fmt.Sprintf("%s-%s-%s", initials, today, name)

	// Resolve parent if provided
	parentSysID := ""
	if flags.parent != "" {
		parentUpdateSet, err := sdkClient.GetUpdateSet(cmd.Context(), flags.parent)
		if err != nil {
			return fmt.Errorf("failed to find parent update set: %w", err)
		}
		parentSysID = parentUpdateSet.SysID
	}

	// Resolve scope to sys_id if it's not global
	scopeSysID := ""
	if flags.scope != "" && flags.scope != "global" {
		app, err := sdkClient.GetApplication(cmd.Context(), flags.scope)
		if err != nil {
			return fmt.Errorf("failed to find scope: %w", err)
		}
		scopeSysID = app.SysID
	}

	// Create the update set
	updateSet, err := sdkClient.CreateUpdateSet(cmd.Context(), formattedName, scopeSysID, flags.description, parentSysID)
	if err != nil {
		return fmt.Errorf("failed to create update set: %w", err)
	}

	// Set as current if requested
	if flags.setCurrent {
		sdkClient.SetCurrentUpdateSet(cmd.Context(), currentUser.SysID, updateSet.SysID)
	}

	// Build output same as "show" command
	scopeDisplay := updateSet.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}

	result := map[string]any{
		"name":        updateSet.Name,
		"sys_id":      updateSet.SysID,
		"state":       updateSet.State,
		"scope":       scopeDisplay,
		"description": updateSet.Description,
		"created_by":  updateSet.CreatedBy,
		"created_on":  updateSet.CreatedOn,
		"updated_by":  updateSet.UpdatedBy,
		"updated_on":  updateSet.UpdatedOn,
		"is_current":  flags.setCurrent,
	}

	if updateSet.Parent != "" && updateSet.ParentName != "" {
		result["parent"] = updateSet.ParentName
		if instanceURL != "" {
			result["parent_link"] = fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.Parent)
		}
	}

	// Build breadcrumbs
	var breadcrumbs []output.Breadcrumb

	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "use",
		Cmd:         fmt.Sprintf("jsn updateset use %s", updateSet.Name),
		Description: "Set as current update set",
	})

	if updateSet.Parent == "" {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "parent",
			Cmd:         fmt.Sprintf("jsn updateset parent %s <parent_name>", updateSet.Name),
			Description: "Set parent update set",
		})
	}

	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn updateset list",
		Description: "List all update sets",
	})

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUpdateSetDetails(cmd, updateSet, []sdk.UpdateSet{}, flags.setCurrent, instanceURL, breadcrumbs)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUpdateSetDetails(cmd, updateSet, []sdk.UpdateSet{}, flags.setCurrent, instanceURL, breadcrumbs)
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created update set '%s'", updateSet.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// newUpdateSetParentCmd creates the updateset parent command.
func newUpdateSetParentCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "parent [<child> <parent>]",
		Short: "Set parent update set",
		Long:  "Set a parent update set for cross-scope work. If arguments are not provided, an interactive selection will be shown.",
		Args:  cobra.RangeArgs(0, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var childName, parentName string
			if len(args) >= 1 {
				childName = args[0]
			}
			if len(args) >= 2 {
				parentName = args[1]
			}
			return runUpdateSetParent(cmd, childName, parentName)
		},
	}
}

// runUpdateSetParent executes the updateset parent command.
func runUpdateSetParent(cmd *cobra.Command, childName, parentName string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Check if we need interactive mode
	needInteractive := childName == "" || parentName == ""

	// Fetch all update sets for interactive mode or validation
	var allUpdateSets []sdk.UpdateSet
	if needInteractive {

		// Fetch update sets for interactive selection
		opts := &sdk.ListUpdateSetsOptions{
			Limit:     20,
			OrderBy:   "sys_updated_on",
			OrderDesc: true,
		}
		allUpdateSets, _ = sdkClient.ListUpdateSets(cmd.Context(), opts)
		if len(allUpdateSets) == 0 {
			return fmt.Errorf("no update sets found")
		}
	}

	// Get current user's update set for marking
	var currentUpdateSetID string
	currentUser, _ := sdkClient.GetCurrentUser(cmd.Context())
	if currentUser != nil {
		currentUpdateSet, _ := sdkClient.GetCurrentUpdateSet(cmd.Context(), currentUser.SysID)
		if currentUpdateSet != nil {
			currentUpdateSetID = currentUpdateSet.SysID
		}
	}

	// Interactive selection for child
	if childName == "" {
		// Build picker items
		var items []tui.PickerItem
		for _, us := range allUpdateSets {
			scope := us.AppName
			if scope == "" {
				scope = "global"
			}
			items = append(items, tui.PickerItem{
				ID:          us.SysID,
				Title:       us.Name,
				Description: scope,
			})
		}

		// Sort: current first
		tui.SortWithCurrentFirst(items, func(item tui.PickerItem) bool {
			return item.ID == currentUpdateSetID
		})

		selected, err := tui.Pick("Select child update set (the one to set parent for):", items)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		childName = selected.Title
	}

	// Get child update set
	child, err := sdkClient.GetUpdateSet(cmd.Context(), childName)
	if err != nil {
		return fmt.Errorf("failed to find child update set: %w", err)
	}

	// Interactive selection for parent
	if parentName == "" {
		// Build picker items (exclude the child)
		var items []tui.PickerItem
		for _, us := range allUpdateSets {
			if us.SysID == child.SysID {
				continue // Can't be parent of itself
			}
			scope := us.AppName
			if scope == "" {
				scope = "global"
			}
			items = append(items, tui.PickerItem{
				ID:          us.SysID,
				Title:       us.Name,
				Description: scope,
			})
		}

		if len(items) == 0 {
			return fmt.Errorf("no other update sets available to use as parent")
		}

		// Sort: current first
		tui.SortWithCurrentFirst(items, func(item tui.PickerItem) bool {
			return item.ID == currentUpdateSetID
		})

		selected, err := tui.Pick("Select parent update set:", items)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		parentName = selected.Title
	}

	// Get parent update set
	parent, err := sdkClient.GetUpdateSet(cmd.Context(), parentName)
	if err != nil {
		return fmt.Errorf("failed to find parent update set: %w", err)
	}

	// Update child with parent
	updates := map[string]interface{}{
		"parent": parent.SysID,
	}

	updated, err := sdkClient.UpdateUpdateSet(cmd.Context(), child.SysID, updates)
	if err != nil {
		return fmt.Errorf("failed to set parent: %w", err)
	}

	// Check if the updated update set is the current one
	isCurrent := false
	if currentUpdateSetID == updated.SysID {
		isCurrent = true
	}

	// Build breadcrumbs
	var breadcrumbs []output.Breadcrumb
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "show",
		Cmd:         fmt.Sprintf("jsn updateset show %s", updated.Name),
		Description: "View child update set",
	})
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "show",
		Cmd:         fmt.Sprintf("jsn updateset show %s", parent.Name),
		Description: "View parent update set",
	})
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn updateset list",
		Description: "List all update sets",
	})

	// Determine output format
	format := outputWriter.GetFormat()
	outputIsTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && outputIsTerminal) {
		return printStyledUpdateSetParent(cmd, updated, parent, isCurrent, instanceURL, breadcrumbs)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUpdateSetParent(cmd, updated, parent, isCurrent, instanceURL, breadcrumbs)
	}

	// Build result for JSON/quiet
	scopeDisplay := updated.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}

	result := map[string]any{
		"name":          updated.Name,
		"sys_id":        updated.SysID,
		"state":         updated.State,
		"scope":         scopeDisplay,
		"parent":        parent.Name,
		"parent_sys_id": parent.SysID,
		"description":   updated.Description,
		"created_by":    updated.CreatedBy,
		"created_on":    updated.CreatedOn,
		"updated_by":    updated.UpdatedBy,
		"updated_on":    updated.UpdatedOn,
		"is_current":    isCurrent,
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Set '%s' as parent of '%s'", parent.Name, updated.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledUpdateSetDetails outputs styled update set details.
func printStyledUpdateSetDetails(cmd *cobra.Command, updateSet *sdk.UpdateSet, children []sdk.UpdateSet, isCurrent bool, instanceURL string, breadcrumbs []output.Breadcrumb) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title with current indicator
	title := fmt.Sprintf("%s (%s)", updateSet.Name, updateSet.State)
	if isCurrent {
		title = title + " [CURRENT]"
	}
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Metadata section
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Metadata"))

	scopeDisplay := updateSet.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Sys ID:"), valueStyle.Render(updateSet.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Scope:"), valueStyle.Render(scopeDisplay))

	if updateSet.ParentName != "" {
		parentStr := updateSet.ParentName
		if instanceURL != "" {
			link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.Parent)
			parentStr = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, updateSet.ParentName)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Parent:"), valueStyle.Render(parentStr))
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n", labelStyle.Render("Link:"), link, link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Children section
	if len(children) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Children (%d)", len(children))))
		fmt.Fprintln(cmd.OutOrStdout())
		for _, child := range children {
			childStr := child.Name
			if instanceURL != "" {
				link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, child.SysID)
				childStr = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, child.Name)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", valueStyle.Render(childStr))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Description section
	if updateSet.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Description"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(updateSet.Description))
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Audit section
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Audit"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Created by:"), valueStyle.Render(updateSet.CreatedBy))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Created on:"), valueStyle.Render(updateSet.CreatedOn))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Updated by:"), valueStyle.Render(updateSet.UpdatedBy))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Updated on:"), valueStyle.Render(updateSet.UpdatedOn))

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints section
	if len(breadcrumbs) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "─────")
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))

		for _, bc := range breadcrumbs {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s  %s\n", bc.Cmd, labelStyle.Render(bc.Description))
		}

		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// printMarkdownUpdateSetDetails outputs markdown update set details.
func printMarkdownUpdateSetDetails(cmd *cobra.Command, updateSet *sdk.UpdateSet, children []sdk.UpdateSet, isCurrent bool, instanceURL string, breadcrumbs []output.Breadcrumb) error {
	title := fmt.Sprintf("**%s (%s)**", updateSet.Name, updateSet.State)
	if isCurrent {
		title = title + " **[CURRENT]**"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Metadata")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", updateSet.SysID)

	scopeDisplay := updateSet.AppName
	if scopeDisplay == "" {
		scopeDisplay = "global"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", scopeDisplay)

	if updateSet.ParentName != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Parent:** %s", updateSet.ParentName)
		if instanceURL != "" {
			parentLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.Parent)
			fmt.Fprintf(cmd.OutOrStdout(), " (%s)", parentLink)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Children section
	if len(children) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), fmt.Sprintf("#### Children (%d)", len(children)))
		fmt.Fprintln(cmd.OutOrStdout())
		for _, child := range children {
			if instanceURL != "" {
				childLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, child.SysID)
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s** — %s\n", child.Name, childLink)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", child.Name)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if updateSet.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Description")
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", updateSet.Description)
	}

	fmt.Fprintln(cmd.OutOrStdout(), "#### Audit")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Created by:** %s\n", updateSet.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Created on:** %s\n", updateSet.CreatedOn)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated by:** %s\n", updateSet.UpdatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated on:** %s\n", updateSet.UpdatedOn)

	fmt.Fprintln(cmd.OutOrStdout())

	if len(breadcrumbs) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
		fmt.Fprintln(cmd.OutOrStdout())

		for _, bc := range breadcrumbs {
			fmt.Fprintf(cmd.OutOrStdout(), "- `%s` — %s\n", bc.Cmd, bc.Description)
		}

		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// printStyledUpdateSetParent outputs styled parent relationship info.
func printStyledUpdateSetParent(cmd *cobra.Command, updateSet *sdk.UpdateSet, parent *sdk.UpdateSet, isCurrent bool, instanceURL string, breadcrumbs []output.Breadcrumb) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title with current indicator
	title := fmt.Sprintf("%s (%s)", updateSet.Name, updateSet.State)
	if isCurrent {
		title = title + " [CURRENT]"
	}
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Parent relationship section
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Parent Relationship"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Parent info
	parentScope := parent.AppName
	if parentScope == "" {
		parentScope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Parent:"), valueStyle.Render(parent.Name))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Parent Sys ID:"), valueStyle.Render(parent.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Parent Scope:"), valueStyle.Render(parentScope))
	if instanceURL != "" {
		parentLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, parent.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n", labelStyle.Render("Parent Link:"), parentLink, parentLink)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Child info
	childScope := updateSet.AppName
	if childScope == "" {
		childScope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Child:"), valueStyle.Render(updateSet.Name))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Child Sys ID:"), valueStyle.Render(updateSet.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Child Scope:"), valueStyle.Render(childScope))
	if instanceURL != "" {
		childLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n", labelStyle.Render("Child Link:"), childLink, childLink)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())

	// Hints section
	if len(breadcrumbs) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
		for _, bc := range breadcrumbs {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n", bc.Cmd, labelStyle.Render(bc.Description))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// printMarkdownUpdateSetParent outputs markdown parent relationship info.
func printMarkdownUpdateSetParent(cmd *cobra.Command, updateSet *sdk.UpdateSet, parent *sdk.UpdateSet, isCurrent bool, instanceURL string, breadcrumbs []output.Breadcrumb) error {
	title := fmt.Sprintf("**%s (%s)**", updateSet.Name, updateSet.State)
	if isCurrent {
		title = title + " **[CURRENT]**"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Parent Relationship")
	fmt.Fprintln(cmd.OutOrStdout())

	// Parent info
	parentScope := parent.AppName
	if parentScope == "" {
		parentScope = "global"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Parent:** %s\n", parent.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Parent Sys ID:** %s\n", parent.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Parent Scope:** %s\n", parentScope)
	if instanceURL != "" {
		parentLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, parent.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Parent Link:** %s\n", parentLink)
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Child info
	childScope := updateSet.AppName
	if childScope == "" {
		childScope = "global"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Child:** %s\n", updateSet.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Child Sys ID:** %s\n", updateSet.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Child Scope:** %s\n", childScope)
	if instanceURL != "" {
		childLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_update_set.do?sys_id=%s", instanceURL, updateSet.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Child Link:** %s\n", childLink)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	if len(breadcrumbs) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
		fmt.Fprintln(cmd.OutOrStdout())
		for _, bc := range breadcrumbs {
			fmt.Fprintf(cmd.OutOrStdout(), "- `%s` — %s\n", bc.Cmd, bc.Description)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}
