package commands

import (
	"context"
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// pagesListFlags holds the flags for the pages list command.
type pagesListFlags struct {
	limit  int
	search string
	query  string
	order  string
	desc   bool
}

// NewPagesCmd creates the pages command group.
func NewPagesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "sp-pages",
		Aliases: []string{"sp-page", "pages", "page"},
		Short:   "Manage Service Portal Pages",
		Long:    "List and view ServiceNow Service Portal Pages with their widget instances.",
	}

	cmd.AddCommand(
		newPagesListCmd(),
		newPagesShowCmd(),
	)

	return cmd
}

// newPagesListCmd creates the pages list command.
func newPagesListCmd() *cobra.Command {
	var flags pagesListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Service Portal Pages",
		Long: `List all ServiceNow Service Portal Pages.

Filtering:
  --search <term>   Fuzzy search on id or title (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering

Examples:
  jsn sp-pages list
  jsn sp-pages list --search index
  jsn sp-pages list --limit 50
  jsn sp-pages list --query "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPagesList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of pages to fetch")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on id or title")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "name" for alphabetical browsing - most intuitive for finding pages
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")

	return cmd
}

// runPagesList executes the pages list command.
func runPagesList(cmd *cobra.Command, flags pagesListFlags) error {
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

	// Build query with search support
	query := flags.query
	if flags.search != "" {
		searchQuery := fmt.Sprintf("idLIKE%s^ORtitleLIKE%s", flags.search, flags.search)
		if query != "" {
			query = searchQuery + "^" + query
		} else {
			query = searchQuery
		}
	}

	opts := &sdk.ListPagesOptions{
		Limit:     flags.limit,
		Query:     query,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	pages, err := sdkClient.ListPages(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list pages: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledPagesList(cmd, pages, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownPagesList(cmd, pages, instanceURL)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, page := range pages {
		displayName := page.Title
		if displayName == "" {
			displayName = page.ID
		}
		row := map[string]any{
			"sys_id":       page.SysID,
			"id":           page.ID,
			"title":        page.Title,
			"active":       page.Active,
			"description":  page.Description,
			"theme":        page.ThemeName,
			"draft":        page.Draft,
			"display_name": displayName,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/$spd.do#/sp_config/editor/%s/", instanceURL, page.ID)
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn sp-pages show <id>",
			Description: "Show page details with widgets",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d pages", len(pages))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledPagesList outputs styled pages list.
func printStyledPagesList(cmd *cobra.Command, pages []sdk.Page, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	brandStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Service Portal Pages"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-25s %-28s %-10s %s\n",
		headerStyle.Render("Sys ID"),
		mutedStyle.Render("ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Active"),
		headerStyle.Render("Theme"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Pages
	for _, page := range pages {
		activeStr := "✓"
		if !page.Active {
			activeStr = "✗"
		}

		// Create hyperlink if instance URL available
		idDisplay := page.ID
		if instanceURL != "" {
			link := fmt.Sprintf("%s/$spd.do#/sp_config/editor/%s/", instanceURL, page.ID)
			idDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, page.ID)
		}

		displayName := page.Title
		if displayName == "" {
			displayName = page.ID
		}
		if len(displayName) > 26 {
			displayName = displayName[:23] + "..."
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-25s %-28s %-10s %s\n",
			mutedStyle.Render(page.SysID),
			brandStyle.Render(idDisplay),
			displayName,
			activeStr,
			labelStyle.Render(page.ThemeName),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp-pages show <id>",
		labelStyle.Render("Show page details with widget instances"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownPagesList outputs markdown pages list.
func printMarkdownPagesList(cmd *cobra.Command, pages []sdk.Page, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Service Portal Pages**")
	fmt.Fprintln(cmd.OutOrStdout())

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | ID | Title | Active | Theme |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|-------|-------|--------|-------|")

	// Pages
	for _, page := range pages {
		activeStr := "Yes"
		if !page.Active {
			activeStr = "No"
		}
		displayName := page.Title
		if displayName == "" {
			displayName = page.ID
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s |\n",
			page.SysID, page.ID, displayName, activeStr, page.ThemeName)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newPagesShowCmd creates the pages show command.
func newPagesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [<identifier>]",
		Short: "Show page details with widget instances",
		Long: `Display detailed information about a Service Portal Page including all widget instances.

The identifier can be a page ID (e.g., "index") or sys_id.
If no identifier is provided, an interactive picker will help you select one.

Examples:
  jsn sp-pages show index
  jsn sp-pages show 0123456789abcdef0123456789abcdef`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			}
			return runPagesShow(cmd, id)
		},
	}

	return cmd
}

// runPagesShow executes the pages show command.
func runPagesShow(cmd *cobra.Command, id string) error {
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

	// Interactive picker if no ID provided
	if id == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Page ID is required in non-interactive mode")
		}

		selected, err := pickPage(cmd.Context(), sdkClient, "Select a page:")
		if err != nil {
			return err
		}
		id = selected
	}

	page, err := sdkClient.GetPage(cmd.Context(), id)
	if err != nil {
		return fmt.Errorf("failed to get page: %w", err)
	}

	// Fetch widget instances for this page
	instanceOpts := &sdk.ListWidgetInstancesOptions{
		PageID:  page.SysID,
		Limit:   100,
		OrderBy: "order",
	}
	instances, err := sdkClient.ListWidgetInstances(cmd.Context(), instanceOpts)
	if err != nil {
		// Don't fail if we can't get instances, just show page info
		instances = []sdk.WidgetInstance{}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledPage(cmd, page, instances, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownPage(cmd, page, instances, instanceURL)
	}

	// Build response data
	data := map[string]interface{}{
		"page":      page,
		"instances": instances,
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         "jsn sp-pages list",
			Description: "List all pages",
		},
		{
			Action:      "widget",
			Cmd:         "jsn sp-widgets show <id>",
			Description: "View widget details",
		},
	}

	displayName := page.Title
	if displayName == "" {
		displayName = page.ID
	}
	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Page: %s (%d widgets)", displayName, len(instances))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledPage outputs styled page details with widget instances.
func printStyledPage(cmd *cobra.Command, page *sdk.Page, instances []sdk.WidgetInstance, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	displayName := page.Title
	if displayName == "" {
		displayName = page.ID
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("%s (%s)", displayName, page.ID)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic Info
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Page Information ─"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("ID:"), valueStyle.Render(page.ID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Title:"), valueStyle.Render(page.Title))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Active:"), valueStyle.Render(fmt.Sprintf("%v", page.Active)))
	if page.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Description:"), valueStyle.Render(page.Description))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Theme:"), valueStyle.Render(page.ThemeName))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Draft:"), valueStyle.Render(fmt.Sprintf("%v", page.Draft)))

	// Widget Instances
	if len(instances) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render(fmt.Sprintf("─ Widget Instances (%d) ─", len(instances))))
		fmt.Fprintln(cmd.OutOrStdout())

		// Column headers
		fmt.Fprintf(cmd.OutOrStdout(), "  %-5s %-25s %-30s %s\n",
			mutedStyle.Render("Order"),
			mutedStyle.Render("Widget ID"),
			mutedStyle.Render("Widget Name"),
			mutedStyle.Render("Title"),
		)
		fmt.Fprintln(cmd.OutOrStdout())

		// Instances
		for _, inst := range instances {
			widgetID := inst.WidgetID
			if instanceURL != "" {
				link := fmt.Sprintf("%s/sp_widget.do?sys_id=%s", instanceURL, inst.Widget)
				widgetID = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, inst.WidgetID)
			}

			title := inst.Title
			if title == "" {
				title = "-"
			}

			fmt.Fprintf(cmd.OutOrStdout(), "  %-5d %-25s %-30s %s\n",
				inst.Order,
				lipgloss.NewStyle().Foreground(output.BrandColor).Render(widgetID),
				inst.WidgetName,
				labelStyle.Render(title),
			)
		}
	} else {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("  No widget instances on this page."))
	}

	// Links
	if instanceURL != "" {
		designerLink := fmt.Sprintf("%s/$spd.do#/sp_config/editor/%s/", instanceURL, page.ID)
		visualTreeLink := fmt.Sprintf("%s/sp_config?id=page_edit&p=%s", instanceURL, page.ID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Designer:"),
			designerLink,
			designerLink,
		)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Visual Tree:"),
			visualTreeLink,
			visualTreeLink,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp-pages list",
		labelStyle.Render("List all pages"),
	)
	if len(instances) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			"jsn sp-widgets show <widget_id>",
			labelStyle.Render("View widget details"),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownPage outputs markdown page details.
func printMarkdownPage(cmd *cobra.Command, page *sdk.Page, instances []sdk.WidgetInstance, instanceURL string) error {
	displayName := page.Title
	if displayName == "" {
		displayName = page.ID
	}
	fmt.Fprintf(cmd.OutOrStdout(), "**%s (%s)**\n\n", displayName, page.ID)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Page Information")
	fmt.Fprintf(cmd.OutOrStdout(), "- **ID:** %s\n", page.ID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Title:** %s\n", page.Title)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Active:** %v\n", page.Active)
	if page.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", page.Description)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Theme:** %s\n", page.ThemeName)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Draft:** %v\n", page.Draft)

	if len(instances) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "\n#### Widget Instances (%d)\n\n", len(instances))
		fmt.Fprintln(cmd.OutOrStdout(), "| Order | Widget ID | Widget Name | Title |")
		fmt.Fprintln(cmd.OutOrStdout(), "|-------|-----------|-------------|-------|")
		for _, inst := range instances {
			title := inst.Title
			if title == "" {
				title = "-"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "| %d | %s | %s | %s |\n",
				inst.Order, inst.WidgetID, inst.WidgetName, title)
		}
	}

	if instanceURL != "" {
		designerLink := fmt.Sprintf("%s/$spd.do#/sp_config/editor/%s/", instanceURL, page.ID)
		visualTreeLink := fmt.Sprintf("%s/sp_config?id=page_edit&p=%s", instanceURL, page.ID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n**Designer:** %s\n", designerLink)
		fmt.Fprintf(cmd.OutOrStdout(), "**Visual Tree:** %s\n", visualTreeLink)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// pickPage shows an interactive page picker and returns the selected page ID.
func pickPage(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListPagesOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		pages, err := sdkClient.ListPages(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, p := range pages {
			displayName := p.Title
			if displayName == "" {
				displayName = p.ID
			}
			desc := p.Description
			if desc == "" {
				desc = fmt.Sprintf("Theme: %s", p.ThemeName)
			}
			items = append(items, tui.PickerItem{
				ID:          p.ID,
				Title:       fmt.Sprintf("%s (%s)", displayName, p.ID),
				Description: desc,
			})
		}

		hasMore := len(pages) >= limit
		return &tui.PageResult{
			Items:   items,
			HasMore: hasMore,
		}, nil
	}

	selected, err := tui.PickWithPagination(title, fetcher, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", fmt.Errorf("selection cancelled")
	}

	return selected.ID, nil
}

// mutedStyle is used in printStyledPage
var mutedStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
