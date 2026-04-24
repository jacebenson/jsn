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

// spWidget represents a Service Portal Widget (sp_widget record).
type spWidget struct {
	SysID        string `json:"sys_id"`
	Name         string `json:"name"`
	ID           string `json:"id"`
	Description  string `json:"description"`
	Template     string `json:"template"`
	CSS          string `json:"css"`
	ClientScript string `json:"client_script"`
	ServerScript string `json:"script"`
	Active       bool   `json:"active"`
	CreatedOn    string `json:"sys_created_on"`
	UpdatedOn    string `json:"sys_updated_on"`
}

// NewSPWidgetsCmd creates the spwidgets command group.
func NewSPWidgetsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "spwidgets",
		Aliases: []string{"sp-widget", "widgets"},
		Short:   "Manage Service Portal Widgets",
		Long: `List and view Service Portal widgets.

Service Portal widgets are reusable components defined in sp_widget.
They contain HTML templates, CSS, client scripts, and server-side scripts.

Examples:
  # List all Service Portal widgets
  jsn dev spwidgets list

  # Show widget details and code
  jsn dev spwidgets show "My Widget"

  # Show by sys_id
  jsn dev spwidgets show 1234567890abcdef...`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newSPWidgetsListCmd(),
		newSPWidgetsShowCmd(),
	)

	return cmd
}

// newSPWidgetsListCmd creates the spwidgets list subcommand
func newSPWidgetsListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Service Portal widgets",
		Long: `List all Service Portal widgets.

Examples:
  jsn dev spwidgets list
  jsn dev spwidgets list --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listSPWidgets(ctx, app, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of widgets to fetch")

	return cmd
}

// newSPWidgetsShowCmd creates the spwidgets show subcommand
func newSPWidgetsShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [widget-id]",
		Short: "Show Service Portal widget details",
		Long: `Show detailed Service Portal widget including code.

This displays the widget structure: HTML template, CSS, 
client script, and server script.

