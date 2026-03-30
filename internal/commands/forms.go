package commands

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// formsListFlags holds the flags for the forms command.
type formsListFlags struct {
	table string
	limit int
	view  string
}

// NewFormsCmd creates the forms command group.
func NewFormsCmd() *cobra.Command {
	var flags formsListFlags

	cmd := &cobra.Command{
		Use:     "forms [<table>]",
		Aliases: []string{"form"},
		Short:   "Manage UI Forms",
		Long: `List and view ServiceNow UI Form layouts.

Forms are defined by sys_ui_section records for a specific table and view.
Core UI uses views like "Default view", while Workspaces use views like "service operations workspace".

Usage:
  jsn forms                                       List form views (requires --table)
  jsn forms <table>                               Show form layout (Default view)
  jsn forms <table> --view "service operations workspace"   Show specific view
  jsn forms --table incident                      List all views for a table

Examples:
  jsn forms incident
  jsn forms incident --view "Default view"
  jsn forms incident --view "service operations workspace"
  jsn forms --table incident`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct table lookup — show form layout
			if len(args) > 0 {
				showFlags := formsShowFlags{view: flags.view}
				return runFormsShow(cmd, args[0], showFlags)
			}

			// Mode 2: List views (requires --table flag)
			return runFormsList(cmd, flags)
		},
	}

	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Table name to filter views")
	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 50, "Maximum number of views to fetch")
	cmd.Flags().StringVar(&flags.view, "view", "Default view", "View name (default: \"Default view\")")

	return cmd
}

