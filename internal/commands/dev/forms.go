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

// formSection represents a UI Section (sys_ui_section record).
type formSection struct {
	SysID     string `json:"sys_id"`
	Name      string `json:"name"`
	View      string `json:"view"`
	Caption   string `json:"caption"`
	Header    string `json:"header"`
	Order     int    `json:"order"`
	Active    bool   `json:"active"`
	CreatedOn string `json:"sys_created_on"`
	UpdatedOn string `json:"sys_updated_on"`
}

// formElement represents a UI Element (sys_ui_element record).
type formElement struct {
	SysID       string `json:"sys_id"`
	Section     string `json:"sys_ui_section"`
	Name        string `json:"element"`
	Label       string `json:"label"`
	ElementType string `json:"type"`
	Position    int    `json:"position"`
	Row         int    `json:"row"`
	Column      int    `json:"col"`
	Mandatory   bool   `json:"mandatory"`
	ReadOnly    bool   `json:"read_only"`
	Visible     bool   `json:"visible"`
}

// NewFormsCmd creates the forms command group.
func NewFormsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "forms",
		Aliases: []string{"form"},
		Short:   "Manage UI Forms",
		Long: `List and view ServiceNow UI Form layouts.

Forms are defined by sys_ui_section records for a specific table and view.
Core UI uses views like "Default view", while Workspaces use views like 
"service operations workspace".

Examples:
  # List all views for incident table
  jsn dev forms list incident

  # Show default form layout for incident
  jsn dev forms show incident

  # Show specific view
  jsn dev forms show incident --view "service operations workspace"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newFormsListCmd(),
		newFormsShowCmd(),
	)

	return cmd
}

func newFormsListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list [table]",
		Short: "List form views for a table",
		Long: `List all form views defined for a specific table.

Examples:
  jsn dev forms list incident
  jsn dev forms list incident --limit 100`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listFormViews(ctx, app, args[0], limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of views to fetch")

	return cmd
}

func newFormsShowCmd() *cobra.Command {
	var view string

	cmd := &cobra.Command{
		Use:   "show [table]",
		Short: "Show form layout",
		Long: `Show detailed form layout including sections and fields.

This displays the form structure: sections, fields in each section,
and their order. Much faster than clicking through the UI.

Examples:
  # Show default form for incident
  jsn dev forms show incident

  # Show specific view
  jsn dev forms show incident --view "service operations workspace"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showFormLayout(ctx, app, args[0], view)
		},
	}

	cmd.Flags().StringVar(&view, "view", "Default view", "View name")

	return cmd
}

// listFormViews lists all views for a table
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listFormViews(ctx context.Context, app *appctx.App, table string, limit int) error {
	if limit <= 0 {
		limit = 100
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listFormsInteractive(ctx, app, table, limit)
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

	records, err := app.SDK.List(ctx, "sys_ui_section", params)
	if err != nil {
		return fmt.Errorf("failed to list form views: %w", err)
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
		output.WithSummary(fmt.Sprintf("%d views for %s", len(views), table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn dev forms show %s --view \"Default view\"", table),
				Description: "Show Default view layout",
			},
		),
	)
}