Examples:
  # Show widget by ID
  jsn dev spwidgets show "My Widget"

  # Show by sys_id
  jsn dev spwidgets show 1234567890abcdef...`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showSPWidget(ctx, app, args[0])
		},
	}

	return cmd
}

// listSPWidgets lists all Service Portal widgets
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listSPWidgets(ctx context.Context, app *appctx.App, limit int) error {
	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listSPWidgetsInteractive(ctx, app, limit)
	}

	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "sys_id,name,id,description,active")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "ORDERBYname")

	records, err := app.SDK.List(ctx, "sp_widget", params)
	if err != nil {
		return fmt.Errorf("failed to list widgets: %w", err)
	}

	// Parse widgets
	var widgets []spWidget
	for _, record := range records {
		widgets = append(widgets, spWidget{
			SysID:       getStringValue(record, "sys_id"),
			Name:        getStringValue(record, "name"),
			ID:          getStringValue(record, "id"),
			Description: getStringValue(record, "description"),
			Active:      getBoolValue(record, "active"),
		})
	}

	// Sort by name
	sort.Slice(widgets, func(i, j int) bool {
		return widgets[i].Name < widgets[j].Name
	})

	// Build records as []map[string]string for styled output
	var recordsOut []map[string]string
	for _, w := range widgets {
		status := "✓"
		if !w.Active {
			status = "✗"
		}
		recordsOut = append(recordsOut, map[string]string{
			"id":     w.ID,
			"name":   w.Name,
			"status": status,
			"sys_id": w.SysID,
		})
	}

	return app.OK(map[string]any{
		"count":        len(widgets),
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d Service Portal widget(s)", len(widgets))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn dev spwidgets show <widget-id>",
				Description: "Show widget details",
			},
		),
	)
}

// showSPWidget displays widget details and code
func showSPWidget(ctx context.Context, app *appctx.App, identifier string) error {
	// Try to find widget by ID or sys_id
	var widget spWidget
	found := false

	// First try by sys_id (32 character hex)
	if len(identifier) == 32 {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,id,description,template,css,client_script,script,active,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sp_widget", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			widget = spWidgetFromRecord(record)
			found = true
		}
	}

	// If not found, try by ID field
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,id,description,template,css,client_script,script,active,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "id="+identifier)

		records, err := app.SDK.List(ctx, "sp_widget", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			widget = spWidgetFromRecord(record)
			found = true
		}
	}

	// If still not found, try by name
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,id,description,template,css,client_script,script,active,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "name="+identifier)

		records, err := app.SDK.List(ctx, "sp_widget", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			widget = spWidgetFromRecord(record)
			found = true
		}
	}

	if !found {
		return fmt.Errorf("widget not found: %s", identifier)
	}

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledSPWidget(widget)
	}

	// Build data for JSON/Quiet output
	data := map[string]any{
		"widget": map[string]any{
			"sys_id":        widget.SysID,
			"id":            widget.ID,
			"name":          widget.Name,
			"description":   widget.Description,
			"active":        widget.Active,
			"template":      widget.Template,
			"css":           widget.CSS,
			"client_script": widget.ClientScript,
			"server_script": widget.ServerScript,
		},
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sp_widget",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("Widget: %s (%s)", widget.Name, widget.ID)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev spwidgets list",
				Description: "List all widgets",
			},
		),
	)
}

// spWidgetFromRecord converts a record map to a spWidget struct
func spWidgetFromRecord(record map[string]any) spWidget {
	return spWidget{
		SysID:        getStringValue(record, "sys_id"),
		Name:         getStringValue(record, "name"),
		ID:           getStringValue(record, "id"),
		Description:  getStringValue(record, "description"),
		Template:     getStringValue(record, "template"),
		CSS:          getStringValue(record, "css"),
		ClientScript: getStringValue(record, "client_script"),
		ServerScript: getStringValue(record, "script"),
		Active:       getBoolValue(record, "active"),
		CreatedOn:    getStringValue(record, "sys_created_on"),
		UpdatedOn:    getStringValue(record, "sys_updated_on"),
	}
}

// printStyledSPWidget outputs styled widget details.
func printStyledSPWidget(widget spWidget) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#a8a8a8"))

	fmt.Println()

	// Title
	status := ""
	if !widget.Active {
		status = " [INACTIVE]"
	}
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s (%s)%s", widget.Name, widget.ID, status)))
	fmt.Println()

	// Details
	if widget.Description != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Description"), fieldStyle.Render(widget.Description))
	}
	fmt.Printf("  %s: %s\n", labelStyle.Render("Sys ID"), fieldStyle.Render(widget.SysID))
	fmt.Println()

	// Template (HTML)
	if widget.Template != "" {
		fmt.Println(sectionStyle.Render("─ HTML Template ─"))
		lines := strings.Split(widget.Template, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// CSS
	if widget.CSS != "" {
		fmt.Println(sectionStyle.Render("─ CSS ─"))
		lines := strings.Split(widget.CSS, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// Client Script
	if widget.ClientScript != "" {
		fmt.Println(sectionStyle.Render("─ Client Script ─"))
		lines := strings.Split(widget.ClientScript, "\n")
		for _, line := range lines {
			fmt.Printf("  %s\n", codeStyle.Render(line))
		}
		fmt.Println()
	}

	// Server Script
	if widget.ServerScript != "" {
		fmt.Println(sectionStyle.Render("─ Server Script ─"))
		lines := strings.Split(widget.ServerScript, "\n")
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
		"jsn dev spwidgets list",
		labelStyle.Render("List all widgets"),
	)
	fmt.Printf("  %-50s  %s\n",
		"jsn dev sppages list",
		labelStyle.Render("List pages that use widgets"),
	)

	fmt.Println()
	return nil
}

// listSPWidgetsInteractive shows an interactive picker for Service Portal widgets
func listSPWidgetsInteractive(ctx context.Context, app *appctx.App, pageSize int) error {
	// Create a reusable list fetcher configured for SP widgets
	fetcher := tui.NewListFetcher("sp_widget").
		WithColumns("id", "name", "active").
		WithOrderBy("ORDERBYname").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			id := getStringValue(record, "id")
			name := getStringValue(record, "name")
			sysID := getStringValue(record, "sys_id")

			display := name
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

	// If user selected a widget, show its details
	if selected != nil {
		// Extract the widget ID from the title format "[id] name"
		title := selected.Title
		if strings.HasPrefix(title, "[") {
			// Extract ID from between brackets
			end := strings.Index(title, "]")
			if end > 0 {
				return showSPWidget(ctx, app, title[1:end])
			}
		}
		// Fallback: try to use sys_id
		return showSPWidget(ctx, app, selected.ID)
	}

	// User cancelled
	return nil
}
