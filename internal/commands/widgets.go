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

// widgetsListFlags holds the flags for the widgets list command.
type widgetsListFlags struct {
	limit  int
	search string
	query  string
	order  string
	desc   bool
}

// NewWidgetsCmd creates the widgets command group.
func NewWidgetsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "sp-widgets",
		Aliases: []string{"sp-widget", "widgets", "widget"},
		Short:   "Manage Service Portal Widgets",
		Long:    "List and view ServiceNow Service Portal Widgets (global, not portal-specific).",
	}

	cmd.AddCommand(
		newWidgetsListCmd(),
		newWidgetsShowCmd(),
	)

	return cmd
}

// newWidgetsListCmd creates the widgets list command.
func newWidgetsListCmd() *cobra.Command {
	var flags widgetsListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Service Portal Widgets",
		Long: `List all ServiceNow Service Portal Widgets.

These are global widgets that can be used across all portals.

Filtering:
  --search <term>   Fuzzy search on name or id (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering

Examples:
  jsn sp-widgets list
  jsn sp-widgets list --search kb
  jsn sp-widgets list --limit 50
  jsn sp-widgets list --query "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWidgetsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of widgets to fetch")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on name or id")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "name" for alphabetical browsing - most intuitive for finding widgets
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")

	return cmd
}

// runWidgetsList executes the widgets list command.
func runWidgetsList(cmd *cobra.Command, flags widgetsListFlags) error {
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
		searchQuery := fmt.Sprintf("nameLIKE%s^ORidLIKE%s", flags.search, flags.search)
		if query != "" {
			query = searchQuery + "^" + query
		} else {
			query = searchQuery
		}
	}

	opts := &sdk.ListWidgetsOptions{
		Limit:     flags.limit,
		Query:     query,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	widgets, err := sdkClient.ListWidgets(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list widgets: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledWidgetsList(cmd, widgets, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownWidgetsList(cmd, widgets, instanceURL)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, widget := range widgets {
		row := map[string]any{
			"sys_id":      widget.SysID,
			"name":        widget.Name,
			"id":          widget.ID,
			"description": widget.Description,
			"scope":       widget.Scope,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sp_widget.do?sys_id=%s", instanceURL, widget.SysID)
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn sp-widgets show <id>",
			Description: "Show widget details",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d widgets", len(widgets))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledWidgetsList outputs styled widgets list.
func printStyledWidgetsList(cmd *cobra.Command, widgets []sdk.Widget, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	brandStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Service Portal Widgets"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-25s %-30s %s\n",
		headerStyle.Render("Sys ID"),
		mutedStyle.Render("Widget ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Scope"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Widgets
	for _, widget := range widgets {
		// Use ID if available, otherwise show sys_id truncated
		displayID := widget.ID
		if displayID == "" && len(widget.SysID) >= 8 {
			displayID = widget.SysID[:8] + "..."
		} else if displayID == "" {
			displayID = widget.SysID
		}

		// Create hyperlink if instance URL available
		idDisplay := displayID
		if instanceURL != "" {
			link := fmt.Sprintf("%s/sp_widget.do?sys_id=%s", instanceURL, widget.SysID)
			idDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, displayID)
		}

		name := widget.Name
		if len(name) > 28 {
			name = name[:25] + "..."
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-25s %-30s %s\n",
			mutedStyle.Render(widget.SysID),
			brandStyle.Render(idDisplay),
			name,
			labelStyle.Render(widget.Scope),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp-widgets show <id>",
		labelStyle.Render("Show widget details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownWidgetsList outputs markdown widgets list.
func printMarkdownWidgetsList(cmd *cobra.Command, widgets []sdk.Widget, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Service Portal Widgets**")
	fmt.Fprintln(cmd.OutOrStdout())

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Widget ID | Name | Scope |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|-----------|------|-------|")

	// Widgets
	for _, widget := range widgets {
		displayID := widget.ID
		if displayID == "" && len(widget.SysID) >= 8 {
			displayID = widget.SysID[:8] + "..."
		} else if displayID == "" {
			displayID = widget.SysID
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
			widget.SysID, displayID, widget.Name, widget.Scope)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newWidgetsShowCmd creates the widgets show command.
func newWidgetsShowCmd() *cobra.Command {
	var showFlags struct {
		html   bool
		css    bool
		client bool
		server bool
		link   bool
	}

	cmd := &cobra.Command{
		Use:   "show [<identifier>]",
		Short: "Show widget details",
		Long: `Display detailed information about a Service Portal Widget.

The identifier can be a widget ID (e.g., "kb-list") or sys_id.
If no identifier is provided, an interactive picker will help you select one.

Use --html, --css, --client, --server flags to show specific code fields.
If no code flags are provided, only basic info is shown.

Examples:
  jsn sp-widgets show kb-list
  jsn sp-widgets show 0123456789abcdef0123456789abcdef
  jsn sp-widgets show kb-list --html --css
  jsn sp-widgets show kb-list --client --server`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			}
			return runWidgetsShow(cmd, id, showFlags)
		},
	}

	cmd.Flags().BoolVar(&showFlags.html, "html", false, "Show HTML template")
	cmd.Flags().BoolVar(&showFlags.css, "css", false, "Show CSS")
	cmd.Flags().BoolVar(&showFlags.client, "client", false, "Show client script")
	cmd.Flags().BoolVar(&showFlags.server, "server", false, "Show server script")
	cmd.Flags().BoolVar(&showFlags.link, "link", false, "Show link function")

	return cmd
}

// runWidgetsShow executes the widgets show command.
func runWidgetsShow(cmd *cobra.Command, id string, flags struct {
	html   bool
	css    bool
	client bool
	server bool
	link   bool
}) error {
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
			return output.ErrUsage("Widget ID is required in non-interactive mode")
		}

		selected, err := pickWidget(cmd.Context(), sdkClient, "Select a widget:")
		if err != nil {
			return err
		}
		id = selected
	}

	widget, err := sdkClient.GetWidget(cmd.Context(), id)
	if err != nil {
		return fmt.Errorf("failed to get widget: %w", err)
	}

	// Check if any code flags are set
	showCode := flags.html || flags.css || flags.client || flags.server || flags.link

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		if showCode {
			return printStyledWidgetCode(cmd, widget, flags)
		}
		return printStyledWidget(cmd, widget, instanceURL)
	}

	if format == output.FormatMarkdown {
		if showCode {
			return printMarkdownWidgetCode(cmd, widget, flags)
		}
		return printMarkdownWidget(cmd, widget, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         "jsn sp-widgets list",
			Description: "List all widgets",
		},
	}

	return outputWriter.OK(widget,
		output.WithSummary(fmt.Sprintf("Widget: %s", widget.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledWidget outputs styled widget details.
func printStyledWidget(cmd *cobra.Command, widget *sdk.Widget, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title - show ID only if it exists
	title := widget.Name
	if widget.ID != "" {
		title = fmt.Sprintf("%s (%s)", widget.Name, widget.ID)
	}
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic Info
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Basic Information ─"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Name:"), valueStyle.Render(widget.Name))
	if widget.ID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("ID:"), valueStyle.Render(widget.ID))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Scope:"), valueStyle.Render(widget.Scope))
	if widget.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Description:"), valueStyle.Render(widget.Description))
	}

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sp_widget.do?sys_id=%s", instanceURL, widget.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Widget URL:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	hintID := widget.ID
	if hintID == "" {
		hintID = widget.SysID
	}
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp-widgets list",
		labelStyle.Render("List all widgets"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn sp-widgets show %s --html", hintID),
		labelStyle.Render("Show HTML template"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn sp-widgets show %s --css", hintID),
		labelStyle.Render("Show CSS"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn sp-widgets show %s --client", hintID),
		labelStyle.Render("Show client script"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn sp-widgets show %s --server", hintID),
		labelStyle.Render("Show server script"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn sp-widgets show %s --html --css --client --server", hintID),
		labelStyle.Render("Show all code"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownWidget outputs markdown widget details.
func printMarkdownWidget(cmd *cobra.Command, widget *sdk.Widget, instanceURL string) error {
	// Show ID only if it exists
	title := widget.Name
	if widget.ID != "" {
		title = fmt.Sprintf("%s (%s)", widget.Name, widget.ID)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Basic Information")
	fmt.Fprintf(cmd.OutOrStdout(), "- **Name:** %s\n", widget.Name)
	if widget.ID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **ID:** %s\n", widget.ID)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", widget.Scope)
	if widget.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", widget.Description)
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sp_widget.do?sys_id=%s", instanceURL, widget.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Widget URL:** %s\n", link)
	}

	// Hints
	hintID := widget.ID
	if hintID == "" {
		hintID = widget.SysID
	}
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "#### View Code")
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn sp-widgets show %s --html` - HTML template\n", hintID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn sp-widgets show %s --css` - CSS\n", hintID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn sp-widgets show %s --client` - Client script\n", hintID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn sp-widgets show %s --server` - Server script\n", hintID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn sp-widgets show %s --html --css --client --server` - All code\n", hintID)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printStyledWidgetCode outputs styled widget with code fields.
func printStyledWidgetCode(cmd *cobra.Command, widget *sdk.Widget, flags struct {
	html   bool
	css    bool
	client bool
	server bool
	link   bool
}) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#a6e22e")) // Green for code

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	title := widget.Name
	if widget.ID != "" {
		title = fmt.Sprintf("%s (%s)", widget.Name, widget.ID)
	}
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	// Show requested code sections
	if flags.html {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ HTML Template ─"))
		if widget.Template != "" {
			fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(widget.Template))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if flags.css {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ CSS ─"))
		if widget.CSS != "" {
			fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(widget.CSS))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if flags.client {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Client Script ─"))
		if widget.ClientScript != "" {
			fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(widget.ClientScript))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if flags.server {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Server Script ─"))
		if widget.ServerScript != "" {
			fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(widget.ServerScript))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if flags.link {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Link Function ─"))
		if widget.Link != "" {
			fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(widget.Link))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// printMarkdownWidgetCode outputs markdown widget with code fields.
func printMarkdownWidgetCode(cmd *cobra.Command, widget *sdk.Widget, flags struct {
	html   bool
	css    bool
	client bool
	server bool
	link   bool
}) error {
	title := widget.Name
	if widget.ID != "" {
		title = fmt.Sprintf("%s (%s)", widget.Name, widget.ID)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", title)

	if flags.html {
		fmt.Fprintln(cmd.OutOrStdout(), "#### HTML Template")
		if widget.Template != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "```html\n%s\n```\n\n", widget.Template)
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	if flags.css {
		fmt.Fprintln(cmd.OutOrStdout(), "#### CSS")
		if widget.CSS != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "```css\n%s\n```\n\n", widget.CSS)
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	if flags.client {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Client Script")
		if widget.ClientScript != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "```javascript\n%s\n```\n\n", widget.ClientScript)
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	if flags.server {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Server Script")
		if widget.ServerScript != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "```javascript\n%s\n```\n\n", widget.ServerScript)
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	if flags.link {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Link Function")
		if widget.Link != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "```javascript\n%s\n```\n\n", widget.Link)
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	return nil
}

// pickWidget shows an interactive widget picker and returns the selected widget ID.
func pickWidget(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListWidgetsOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		widgets, err := sdkClient.ListWidgets(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, w := range widgets {
			desc := w.Description
			if desc == "" {
				desc = fmt.Sprintf("Scope: %s", w.Scope)
			}
			// Use sys_id as ID if widget ID is empty
			id := w.ID
			if id == "" {
				id = w.SysID
			}
			// Build title - only show ID in parentheses if it exists
			title := w.Name
			if w.ID != "" {
				title = fmt.Sprintf("%s (%s)", w.Name, w.ID)
			}
			items = append(items, tui.PickerItem{
				ID:          id,
				Title:       title,
				Description: desc,
			})
		}

		hasMore := len(widgets) >= limit
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
