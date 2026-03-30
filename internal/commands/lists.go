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

// listsListFlags holds the flags for the lists command.
type listsListFlags struct {
	table string
	limit int
	view  string
}

// NewListsCmd creates the lists command group.
func NewListsCmd() *cobra.Command {
	var flags listsListFlags

	cmd := &cobra.Command{
		Use:     "lists [<table>]",
		Aliases: []string{"list-layout"},
		Short:   "Manage UI List layouts",
		Long: `List and view ServiceNow UI List column layouts.

Lists define which columns appear in table views. Like forms, they are view-specific.
The "Default view" controls the standard list, while other views (e.g., workspace views)
may show different columns.

Uses sys_ui_list and sys_ui_list_element tables.

Usage:
  jsn lists                                       List views (requires --table)
  jsn lists <table>                               Show list columns (Default view)
  jsn lists <table> --view "service operations workspace"   Show specific view
  jsn lists --table incident                      List all views for a table

Examples:
  jsn lists incident
  jsn lists incident --view "Default view"
  jsn lists --table incident`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct table lookup — show list layout
			if len(args) > 0 {
				showFlags := listsShowFlags{view: flags.view}
				return runListsShow(cmd, args[0], showFlags)
			}

			// Mode 2: List views (requires --table flag)
			return runListsList(cmd, flags)
		},
	}

	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Table name to filter views")
	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 50, "Maximum number of views to fetch")
	cmd.Flags().StringVar(&flags.view, "view", "Default view", "View name (default: \"Default view\")")

	return cmd
}

// runListsList executes the lists list command.
func runListsList(cmd *cobra.Command, flags listsListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	opts := &sdk.ListListViewsOptions{
		TableName: flags.table,
		Limit:     flags.limit,
	}

	views, err := sdkClient.ListListViews(cmd.Context(), flags.table, opts)
	if err != nil {
		return fmt.Errorf("failed to list views: %w", err)
	}

	// Sort views for consistent output
	sort.Strings(views)

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledListsList(cmd, views, flags.table)
	}

	if format == output.FormatMarkdown {
		return printMarkdownListsList(cmd, views, flags.table)
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
			Cmd:         fmt.Sprintf("jsn lists %s --view <view>", flags.table),
			Description: "Show list columns",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d views", len(views))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledListsList outputs styled list views.
func printStyledListsList(cmd *cobra.Command, views []string, table string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())

	if table != "" {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("List Views for %s", table)))
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("List Views"))
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
			fmt.Sprintf("jsn lists %s --view \"Default view\"", table),
			labelStyle.Render("Show Default view columns"),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownListsList outputs markdown list views.
func printMarkdownListsList(cmd *cobra.Command, views []string, table string) error {
	if table != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "**List Views for %s**\n\n", table)
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "**List Views**")
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

// listsShowFlags holds the flags for lists show mode.
type listsShowFlags struct {
	view string
}