// showFormLayout displays form layout with sections and fields
func showFormLayout(ctx context.Context, app *appctx.App, table, viewName string) error {
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

	// Fetch sections
	params := url.Values{}
	params.Set("sysparm_limit", "100")
	params.Set("sysparm_fields", "sys_id,name,view,caption,header,order,active,sys_created_on,sys_updated_on")
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
		sysparmQuery = "ORDERBYorder"
	} else {
		sysparmQuery = sysparmQuery + "^ORDERBYorder"
	}
	params.Set("sysparm_query", sysparmQuery)

	records, err := app.SDK.List(ctx, "sys_ui_section", params)
	if err != nil {
		return fmt.Errorf("failed to list form sections: %w", err)
	}

	if len(records) == 0 {
		return fmt.Errorf("no form sections found for %s with view \"%s\"", table, viewName)
	}

	// Parse sections
	var sections []formSection
	for _, record := range records {
		sections = append(sections, formSection{
			SysID:     getStringValue(record, "sys_id"),
			Name:      getStringValue(record, "name"),
			View:      getStringValue(record, "view"),
			Caption:   getStringValue(record, "caption"),
			Header:    getStringValue(record, "header"),
			Order:     getIntValue(record, "order"),
			Active:    getBoolValue(record, "active"),
			CreatedOn: getStringValue(record, "sys_created_on"),
			UpdatedOn: getStringValue(record, "sys_updated_on"),
		})
	}

	// Fetch elements for each section
	sectionElements := make(map[string][]formElement)
	for _, section := range sections {
		elemParams := url.Values{}
		elemParams.Set("sysparm_limit", "100")
		elemParams.Set("sysparm_fields", "sys_id,sys_ui_section,element,label,type,position,row,col,mandatory,read_only,visible")
		elemParams.Set("sysparm_display_value", "all")
		elemParams.Set("sysparm_query", "sys_ui_section="+section.SysID+"^ORDERBYposition")

		elemRecords, err := app.SDK.List(ctx, "sys_ui_element", elemParams)
		if err != nil {
			continue
		}

		var elements []formElement
		for _, record := range elemRecords {
			elements = append(elements, formElement{
				SysID:       getStringValue(record, "sys_id"),
				Section:     getStringValue(record, "sys_ui_section"),
				Name:        getStringValue(record, "element"),
				Label:       getStringValue(record, "label"),
				ElementType: getStringValue(record, "type"),
				Position:    getIntValue(record, "position"),
				Row:         getIntValue(record, "row"),
				Column:      getIntValue(record, "col"),
				Mandatory:   getBoolValue(record, "mandatory"),
				ReadOnly:    getBoolValue(record, "read_only"),
				Visible:     getBoolValue(record, "visible"),
			})
		}
		sectionElements[section.SysID] = elements
	}

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFormLayout(table, viewName, sections, sectionElements)
	}

	// Build enriched data for JSON/Quiet output
	var sectionsData []map[string]any
	for _, section := range sections {
		elements := sectionElements[section.SysID]

		sort.Slice(elements, func(i, j int) bool {
			return elements[i].Position < elements[j].Position
		})

		var elementsData []map[string]any
		for _, elem := range elements {
			if elem.ElementType != "" && elem.ElementType != "field" {
				continue
			}
			elementsData = append(elementsData, map[string]any{
				"sys_id":    elem.SysID,
				"name":      elem.Name,
				"label":     elem.Label,
				"type":      elem.ElementType,
				"position":  elem.Position,
				"mandatory": elem.Mandatory,
				"read_only": elem.ReadOnly,
			})
		}

		sectionTitle := section.Caption
		if sectionTitle == "" && section.Header != "" && section.Header != "false" {
			sectionTitle = section.Header
		}
		if sectionTitle == "" {
			sectionTitle = "Section"
		}

		sectionsData = append(sectionsData, map[string]any{
			"sys_id":   section.SysID,
			"caption":  sectionTitle,
			"order":    section.Order,
			"elements": elementsData,
		})
	}

	data := map[string]any{
		"table":    table,
		"view":     viewName,
		"sections": sectionsData,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_ui_section",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("Form: %s (%s) - %d sections", table, viewName, len(sections))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn dev forms list %s", table),
				Description: "List all views",
			},
			output.Breadcrumb{
				Action:      "columns",
				Cmd:         fmt.Sprintf("jsn dev columns --table %s", table),
				Description: "View table columns",
			},
		),
	)
}

