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

// uiPage represents a Classic UI Page (sys_ui_page record).
type uiPage struct {
	SysID            string `json:"sys_id"`
	Name             string `json:"name"`
	Category         string `json:"category"`
	Description      string `json:"description"`
	HTML             string `json:"html"`
	ClientScript     string `json:"client_script"`
	ProcessingScript string `json:"processing_script"`
	Active           bool   `json:"active"`
	Direct           bool   `json:"direct"`
	CreatedOn        string `json:"sys_created_on"`
	UpdatedOn        string `json:"sys_updated_on"`
}

// NewUIPagesCmd creates the uipages command group.
func NewUIPagesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uipages",
		Aliases: []string{"ui-page", "pages"},
		Short:   "Manage Classic UI Pages",
		Long: `List and view Classic UI pages.

Classic UI pages are defined in sys_ui_page and contain HTML, CSS, 
client scripts, and server-side processing scripts. These are the 
older-style UI pages (not Service Portal).

Examples:
  # List all Classic UI pages
  jsn dev uipages list

  # Show page details and code
  jsn dev uipages show "My Page"

  # Show by sys_id
  jsn dev uipages show 1234567890abcdef...`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newUIPagesListCmd(),
		newUIPagesShowCmd(),
	)

	return cmd
}

// newUIPagesListCmd creates the uipages list subcommand
func newUIPagesListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Classic UI pages",
		Long: `List all Classic UI pages.

Examples:
  jsn dev uipages list
  jsn dev uipages list --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listUIPages(ctx, app, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of pages to fetch")

	return cmd
}

// newUIPagesShowCmd creates the uipages show subcommand
func newUIPagesShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [page-name]",
		Short: "Show Classic UI page details",
		Long: `Show detailed Classic UI page including HTML and scripts.

This displays the page structure: HTML, client script, and processing script.

Examples:
  # Show page by name
  jsn dev uipages show "My Page"

  # Show by sys_id
  jsn dev uipages show 1234567890abcdef...`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showUIPage(ctx, app, args[0])
		},
	}

	return cmd
}

// listUIPages lists all Classic UI pages
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listUIPages(ctx context.Context, app *appctx.App, limit int) error {
	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listUIPagesInteractive(ctx, app, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "sys_id,name,category,description,active,direct")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "ORDERBYname")

	records, err := app.SDK.List(ctx, "sys_ui_page", params)
	if err != nil {
		return fmt.Errorf("failed to list UI pages: %w", err)
	}

	// Parse pages
	var pages []uiPage
	for _, record := range records {
		pages = append(pages, uiPage{
			SysID:       getStringValue(record, "sys_id"),
			Name:        getStringValue(record, "name"),
			Category:    getStringValue(record, "category"),
			Description: getStringValue(record, "description"),
			Active:      getBoolValue(record, "active"),
			Direct:      getBoolValue(record, "direct"),
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
		if p.Direct {
			status += " D"
		}
		recordsOut = append(recordsOut, map[string]string{
			"name":     p.Name,
			"category": p.Category,
			"status":   status,
			"sys_id":   p.SysID,
		})
	}

	return app.OK(map[string]any{
		"count":        len(pages),
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d Classic UI page(s)", len(pages))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn dev uipages show <page-name>",
				Description: "Show page details",
			},
		),
	)
}

// showUIPage displays page details and code
func showUIPage(ctx context.Context, app *appctx.App, identifier string) error {
	// Try to find page by name or sys_id
	var page uiPage
	found := false

	// First try by sys_id (32 character hex)
	if len(identifier) == 32 {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,category,description,html,client_script,processing_script,active,direct,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sys_ui_page", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			page = uiPageFromRecord(record)
			found = true
		}
	}

	// If not found, try by name
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,category,description,html,client_script,processing_script,active,direct,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "name="+identifier)

		records, err := app.SDK.List(ctx, "sys_ui_page", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			page = uiPageFromRecord(record)
			found = true
		}
	}

	if !found {
		return fmt.Errorf("UI page not found: %s", identifier)
	}

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUIPage(page)
	}

	// Build data for JSON/Quiet output
	data := map[string]any{
		"page": map[string]any{
			"sys_id":            page.SysID,
			"name":              page.Name,
			"category":          page.Category,
			"description":       page.Description,
			"active":            page.Active,
			"direct":            page.Direct,
			"html":              page.HTML,
			"client_script":     page.ClientScript,
			"processing_script": page.ProcessingScript,
		},
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_ui_page",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("UI Page: %s", page.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev uipages list",
				Description: "List all pages",
			},
		),
	)
}

// uiPageFromRecord converts a record map to a uiPage struct
func uiPageFromRecord(record map[string]any) uiPage {
	return uiPage{
		SysID:            getStringValue(record, "sys_id"),
		Name:             getStringValue(record, "name"),
		Category:         getStringValue(record, "category"),
		Description:      getStringValue(record, "description"),
		HTML:             getStringValue(record, "html"),
		ClientScript:     getStringValue(record, "client_script"),
		ProcessingScript: getStringValue(record, "processing_script"),
		Active:           getBoolValue(record, "active"),
		Direct:           getBoolValue(record, "direct"),
		CreatedOn:        getStringValue(record, "sys_created_on"),
		UpdatedOn:        getStringValue(record, "sys_updated_on"),
	}
}

// printStyledUIPage outputs styled page details.
func printStyledUIPage(page uiPage) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#a8a8a8"))

	fmt.Println()

	// Title
	status := ""
	if !page.Active {
		status = " [INACTIVE]"
	}
	if page.Direct {
		status += " [DIRECT]"
	}
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s%s", page.Name, status)))
	fmt.Println()

	// Details
	if page.Category != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Category"), fieldStyle.Render(page.Category))
	}
	if page.Description != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Description"), fieldStyle.Render(page.Description))
	}
	fmt.Printf("  %s: %s\n", labelStyle.Render("Sys ID"), fieldStyle.Render(page.SysID))
	fmt.Println()

	// HTML
	if page.HTML != "" {
		fmt.Println(sectionStyle.Render("─ HTML ─"))
		lines := strings.Split(page.HTML, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// Client Script
	if page.ClientScript != "" {
		fmt.Println(sectionStyle.Render("─ Client Script ─"))
		lines := strings.Split(page.ClientScript, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// Processing Script
	if page.ProcessingScript != "" {
		fmt.Println(sectionStyle.Render("─ Processing Script ─"))
		lines := strings.Split(page.ProcessingScript, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		"jsn dev uipages list",
		labelStyle.Render("List all pages"),
	)

	fmt.Println()
	return nil
}

// listUIPagesInteractive shows an interactive picker for Classic UI pages
func listUIPagesInteractive(ctx context.Context, app *appctx.App, pageSize int) error {
	// Create a reusable list fetcher configured for UI pages
	fetcher := tui.NewListFetcher("sys_ui_page").
		WithColumns("name", "category", "active").
		WithOrderBy("ORDERBYname").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringValue(record, "name")
			category := getStringValue(record, "category")
			sysID := getStringValue(record, "sys_id")

			display := name
			if category != "" {
				display = fmt.Sprintf("%s [%s]", name, category)
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
		// Extract the page name from the title format "name [category]"
		title := selected.Title
		if idx := strings.Index(title, " ["); idx > 0 {
			return showUIPage(ctx, app, title[:idx])
		}
		// Fallback: use the full title
		return showUIPage(ctx, app, title)
	}

	// User cancelled
	return nil
}
