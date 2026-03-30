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

// portalsListFlags holds the flags for the portals list command.
type portalsListFlags struct {
	limit  int
	search string
	query  string
	order  string
	desc   bool
}

// NewPortalsCmd creates the portals command group.
func NewPortalsCmd() *cobra.Command {
	var flags portalsListFlags

	cmd := &cobra.Command{
		Use:     "sp [<identifier>]",
		Aliases: []string{"portals", "portal"},
		Short:   "Manage Service Portals",
		Long: `List and view ServiceNow Service Portals.

Usage:
  jsn sp                                       Interactive picker (TTY) or usage info
  jsn sp <id_or_sys_id>                        Show portal details
  jsn sp --search <term>                       Fuzzy search on title or url_suffix (LIKE match)
  jsn sp --query <encoded_query>               Raw ServiceNow encoded query

Examples:
  jsn sp itsm
  jsn sp --search itsm
  jsn sp --query "active=true"`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct lookup by identifier
			if len(args) > 0 {
				return runPortalsShow(cmd, args[0])
			}

			// Mode 2 & 3: Search/list (handles interactive picker when no filters)
			return runPortalsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of portals to fetch")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on title or url_suffix")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "title", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")

	return cmd
}

// runPortalsList executes the portals list command.
func runPortalsList(cmd *cobra.Command, flags portalsListFlags) error {
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
		searchQuery := fmt.Sprintf("titleLIKE%s^ORurl_suffixLIKE%s", flags.search, flags.search)
		if query != "" {
			query = searchQuery + "^" + query
		} else {
			query = searchQuery
		}
	}

	opts := &sdk.ListPortalsOptions{
		Limit:     flags.limit,
		Query:     query,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	portals, err := sdkClient.ListPortals(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list portals: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledPortalsList(cmd, portals, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownPortalsList(cmd, portals, instanceURL)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, portal := range portals {
		row := map[string]any{
			"sys_id":      portal.SysID,
			"title":       portal.Title,
			"id":          portal.ID,
			"inactive":    portal.Inactive,
			"description": portal.Description,
			"homepage":    portal.Homepage,
			"theme":       portal.Theme,
			"url_suffix":  portal.URLSuffix,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sp?id=%s", instanceURL, portal.ID)
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn sp <id>",
			Description: "Show portal details",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d portals", len(portals))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledPortalsList outputs styled portals list.
func printStyledPortalsList(cmd *cobra.Command, portals []sdk.Portal, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	brandStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Service Portals"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %-28s %-10s\n",
		headerStyle.Render("Sys ID"),
		mutedStyle.Render("URL Suffix"),
		headerStyle.Render("Title"),
		headerStyle.Render("Status"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Portals
	for _, portal := range portals {
		statusStr := "active"
		if portal.Inactive == "true" {
			statusStr = "inactive"
		}

		// Create hyperlink if instance URL available
		suffixDisplay := portal.URLSuffix
		if instanceURL != "" && portal.URLSuffix != "" {
			link := fmt.Sprintf("%s/sp?sys_id=%s", instanceURL, portal.SysID)
			suffixDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, portal.URLSuffix)
		}

		title := portal.Title
		if len(title) > 26 {
			title = title[:23] + "..."
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %-28s %-10s\n",
			mutedStyle.Render(portal.SysID),
			brandStyle.Render(suffixDisplay),
			title,
			labelStyle.Render(statusStr),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp <id>",
		labelStyle.Render("Show portal details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownPortalsList outputs markdown portals list.
func printMarkdownPortalsList(cmd *cobra.Command, portals []sdk.Portal, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Service Portals**")
	fmt.Fprintln(cmd.OutOrStdout())

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | URL Suffix | Title | Status |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------------|-------|--------|")

	// Portals
	for _, portal := range portals {
		statusStr := "active"
		if portal.Inactive == "true" {
			statusStr = "inactive"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
			portal.SysID, portal.URLSuffix, portal.Title, statusStr)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// runPortalsShow executes the portals show command.
func runPortalsShow(cmd *cobra.Command, id string) error {
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
			return output.ErrUsage("Portal ID is required in non-interactive mode")
		}

		selected, err := pickPortal(cmd.Context(), sdkClient, "Select a portal:")
		if err != nil {
			return err
		}
		id = selected
	}

	portal, err := sdkClient.GetPortal(cmd.Context(), id)
	if err != nil {
		return fmt.Errorf("failed to get portal: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledPortal(cmd, portal, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownPortal(cmd, portal, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         "jsn sp --search <term>",
			Description: "Search portals",
		},
	}

	return outputWriter.OK(portal,
		output.WithSummary(fmt.Sprintf("Portal: %s", portal.Title)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledPortal outputs styled portal details.
func printStyledPortal(cmd *cobra.Command, portal *sdk.Portal, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("%s (%s)", portal.Title, portal.ID)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic Info
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Basic Information ─"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Title:"), valueStyle.Render(portal.Title))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("ID:"), valueStyle.Render(portal.ID))
	statusStr := "active"
	if portal.Inactive == "true" {
		statusStr = "inactive"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Status:"), valueStyle.Render(statusStr))
	if portal.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Description:"), valueStyle.Render(portal.Description))
	}

	// Homepage & Theme
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Configuration ─"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Homepage:"), valueStyle.Render(portal.HomepageID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Theme:"), valueStyle.Render(portal.ThemeName))
	if portal.URLSuffix != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("URL Suffix:"), valueStyle.Render(portal.URLSuffix))
	}

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sp?id=%s", instanceURL, portal.ID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Portal URL:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn sp --search <term>",
		labelStyle.Render("Search portals"),
	)
	if portal.HomepageID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			fmt.Sprintf("jsn sp-pages %s", portal.HomepageID),
			labelStyle.Render("View homepage"),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownPortal outputs markdown portal details.
func printMarkdownPortal(cmd *cobra.Command, portal *sdk.Portal, instanceURL string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**%s (%s)**\n\n", portal.Title, portal.ID)

	statusStr := "active"
	if portal.Inactive == "true" {
		statusStr = "inactive"
	}

	fmt.Fprintln(cmd.OutOrStdout(), "#### Basic Information")
	fmt.Fprintf(cmd.OutOrStdout(), "- **Title:** %s\n", portal.Title)
	fmt.Fprintf(cmd.OutOrStdout(), "- **ID:** %s\n", portal.ID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", statusStr)
	if portal.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", portal.Description)
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\n#### Configuration")
	fmt.Fprintf(cmd.OutOrStdout(), "- **Homepage:** %s\n", portal.HomepageID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Theme:** %s\n", portal.ThemeName)
	if portal.URLSuffix != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **URL Suffix:** %s\n", portal.URLSuffix)
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sp?id=%s", instanceURL, portal.ID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Portal URL:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// pickPortal shows an interactive portal picker and returns the selected portal ID.
func pickPortal(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListPortalsOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		portals, err := sdkClient.ListPortals(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, p := range portals {
			desc := p.Description
			if desc == "" {
				desc = fmt.Sprintf("Theme: %s", p.ThemeName)
			}
			items = append(items, tui.PickerItem{
				ID:          p.ID,
				Title:       fmt.Sprintf("%s (%s)", p.Title, p.ID),
				Description: desc,
			})
		}

		hasMore := len(portals) >= limit
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
