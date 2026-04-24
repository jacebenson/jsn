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

// spPage represents a Service Portal page (sp_page record).
type spPage struct {
	SysID       string `json:"sys_id"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
	Draft       bool   `json:"draft"`
	Theme       string `json:"theme"`
	ThemeName   string `json:"theme.name"`
}

// spWidgetInstance represents a widget instance on a page (sp_instance record).
type spWidgetInstance struct {
	SysID      string `json:"sys_id"`
	Page       string `json:"sp_page"`
	Widget     string `json:"sp_widget"`
	WidgetName string `json:"widget.name"`
	WidgetID   string `json:"widget.id"`
	Title      string `json:"title"`
	Order      int    `json:"order"`
	Active     bool   `json:"active"`
}

// NewSPPagesCmd creates the sppages command group.
func NewSPPagesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "sppages",
		Aliases: []string{"sp-pages", "pages"},
		Short:   "Manage Service Portal Pages",
		Long: `List and view Service Portal pages and their widget layouts.

Service Portal pages are defined in sp_page and contain widget instances
(sp_instance) arranged in containers, rows, and columns.

Examples:
  # List all Service Portal pages
  jsn dev sppages list

  # Show page details and widget layout
  jsn dev sppages show index

  # Show by sys_id
  jsn dev sppages show 1234567890abcdef...`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newSPPagesListCmd(),
		newSPPagesShowCmd(),
	)

	return cmd
}

// newSPPagesListCmd creates the sppages list subcommand
func newSPPagesListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Service Portal pages",
		Long: `List all Service Portal pages.

Examples:
  jsn dev sppages list
  jsn dev sppages list --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listSPPages(ctx, app, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of pages to fetch")

	return cmd
}

// newSPPagesShowCmd creates the sppages show subcommand
func newSPPagesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [page-id]",
		Short: "Show Service Portal page layout",
		Long: `Show detailed Service Portal page layout including widgets.

This displays the page structure: widgets in order.
Much faster than clicking through the Service Portal Designer.

Examples:
  # Show page by ID
  jsn dev sppages show index

  # Show by sys_id
  jsn dev sppages show 1234567890abcdef...`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showSPPage(ctx, app, args[0])
		},
	}

	return cmd
}

// listSPPages lists all Service Portal pages
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listSPPages(ctx context.Context, app *appctx.App, limit int) error {
	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listSPPagesInteractive(ctx, app, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "sys_id,id,name,title,description,active,draft,theme")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "ORDERBYname")

	records, err := app.SDK.List(ctx, "sp_page", params)
	if err != nil {
		return fmt.Errorf("failed to list pages: %w", err)
	}

	// Parse pages
	var pages []spPage
	for _, record := range records {
		pages = append(pages, spPage{
			SysID:       getStringValue(record, "sys_id"),
			ID:          getStringValue(record, "id"),
			Name:        getStringValue(record, "name"),
			Title:       getStringValue(record, "title"),
			Description: getStringValue(record, "description"),
			Active:      getBoolValue(record, "active"),
			Draft:       getBoolValue(record, "draft"),
			Theme:       getStringValue(record, "theme"),
		})
	}

	// Sort by name
	sort.Slice(pages, func(i, j int) bool {
		return pages[i].Name < pages[j].Name
	})

	// Build records as []map[string]string for styled output
	var recordsOut []map[string]string
	for _, p := range pages {
		status := "✓"
		if !p.Active {
			status = "✗"
		}
		if p.Draft {
			status = "📝"
		}
		recordsOut = append(recordsOut, map[string]string{
			"id":     p.ID,
			"name":   p.Name,
			"title":  p.Title,
			"status": status,
			"sys_id": p.SysID,
		})
	}

	return app.OK(map[string]any{
		"count":        len(pages),
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d Service Portal page(s)", len(pages))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn dev sppages show <page-id>",
				Description: "Show page layout",
			},
		),
	)
}

