// Package dev provides development-related commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// listElement represents a List column (sys_ui_list_element record).
type listElement struct {
	SysID    string `json:"sys_id"`
	ListID   string `json:"list_id"`
	Element  string `json:"element"`
	Position int    `json:"position"`
	Type     string `json:"type"`
}

// NewListsCmd creates the lists command group.
func NewListsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "lists",
		Aliases: []string{"list-layout"},
		Short:   "Manage UI List layouts",
		Long: `List and view ServiceNow UI List column layouts.

Lists define which columns appear in table views. Like forms, they are view-specific.
The "Default view" controls the standard list, while other views (e.g., workspace views)
may show different columns.

Examples:
  # List all views for incident table
  jsn dev lists list incident

  # Show default list columns for incident
  jsn dev lists show incident

  # Show specific view
  jsn dev lists show incident --view "service operations workspace"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newListsListCmd(),
		newListsShowCmd(),
	)

	return cmd
}

// newListsListCmd creates the lists list subcommand
func newListsListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list [table]",
		Short: "List list views for a table",
		Long: `List all list views defined for a specific table.

Examples:
  jsn dev lists list incident
  jsn dev lists list incident --limit 100`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listListViews(ctx, app, args[0], limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of views to fetch")

	return cmd
}

// newListsShowCmd creates the lists show subcommand
func newListsShowCmd() *cobra.Command {
	var view string

	cmd := &cobra.Command{
		Use:   "show [table]",
		Short: "Show list layout",
		Long: `Show detailed list layout including columns.

This displays the list structure: columns in order.
Much faster than clicking through the UI.

Examples:
  # Show default list columns for incident
  jsn dev lists show incident

  # Show specific view
  jsn dev lists show incident --view "service operations workspace"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showListLayout(ctx, app, args[0], view)
		},
	}

	cmd.Flags().StringVar(&view, "view", "Default view", "View name")

	return cmd
}

// listListViews lists all views for a table
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listListViews(ctx context.Context, app *appctx.App, table string, limit int) error {
	if limit <= 0 {
		limit = 100
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listListsInteractive(ctx, app, table, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "view")
	params.Set("sysparm_group_by", "view")
	params.Set("sysparm_display_value", "all")

	sysparmQuery := "ORDERBYview"
	if table != "" {
		sysparmQuery = sysparmQuery + "^name=" + table
	}
	params.Set("sysparm_query", sysparmQuery)

	records, err := app.SDK.List(ctx, "sys_ui_list", params)
	if err != nil {
		return fmt.Errorf("failed to list list views: %w", err)
	}

	// Extract unique view names
	viewMap := make(map[string]bool)
	var views []string
	for _, record := range records {
		view := getDisplayValue(record, "view")
		if view != "" && !viewMap[view] {
			viewMap[view] = true
			views = append(views, view)
		}
	}

	sort.Strings(views)

	// Categorize views
	var defaultViews, workspaceViews, otherViews []string
	for _, v := range views {
		if v == "Default view" {
			defaultViews = append(defaultViews, v)
		} else if strings.Contains(strings.ToLower(v), "workspace") {
			workspaceViews = append(workspaceViews, v)
		} else {
			otherViews = append(otherViews, v)
		}
	}

	// Build records as []map[string]string for styled output
	var recordsOut []map[string]string
	for _, v := range views {
		recordsOut = append(recordsOut, map[string]string{
			"view":  v,
			"table": table,
		})
	}

	return app.OK(map[string]any{
		"table":        table,
		"count":        len(views),
		"default":      defaultViews,
		"workspaces":   workspaceViews,
		"other":        otherViews,
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d list views for %s", len(views), table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn dev lists show %s --view \"Default view\"", table),
				Description: "Show Default view columns",
			},
		),
	)
}