// runListsShow executes the lists show command.
func runListsShow(cmd *cobra.Command, table string, flags listsShowFlags) error {
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

	// Fetch the main list layout for the table/view
	layoutOpts := &sdk.ListListLayoutsOptions{
		TableName: table,
		ViewName:  flags.view,
	}

	layouts, err := sdkClient.ListListLayouts(cmd.Context(), layoutOpts)
	if err != nil {
		return fmt.Errorf("failed to list layouts: %w", err)
	}

	if len(layouts) == 0 {
		return fmt.Errorf("no list layout found for %s with view \"%s\"", table, flags.view)
	}

	mainLayout := layouts[0]

	// Fetch columns for the main list
	elements, err := sdkClient.ListListElements(cmd.Context(), &sdk.ListListElementsOptions{
		ListID: mainLayout.SysID,
	})
	if err != nil {
		return fmt.Errorf("failed to list columns: %w", err)
	}

	// Sort by position
	sort.Slice(elements, func(i, j int) bool {
		return elements[i].Position < elements[j].Position
	})

	// Fetch related lists (with their columns)
	relatedLists, err := sdkClient.ListRelatedLists(cmd.Context(), &sdk.ListRelatedListsOptions{
		ParentTable: table,
		ViewName:    flags.view,
	})
	if err != nil {
		// Non-fatal — show what we have
		relatedLists = nil
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledListLayout(cmd, table, flags.view, elements, relatedLists, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownListLayout(cmd, table, flags.view, elements, relatedLists, instanceURL)
	}

	// Build data for JSON/quiet output
	var columnsData []map[string]interface{}
	for _, elem := range elements {
		col := map[string]interface{}{
			"element":  elem.Element,
			"position": elem.Position,
		}
		if elem.Type != "" {
			col["type"] = elem.Type
		}
		columnsData = append(columnsData, col)
	}

	data := map[string]interface{}{
		"table":   table,
		"view":    flags.view,
		"columns": columnsData,
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
			Cmd:         fmt.Sprintf("jsn lists --table %s", table),
			Description: "List all views",
		},
		{
			Action:      "form",
			Cmd:         fmt.Sprintf("jsn forms %s --view \"%s\"", table, flags.view),
			Description: "Show form layout",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("List: %s (%s) - %d columns, %d related lists", table, flags.view, len(elements), len(relatedLists))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// relatedListDisplayName returns a display name for a related list.
func relatedListDisplayName(rl sdk.RelatedList) string {
	if rl.Layout.Relationship != "" {
		return fmt.Sprintf("%s (%s)", rl.Layout.Relationship, rl.Layout.Name)
	}
	return rl.Layout.Name
}

// ─── Styled Output ──────────────────────────────────────────────────────────

func printStyledListLayout(cmd *cobra.Command, table, view string, elements []sdk.ListElement, relatedLists []sdk.RelatedList, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	posStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))

	w := cmd.OutOrStdout()

	fmt.Fprintln(w)

	// Title
	fmt.Fprintln(w, headerStyle.Render(fmt.Sprintf("%s (%s)", table, view)))
	fmt.Fprintln(w)

	// Columns
	fmt.Fprintln(w, sectionStyle.Render("─ List Columns ─"))
	if len(elements) == 0 {
		fmt.Fprintln(w, labelStyle.Render("  (no columns defined)"))
	} else {
		for i, elem := range elements {
			fmt.Fprintf(w, "  %s  %s\n",
				posStyle.Render(fmt.Sprintf("%2d.", i+1)),
				fieldStyle.Render(elem.Element),
			)
		}
	}
	fmt.Fprintln(w)

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

	// Link to list layout
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_list_list.do?sysparm_query=name%%3D%s%%5Eview%%3D%s", instanceURL, table, view)
		fmt.Fprintf(w, "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("List Layout:"),
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
		fmt.Sprintf("jsn lists --table %s", table),
		labelStyle.Render("List all views"),
	)
	fmt.Fprintf(w, "  %-50s  %s\n",
		fmt.Sprintf("jsn forms %s --view \"%s\"", table, view),
		labelStyle.Render("Show form layout"),
	)

	fmt.Fprintln(w)
	return nil
}

// ─── Markdown Output ────────────────────────────────────────────────────────

func printMarkdownListLayout(cmd *cobra.Command, table, view string, elements []sdk.ListElement, relatedLists []sdk.RelatedList, instanceURL string) error {
	w := cmd.OutOrStdout()

	fmt.Fprintf(w, "**%s (%s)**\n\n", table, view)

	fmt.Fprintln(w, "#### List Columns")
	fmt.Fprintln(w)
	if len(elements) == 0 {
		fmt.Fprintln(w, "*(no columns defined)*")
	} else {
		for i, elem := range elements {
			fmt.Fprintf(w, "%d. %s\n", i+1, elem.Element)
		}
	}
	fmt.Fprintln(w)

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

	// Link to list layout
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_list_list.do?sysparm_query=name%%3D%s%%5Eview%%3D%s", instanceURL, table, view)
		fmt.Fprintf(w, "**List Layout:** [View in ServiceNow](%s)\n\n", link)
	}

	return nil
}