// printStyledFormLayout outputs styled form layout.
func printStyledFormLayout(table, view string, sections []formSection, sectionElements map[string][]formElement) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))

	fmt.Println()

	// Title
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s (%s)", table, view)))
	fmt.Println()

	// Sections
	for i, section := range sections {
		elements := sectionElements[section.SysID]

		sectionTitle := section.Caption
		if sectionTitle == "" && section.Header != "" && section.Header != "false" {
			sectionTitle = section.Header
		}
		if sectionTitle == "" {
			sectionTitle = fmt.Sprintf("Section %d", i+1)
		}
		fmt.Println(sectionStyle.Render(fmt.Sprintf("─ %s ─", sectionTitle)))

		if len(elements) == 0 {
			fmt.Println(labelStyle.Render("  (no fields)"))
			fmt.Println()
			continue
		}

		sort.Slice(elements, func(i, j int) bool {
			return elements[i].Position < elements[j].Position
		})

		for _, elem := range elements {
			if elem.ElementType != "" && elem.ElementType != "field" {
				continue
			}

			displayName := elem.Name
			if displayName == "" {
				displayName = elem.Label
			}
			if displayName == "" {
				displayName = elem.ElementType
			}

			indicators := ""
			if elem.Mandatory {
				indicators += " *"
			}
			if elem.ReadOnly {
				indicators += " (RO)"
			}

			fmt.Printf("  %s%s\n", fieldStyle.Render(displayName), labelStyle.Render(indicators))
		}

		fmt.Println()
	}

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn dev forms list %s", table),
		labelStyle.Render("List all views"),
	)
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn dev columns --table %s", table),
		labelStyle.Render("View table columns"),
	)

	fmt.Println()
	return nil
}

// Helper functions for extracting values from records
func getStringValue(record map[string]any, key string) string {
	if v, ok := record[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]any:
			if value, ok := val["value"].(string); ok {
				return value
			}
		}
	}
	return ""
}

func getDisplayValue(record map[string]any, key string) string {
	if v, ok := record[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]any:
			if display, ok := val["display_value"].(string); ok && display != "" {
				return display
			}
			if value, ok := val["value"].(string); ok {
				return value
			}
		}
	}
	return ""
}

func getIntValue(record map[string]any, key string) int {
	if v, ok := record[key]; ok && v != nil {
		switch val := v.(type) {
		case float64:
			return int(val)
		case int:
			return val
		case string:
			var i int
			if _, err := fmt.Sscanf(val, "%d", &i); err == nil {
				return i
			}
		}
	}
	return 0
}

func getBoolValue(record map[string]any, key string) bool {
	if v, ok := record[key]; ok && v != nil {
		switch val := v.(type) {
		case bool:
			return val
		case string:
			return val == "true"
		}
	}
	return false
}

// listFormsInteractive shows an interactive picker for form views
// It queries sys_ui_section to find views that actually have sections for the specified table,
// ensuring only relevant views are shown (not all views in the system).
func listFormsInteractive(ctx context.Context, app *appctx.App, table string, pageSize int) error {
	// Step 1: Query sys_ui_section to find views that have sections for this table
	params := url.Values{}
	params.Set("sysparm_query", "name="+table)
	params.Set("sysparm_fields", "view")
	params.Set("sysparm_group_by", "view")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_limit", fmt.Sprintf("%d", pageSize))

	sections, err := app.SDK.List(ctx, "sys_ui_section", params)
	if err != nil {
		return fmt.Errorf("failed to fetch form sections: %w", err)
	}

	// Step 2: Extract unique view names from sections
	viewMap := make(map[string]bool)
	var items []tui.PickerItem
	for _, section := range sections {
		viewName := getDisplayValue(section, "view")
		if viewName != "" && !viewMap[viewName] {
			viewMap[viewName] = true
			items = append(items, tui.PickerItem{
				ID:    viewName,
				Title: viewName,
			})
		}
	}

	if len(items) == 0 {
		return fmt.Errorf("no form views found for table: %s", table)
	}

	// Sort items by view name for consistent ordering
	sort.Slice(items, func(i, j int) bool {
		return items[i].Title < items[j].Title
	})

	// Step 3: Show the interactive picker with filtered views
	selected, err := tui.Pick("Select a form view", items)
	if err != nil {
		return err
	}

	// If user selected a view, show its form layout
	if selected != nil {
		return showFormLayout(ctx, app, table, selected.Title)
	}

	// User cancelled
	return nil
}