// showListLayout displays list layout with columns
func showListLayout(ctx context.Context, app *appctx.App, table, viewName string) error {
	// Look up view sys_id first
	viewSysID := ""
	viewParams := url.Values{}
	viewParams.Set("sysparm_limit", "1")
	viewParams.Set("sysparm_fields", "sys_id")
	viewParams.Set("sysparm_query", "name="+viewName)

	viewRecords, err := app.SDK.List(ctx, "sys_ui_view", viewParams)
	if err == nil && len(viewRecords) > 0 {
		viewSysID = getStringValue(viewRecords[0], "sys_id")
	}
	if viewSysID == "" {
		// Try by title
		viewParams.Set("sysparm_query", "title="+viewName)
		viewRecords, err = app.SDK.List(ctx, "sys_ui_view", viewParams)
		if err == nil && len(viewRecords) > 0 {
			viewSysID = getStringValue(viewRecords[0], "sys_id")
		}
	}
	if viewSysID == "" {
		viewSysID = viewName // Fall back to using view name directly
	}

	// Fetch list layouts
	params := url.Values{}
	params.Set("sysparm_limit", "10")
	params.Set("sysparm_fields", "sys_id,name,view,parent,active,sys_created_on,sys_updated_on")
	params.Set("sysparm_display_value", "all")

	var sysparmQuery string
	if table != "" {
		sysparmQuery = "name=" + table
	}
	if viewSysID != "" {
		if sysparmQuery != "" {
			sysparmQuery = sysparmQuery + "^"
		}
		sysparmQuery = sysparmQuery + "view=" + viewSysID
	}
	if sysparmQuery == "" {
		sysparmQuery = "ORDERBYsys_created_on"
	} else {
		sysparmQuery = sysparmQuery + "^ORDERBYsys_created_on"
	}
	params.Set("sysparm_query", sysparmQuery)

	records, err := app.SDK.List(ctx, "sys_ui_list", params)
	if err != nil {
		return fmt.Errorf("failed to list layouts: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("no list layout found for %s with view \"%s\"", table, viewName)
	}

	mainLayout := records[0]
	layoutSysID := getStringValue(mainLayout, "sys_id")

	// Fetch elements (columns) for the list
	elemParams := url.Values{}
	elemParams.Set("sysparm_limit", "100")
	elemParams.Set("sysparm_fields", "sys_id,list_id,element,position,type")
	elemParams.Set("sysparm_display_value", "all")
	elemParams.Set("sysparm_query", "list_id="+layoutSysID+"^ORDERBYposition")

	elemRecords, err := app.SDK.List(ctx, "sys_ui_list_element", elemParams)
	if err != nil {
		return fmt.Errorf("failed to list columns: %w", err)
	}

	// Parse elements
	var elements []listElement
	for _, record := range elemRecords {
		elements = append(elements, listElement{
			SysID:    getStringValue(record, "sys_id"),
			ListID:   getStringValue(record, "list_id"),
			Element:  getStringValue(record, "element"),
			Position: getIntValue(record, "position"),
			Type:     getStringValue(record, "type"),
		})
	}

	// Sort by position
	sort.Slice(elements, func(i, j int) bool {
		return elements[i].Position < elements[j].Position
	})

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledListLayout(table, viewName, elements)
	}

	// Build data for JSON/Quiet output
	var columnsData []map[string]any
	for _, elem := range elements {
		col := map[string]any{
			"element":  elem.Element,
			"position": elem.Position,
		}
		if elem.Type != "" {
			col["type"] = elem.Type
		}
		columnsData = append(columnsData, col)
	}

	data := map[string]any{
		"table":   table,
		"view":    viewName,
		"columns": columnsData,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_ui_list",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("List: %s (%s) - %d columns", table, viewName, len(elements))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn dev lists list %s", table),
				Description: "List all views",
			},
			output.Breadcrumb{
				Action:      "form",
				Cmd:         fmt.Sprintf("jsn dev forms show %s --view \"%s\"", table, viewName),
				Description: "Show form layout",
			},
		),
	)
}

// printStyledListLayout outputs styled list layout.
func printStyledListLayout(table, view string, elements []listElement) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	posStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))

	fmt.Println()

	// Title
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s (%s)", table, view)))
	fmt.Println()

	// Columns
	fmt.Println(sectionStyle.Render("─ List Columns ─"))
	if len(elements) == 0 {
		fmt.Println(labelStyle.Render("  (no columns defined)"))
	} else {
		for i, elem := range elements {
			fmt.Printf("  %s  %s\n",
				posStyle.Render(fmt.Sprintf("%2d.", i+1)),
				fieldStyle.Render(elem.Element),
			)
		}
	}
	fmt.Println()

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn dev lists list %s", table),
		labelStyle.Render("List all views"),
	)
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn dev forms show %s --view \"%s\"", table, view),
		labelStyle.Render("Show form layout"),
	)

	fmt.Println()
	return nil
}

// listListsInteractive shows an interactive picker for list views
// It queries sys_ui_list to find views that actually have list layouts for the specified table,
// ensuring only relevant views are shown (not all views in the system).
func listListsInteractive(ctx context.Context, app *appctx.App, table string, pageSize int) error {
	// Step 1: Query sys_ui_list to find views that have list layouts for this table
	params := url.Values{}
	params.Set("sysparm_query", "name="+table)
	params.Set("sysparm_fields", "view")
	params.Set("sysparm_group_by", "view")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", fmt.Sprintf("%d", pageSize))

	lists, err := app.SDK.List(ctx, "sys_ui_list", params)
	if err != nil {
		return fmt.Errorf("failed to fetch list layouts: %w", err)
	}

	// Step 2: Extract unique view names from list layouts
	viewMap := make(map[string]bool)
	var items []tui.PickerItem
	for _, list := range lists {
		viewName := getDisplayValue(list, "view")
		if viewName != "" && !viewMap[viewName] {
			viewMap[viewName] = true
			items = append(items, tui.PickerItem{
				ID:    viewName,
				Title: viewName,
			})
		}
	}

	if len(items) == 0 {
		return fmt.Errorf("no list views found for table: %s", table)
	}

	// Sort items by view name for consistent ordering
	sort.Slice(items, func(i, j int) bool {
		return items[i].Title < items[j].Title
	})

	// Step 3: Show the interactive picker with filtered views
	selected, err := tui.Pick("Select a list view", items)
	if err != nil {
		return err
	}

	// If user selected a view, show its list layout
	if selected != nil {
		return showListLayout(ctx, app, table, selected.Title)
	}

	// User cancelled
	return nil
}