// showSPPage displays page details and widget layout
func showSPPage(ctx context.Context, app *appctx.App, identifier string) error {
	// Try to find page by ID or sys_id
	var page spPage
	found := false

	// First try by sys_id (32 character hex)
	if len(identifier) == 32 {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,id,name,title,description,active,draft,theme")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sp_page", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			page = spPage{
				SysID:       getStringValue(record, "sys_id"),
				ID:          getStringValue(record, "id"),
				Name:        getStringValue(record, "name"),
				Title:       getStringValue(record, "title"),
				Description: getStringValue(record, "description"),
				Active:      getBoolValue(record, "active"),
				Draft:       getBoolValue(record, "draft"),
				Theme:       getStringValue(record, "theme"),
			}
			found = true
		}
	}

	// If not found, try by ID field
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,id,name,title,description,active,draft,theme")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "id="+identifier)

		records, err := app.SDK.List(ctx, "sp_page", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			page = spPage{
				SysID:       getStringValue(record, "sys_id"),
				ID:          getStringValue(record, "id"),
				Name:        getStringValue(record, "name"),
				Title:       getStringValue(record, "title"),
				Description: getStringValue(record, "description"),
				Active:      getBoolValue(record, "active"),
				Draft:       getBoolValue(record, "draft"),
				Theme:       getStringValue(record, "theme"),
			}
			found = true
		}
	}

	// If still not found, try by name
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,id,name,title,description,active,draft,theme")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "name="+identifier)

		records, err := app.SDK.List(ctx, "sp_page", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			page = spPage{
				SysID:       getStringValue(record, "sys_id"),
				ID:          getStringValue(record, "id"),
				Name:        getStringValue(record, "name"),
				Title:       getStringValue(record, "title"),
				Description: getStringValue(record, "description"),
				Active:      getBoolValue(record, "active"),
				Draft:       getBoolValue(record, "draft"),
				Theme:       getStringValue(record, "theme"),
			}
			found = true
		}
	}

	if !found {
		return fmt.Errorf("page not found: %s", identifier)
	}

	// Fetch widget instances
	var instances []spWidgetInstance
	instParams := url.Values{}
	instParams.Set("sysparm_limit", "100")
	instParams.Set("sysparm_fields", "sys_id,sp_page,sp_widget,title,order,active")
	instParams.Set("sysparm_display_value", "all")
	instParams.Set("sysparm_query", "sp_page="+page.SysID+"^ORDERBYorder")

	instRecords, err := app.SDK.List(ctx, "sp_instance", instParams)
	if err == nil {
		for _, record := range instRecords {
			instances = append(instances, spWidgetInstance{
				SysID:      getStringValue(record, "sys_id"),
				Page:       getStringValue(record, "sp_page"),
				Widget:     getStringValue(record, "sp_widget"),
				WidgetName: getDisplayValue(record, "sp_widget"),
				Title:      getStringValue(record, "title"),
				Order:      getIntValue(record, "order"),
				Active:     getBoolValue(record, "active"),
			})
		}
	}

	// Sort by order
	sort.Slice(instances, func(i, j int) bool {
		return instances[i].Order < instances[j].Order
	})

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledSPPage(page, instances)
	}

	// Build data for JSON/Quiet output
	var widgetsData []map[string]any
	for _, inst := range instances {
		widgetsData = append(widgetsData, map[string]any{
			"sys_id":      inst.SysID,
			"widget_name": inst.WidgetName,
			"widget_id":   inst.Widget,
			"title":       inst.Title,
			"order":       inst.Order,
			"active":      inst.Active,
		})
	}

	data := map[string]any{
		"page": map[string]any{
			"sys_id":      page.SysID,
			"id":          page.ID,
			"name":        page.Name,
			"title":       page.Title,
			"description": page.Description,
			"active":      page.Active,
			"draft":       page.Draft,
			"theme":       page.Theme,
		},
		"widgets": widgetsData,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sp_page",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("Page: %s (%s) - %d widgets", page.Name, page.ID, len(instances))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev sppages list",
				Description: "List all pages",
			},
		),
	)
}

// printStyledSPPage outputs styled page layout.
func printStyledSPPage(page spPage, instances []spWidgetInstance) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	posStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))

	fmt.Println()

	// Title
	status := ""
	if !page.Active {
		status = " [INACTIVE]"
	}
	if page.Draft {
		status = " [DRAFT]"
	}
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s (%s)%s", page.Name, page.ID, status)))
	fmt.Println()

	// Page details
	if page.Title != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Title"), fieldStyle.Render(page.Title))
	}
	if page.Description != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Description"), fieldStyle.Render(page.Description))
	}
	if page.Theme != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Theme"), fieldStyle.Render(page.Theme))
	}
	fmt.Printf("  %s: %s\n", labelStyle.Render("Sys ID"), fieldStyle.Render(page.SysID))
	fmt.Println()

	// Widgets
	fmt.Println(sectionStyle.Render("─ Widgets ─"))
	if len(instances) == 0 {
		fmt.Println(labelStyle.Render("  (no widgets)"))
	} else {
		for i, inst := range instances {
			status := ""
			if !inst.Active {
				status = " [inactive]"
			}
			title := inst.WidgetName
			if inst.Title != "" {
				title = fmt.Sprintf("%s (%s)", inst.Title, inst.WidgetName)
			}
			fmt.Printf("  %s  %s%s\n",
				posStyle.Render(fmt.Sprintf("%2d.", i+1)),
				fieldStyle.Render(title),
				labelStyle.Render(status),
			)
		}
	}
	fmt.Println()

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		"jsn dev sppages list",
		labelStyle.Render("List all pages"),
	)

	fmt.Println()
	return nil
}

// listSPPagesInteractive shows an interactive picker for Service Portal pages
func listSPPagesInteractive(ctx context.Context, app *appctx.App, pageSize int) error {
	// Create a reusable list fetcher configured for SP pages
	fetcher := tui.NewListFetcher("sp_page").
		WithColumns("id", "name", "title", "active").
		WithOrderBy("ORDERBYname").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			id := getStringValue(record, "id")
			name := getStringValue(record, "name")
			title := getStringValue(record, "title")
			sysID := getStringValue(record, "sys_id")

			display := name
			if title != "" && title != name {
				display = fmt.Sprintf("%s (%s)", name, title)
			}
			if id != "" {
				display = fmt.Sprintf("[%s] %s", id, display)
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: display,
			}
		})

	// Show the interactive picker
	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	// If user selected a page, show its details
	if selected != nil {
		// Extract the page ID from the title format "[id] name (title)"
		title := selected.Title
		if strings.HasPrefix(title, "[") {
			// Extract ID from between brackets
			end := strings.Index(title, "]")
			if end > 0 {
				return showSPPage(ctx, app, title[1:end])
			}
		}
		// Fallback: try to use sys_id
		return showSPPage(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}