// runFormsList executes the forms list command.
func runFormsList(cmd *cobra.Command, flags formsListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	opts := &sdk.ListFormViewsOptions{
		TableName: flags.table,
		Limit:     flags.limit,
	}

	views, err := sdkClient.ListFormViews(cmd.Context(), flags.table, opts)
	if err != nil {
		return fmt.Errorf("failed to list form views: %w", err)
	}

	// Sort views for consistent output
	sort.Strings(views)

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFormsList(cmd, views, flags.table)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFormsList(cmd, views, flags.table)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, view := range views {
		row := map[string]any{
			"view": view,
		}
		if flags.table != "" {
			row["table"] = flags.table
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         fmt.Sprintf("jsn forms %s --view <view>", flags.table),
			Description: "Show form layout",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d views", len(views))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledFormsList outputs styled forms list.
func printStyledFormsList(cmd *cobra.Command, views []string, table string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())

	if table != "" {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Form Views for %s", table)))
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Form Views"))
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Categorize views
	var defaultViews, workspaceViews, otherViews []string
	for _, view := range views {
		if view == "Default view" {
			defaultViews = append(defaultViews, view)
		} else if strings.Contains(strings.ToLower(view), "workspace") {
			workspaceViews = append(workspaceViews, view)
		} else {
			otherViews = append(otherViews, view)
		}
	}

	// Print categorized views
	if len(defaultViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Core UI:"))
		for _, view := range defaultViews {
			fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if len(workspaceViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Workspaces:"))
		for _, view := range workspaceViews {
			fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if len(otherViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Other Views:"))
		for _, view := range otherViews {
			fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	if table != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			fmt.Sprintf("jsn forms %s --view \"Default view\"", table),
			labelStyle.Render("Show Default view layout"),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownFormsList outputs markdown forms list.
func printMarkdownFormsList(cmd *cobra.Command, views []string, table string) error {
	if table != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "**Form Views for %s**\n\n", table)
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "**Form Views**")
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Categorize views
	var defaultViews, workspaceViews, otherViews []string
	for _, view := range views {
		if view == "Default view" {
			defaultViews = append(defaultViews, view)
		} else if strings.Contains(strings.ToLower(view), "workspace") {
			workspaceViews = append(workspaceViews, view)
		} else {
			otherViews = append(otherViews, view)
		}
	}

	// Print categorized views
	if len(defaultViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Core UI")
		for _, view := range defaultViews {
			fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if len(workspaceViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Workspaces")
		for _, view := range workspaceViews {
			fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if len(otherViews) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Other Views")
		for _, view := range otherViews {
			fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", view)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// formsShowFlags holds the flags for forms show mode.
type formsShowFlags struct {
	view string
}

// runFormsShow executes the forms show command.
func runFormsShow(cmd *cobra.Command, table string, flags formsShowFlags) error {
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

	// Fetch sections for the table/view
	sectionOpts := &sdk.ListFormSectionsOptions{
		TableName: table,
		ViewName:  flags.view,
	}

	sections, err := sdkClient.ListFormSections(cmd.Context(), sectionOpts)
	if err != nil {
		return fmt.Errorf("failed to list form sections: %w", err)
	}

	if len(sections) == 0 {
		return fmt.Errorf("no form sections found for %s with view \"%s\"", table, flags.view)
	}

	// Fetch elements for each section
	sectionElements := make(map[string][]sdk.FormElement)
	for _, section := range sections {
		elementOpts := &sdk.ListFormElementsOptions{
			SectionID: section.SysID,
		}
		elements, err := sdkClient.ListFormElements(cmd.Context(), elementOpts)
		if err != nil {
			// Continue even if we can't get elements for one section
			continue
		}
		sectionElements[section.SysID] = elements
	}

	// Fetch related lists for this table/view
	relatedLists, err := sdkClient.ListRelatedLists(cmd.Context(), &sdk.ListRelatedListsOptions{
		ParentTable: table,
		ViewName:    flags.view,
	})
	if err != nil {
		// Non-fatal — show form layout without related lists
		relatedLists = nil
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledFormLayout(cmd, table, flags.view, sections, sectionElements, relatedLists, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownFormLayout(cmd, table, flags.view, sections, sectionElements, relatedLists, instanceURL)
	}

	// Build data for JSON/quiet output - include elements sorted by order
	var sectionsWithElements []map[string]interface{}
	for _, section := range sections {
		elements := sectionElements[section.SysID]
		// Sort elements by position
		sort.Slice(elements, func(i, j int) bool {
			return elements[i].Position < elements[j].Position
		})
		sectionsWithElements = append(sectionsWithElements, map[string]interface{}{
			"sys_id":   section.SysID,
			"name":     section.Name,
			"view":     section.View,
			"caption":  section.Caption,
			"header":   section.Header,
			"order":    section.Order,
			"active":   section.Active,
			"elements": elements,
		})
	}

	data := map[string]interface{}{
		"table":    table,
		"view":     flags.view,
		"sections": sectionsWithElements,
	}

	if len(relatedLists) > 0 {
		var relData []map[string]interface{}
		for _, rl := range relatedLists {
			entry := map[string]interface{}{
				"table": rl.Layout.Name,
			}
			if rl.Layout.Relationship != "" {
				entry["relationship"] = rl.Layout.Relationship
			}
			var cols []string
			for _, e := range rl.Elements {
				cols = append(cols, e.Element)
			}
			entry["columns"] = cols
			relData = append(relData, entry)
		}
		data["related_lists"] = relData
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         fmt.Sprintf("jsn forms --table %s", table),
			Description: "List all views",
		},
		{
			Action:      "list-layout",
			Cmd:         fmt.Sprintf("jsn lists %s --view \"%s\"", table, flags.view),
			Description: "Show list columns",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Form: %s (%s) - %d sections, %d related lists", table, flags.view, len(sections), len(relatedLists))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledFormLayout outputs styled form layout.
func printStyledFormLayout(cmd *cobra.Command, table, view string, sections []sdk.FormSection, sectionElements map[string][]sdk.FormElement, relatedLists []sdk.RelatedList, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))

	w := cmd.OutOrStdout()

	fmt.Fprintln(w)

	// Title
	fmt.Fprintln(w, headerStyle.Render(fmt.Sprintf("%s (%s)", table, view)))
	fmt.Fprintln(w)

	// Sections
	for i, section := range sections {
		elements := sectionElements[section.SysID]

		// Section header - handle "false" string in header field
		sectionTitle := section.Caption
		if sectionTitle == "" && section.Header != "false" {
			sectionTitle = section.Header
		}
		if sectionTitle == "" {
			sectionTitle = fmt.Sprintf("Section %d", i+1)
		}
		fmt.Fprintln(w, sectionStyle.Render(fmt.Sprintf("─ %s ─", sectionTitle)))

		if len(elements) == 0 {
			fmt.Fprintln(w, mutedStyle.Render("  (no fields)"))
			fmt.Fprintln(w)
			continue
		}

		// Sort elements by position
		sort.Slice(elements, func(i, j int) bool {
			return elements[i].Position < elements[j].Position
		})

		// Print elements in order
		for _, elem := range elements {
			// Skip non-field elements (formatters, related lists, etc.)
			if elem.ElementType != "" && elem.ElementType != "field" {
				continue
			}

			// Use field name (name) as primary, label as fallback
			displayName := elem.Name
			if displayName == "" {
				displayName = elem.Label
			}
			if displayName == "" {
				displayName = elem.ElementType
			}

			// Add indicators for special fields
			indicators := ""
			if elem.Mandatory {
				indicators += " *"
			}
			if elem.ReadOnly {
				indicators += " (RO)"
			}

			fmt.Fprintf(w, "  %s%s\n", fieldStyle.Render(displayName), labelStyle.Render(indicators))
		}

		fmt.Fprintln(w)
	}

	// Related lists
	if len(relatedLists) > 0 {
		fmt.Fprintln(w, sectionStyle.Render(fmt.Sprintf("─ Related Lists (%d) ─", len(relatedLists))))
		fmt.Fprintln(w)
		for _, rl := range relatedLists {
			name := relatedListDisplayName(rl)
			fmt.Fprintf(w, "  %s\n", fieldStyle.Render(name))
			if len(rl.Elements) > 0 {
				var colNames []string
				for _, e := range rl.Elements {
					colNames = append(colNames, e.Element)
				}
				fmt.Fprintf(w, "    %s\n", labelStyle.Render(strings.Join(colNames, ", ")))
			}
		}
		fmt.Fprintln(w)
	}

	// Link to form layout
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_section_list.do?sysparm_query=name%%3D%s%%5Eview%%3D%s", instanceURL, table, view)
		fmt.Fprintf(w, "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Form Layout:"),
			link,
			"View in ServiceNow",
		)
		fmt.Fprintln(w)
	}

	// Hints
	fmt.Fprintln(w, "─────")
	fmt.Fprintln(w)
	fmt.Fprintln(w, headerStyle.Render("Hints:"))
	fmt.Fprintf(w, "  %-50s  %s\n",
		fmt.Sprintf("jsn forms --table %s", table),
		labelStyle.Render("List all views"),
	)
	fmt.Fprintf(w, "  %-50s  %s\n",
		fmt.Sprintf("jsn lists %s --view \"%s\"", table, view),
		labelStyle.Render("Show list columns"),
	)

	fmt.Fprintln(w)
	return nil
}

// printMarkdownFormLayout outputs markdown form layout.
func printMarkdownFormLayout(cmd *cobra.Command, table, view string, sections []sdk.FormSection, sectionElements map[string][]sdk.FormElement, relatedLists []sdk.RelatedList, instanceURL string) error {
	w := cmd.OutOrStdout()

	fmt.Fprintf(w, "**%s (%s)**\n\n", table, view)

	// Sections
	for i, section := range sections {
		elements := sectionElements[section.SysID]

		// Section header - handle "false" string in header field
		sectionTitle := section.Caption
		if sectionTitle == "" && section.Header != "false" {
			sectionTitle = section.Header
		}
		if sectionTitle == "" {
			sectionTitle = fmt.Sprintf("Section %d", i+1)
		}
		fmt.Fprintf(w, "#### %s\n\n", sectionTitle)

		if len(elements) == 0 {
			fmt.Fprintln(w, "*(no fields)*")
			fmt.Fprintln(w)
			continue
		}

		// Sort elements by position
		sort.Slice(elements, func(i, j int) bool {
			return elements[i].Position < elements[j].Position
		})

		// Print elements in order
		for _, elem := range elements {
			// Skip non-field elements (formatters, related lists, etc.)
			if elem.ElementType != "" && elem.ElementType != "field" {
				continue
			}

			// Use field name (name) as primary, label as fallback
			displayName := elem.Name
			if displayName == "" {
				displayName = elem.Label
			}
			if displayName == "" {
				displayName = elem.ElementType
			}

			// Add indicators for special fields
			indicators := ""
			if elem.Mandatory {
				indicators += " *"
			}
			if elem.ReadOnly {
				indicators += " (RO)"
			}

			fmt.Fprintf(w, "- %s%s\n", displayName, indicators)
		}
		fmt.Fprintln(w)
	}

	// Related lists
	if len(relatedLists) > 0 {
		fmt.Fprintf(w, "#### Related Lists (%d)\n\n", len(relatedLists))
		for _, rl := range relatedLists {
			name := relatedListDisplayName(rl)
			if len(rl.Elements) > 0 {
				var colNames []string
				for _, e := range rl.Elements {
					colNames = append(colNames, e.Element)
				}
				fmt.Fprintf(w, "- **%s**: %s\n", name, strings.Join(colNames, ", "))
			} else {
				fmt.Fprintf(w, "- **%s**\n", name)
			}
		}
		fmt.Fprintln(w)
	}

	// Link to form layout
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_section_list.do?sysparm_query=name%%3D%s%%5Eview%%3D%s", instanceURL, table, view)
		fmt.Fprintf(w, "**Form Layout:** [View in ServiceNow](%s)\n\n", link)
	}

	return nil
}
