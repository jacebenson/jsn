// Package dev provides development-related commands.
package dev

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"

	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/tui"
)

// appMenu represents an Application Menu (sys_app_application record).
type appMenu struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Active      bool   `json:"active"`
	Order       int    `json:"order"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	UpdatedOn   string `json:"sys_updated_on"`
}

// appModule represents an Application Module (sys_app_module record).
type appModule struct {
	SysID      string `json:"sys_id"`
	Name       string `json:"name"`
	Title      string `json:"title"`
	Menu       string `json:"application"`
	MenuName   string `json:"application.name"`
	LinkType   string `json:"link_type"`
	Arguments  string `json:"arguments"`
	WindowName string `json:"window_name"`
	Active     bool   `json:"active"`
	Order      int    `json:"order"`
	CreatedOn  string `json:"sys_created_on"`
	UpdatedOn  string `json:"sys_updated_on"`
}

// NewAppMenuCmd creates the appmenu command group.
func NewAppMenuCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "appmenu",
		Aliases: []string{"app-menu", "menu"},
		Short:   "Manage Classic UI Application Menus",
		Long: `List and view Classic UI application menus and modules.

Application menus (sys_app_application) contain modules (sys_app_module) 
that appear in the left navigation. These define how users navigate to 
tables, lists, and other functionality in the Classic UI.

Examples:
  # List all application menus
  jsn dev appmenu list

  # Show menu details and its modules
  jsn dev appmenu show "My Application"

  # Show by sys_id
  jsn dev appmenu show 1234567890abcdef...`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newAppMenuListCmd(),
		newAppMenuShowCmd(),
	)

	return cmd
}

// newAppMenuListCmd creates the appmenu list subcommand
func newAppMenuListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List application menus",
		Long: `List all Classic UI application menus.

Examples:
  jsn dev appmenu list
  jsn dev appmenu list --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listAppMenus(ctx, app, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of menus to fetch")

	return cmd
}

// newAppMenuShowCmd creates the appmenu show subcommand
func newAppMenuShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [menu-name]",
		Short: "Show application menu details",
		Long: `Show detailed application menu including its modules.

This displays the menu structure: title, description, and all modules
that belong to this menu in order.

Examples:
  # Show menu by name
  jsn dev appmenu show "My Application"

  # Show by sys_id
  jsn dev appmenu show 1234567890abcdef...`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showAppMenu(ctx, app, args[0])
		},
	}

	return cmd
}

// listAppMenus lists all application menus
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listAppMenus(ctx context.Context, app *appctx.App, limit int) error {
	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listAppMenusInteractive(ctx, app, limit)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "sys_id,name,title,description,category,active,order,sys_scope")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "ORDERBYtitle")

	records, err := app.SDK.List(ctx, "sys_app_application", params)
	if err != nil {
		return fmt.Errorf("failed to list application menus: %w", err)
	}

	// Parse menus
	var menus []appMenu
	for _, record := range records {
		menus = append(menus, appMenu{
			SysID:       getStringValue(record, "sys_id"),
			Name:        getStringValue(record, "name"),
			Title:       getStringValue(record, "title"),
			Description: getStringValue(record, "description"),
			Category:    getStringValue(record, "category"),
			Active:      getBoolValue(record, "active"),
			Order:       getIntValue(record, "order"),
			Scope:       getDisplayValue(record, "sys_scope"),
		})
	}

	// Sort by title
	sort.Slice(menus, func(i, j int) bool {
		return menus[i].Title < menus[j].Title
	})

	// Build records as []map[string]string for styled output
	var recordsOut []map[string]string
	for _, m := range menus {
		status := "✓"
		if !m.Active {
			status = "✗"
		}
		recordsOut = append(recordsOut, map[string]string{
			"title":    m.Title,
			"category": m.Category,
			"status":   status,
			"sys_id":   m.SysID,
		})
	}

	return app.OK(map[string]any{
		"count":        len(menus),
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d application menu(s)", len(menus))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn dev appmenu show <menu-name>",
				Description: "Show menu details",
			},
		),
	)
}

// listAppMenusInteractive shows an interactive picker for application menus
func listAppMenusInteractive(ctx context.Context, app *appctx.App, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_app_application").
		WithColumns("name", "title", "description", "category", "active", "sys_scope").
		WithOrderBy("ORDERBYtitle").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			title := getStringValue(record, "title")
			name := getStringValue(record, "name")
			category := getStringValue(record, "category")
			active := getBoolValue(record, "active")
			scope := getDisplayValue(record, "sys_scope")
			sysID := getStringValue(record, "sys_id")

			// Format: TITLE | Category | Scope [inactive]
			display := title
			if display == "" {
				display = name
			}

			extra := category
			if scope != "" && scope != "Global" {
				if extra != "" {
					extra += " | " + scope
				} else {
					extra = scope
				}
			}

			titleStr := display
			if extra != "" {
				titleStr = fmt.Sprintf("%s  | %s", display, extra)
			}
			if !active {
				titleStr += " [inactive]"
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: titleStr,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		// Use the sys_id to show details
		return showAppMenu(ctx, app, selected.ID)
	}

	return nil
}

// showAppMenu displays menu details and its modules
func showAppMenu(ctx context.Context, app *appctx.App, identifier string) error {
	// Try to find menu by name or sys_id
	var menu appMenu
	found := false

	// First try by sys_id (32 character hex)
	if len(identifier) == 32 {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,title,description,category,active,order,sys_scope,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sys_app_application", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			menu = appMenuFromRecord(record)
			found = true
		}
	}

	// If not found, try by title
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,title,description,category,active,order,sys_scope,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "title="+identifier)

		records, err := app.SDK.List(ctx, "sys_app_application", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			menu = appMenuFromRecord(record)
			found = true
		}
	}

	// If still not found, try by name
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,title,description,category,active,order,sys_scope,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "name="+identifier)

		records, err := app.SDK.List(ctx, "sys_app_application", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			menu = appMenuFromRecord(record)
			found = true
		}
	}

	if !found {
		return fmt.Errorf("application menu not found: %s", identifier)
	}

	// Fetch modules for this menu
	var modules []appModule
	modParams := url.Values{}
	modParams.Set("sysparm_limit", "100")
	modParams.Set("sysparm_fields", "sys_id,name,title,application,link_type,arguments,window_name,active,order,sys_created_on,sys_updated_on")
	modParams.Set("sysparm_display_value", "all")
	modParams.Set("sysparm_query", "application="+menu.SysID+"^ORDERBYorder")

	modRecords, err := app.SDK.List(ctx, "sys_app_module", modParams)
	if err == nil {
		for _, record := range modRecords {
			modules = append(modules, appModuleFromRecord(record))
		}
	}

	// Sort by order
	sort.Slice(modules, func(i, j int) bool {
		return modules[i].Order < modules[j].Order
	})

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledAppMenu(menu, modules)
	}

	// Build data for JSON/Quiet output
	var modulesData []map[string]any
	for _, mod := range modules {
		modulesData = append(modulesData, map[string]any{
			"sys_id":      mod.SysID,
			"name":        mod.Name,
			"title":       mod.Title,
			"link_type":   mod.LinkType,
			"arguments":   mod.Arguments,
			"window_name": mod.WindowName,
			"order":       mod.Order,
			"active":      mod.Active,
		})
	}

	data := map[string]any{
		"menu": map[string]any{
			"sys_id":      menu.SysID,
			"name":        menu.Name,
			"title":       menu.Title,
			"description": menu.Description,
			"category":    menu.Category,
			"active":      menu.Active,
			"order":       menu.Order,
			"scope":       menu.Scope,
		},
		"modules": modulesData,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_app_application",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("Menu: %s - %d modules", menu.Title, len(modules))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev appmenu list",
				Description: "List all menus",
			},
		),
	)
}

// appMenuFromRecord converts a record map to an appMenu struct
func appMenuFromRecord(record map[string]any) appMenu {
	return appMenu{
		SysID:       getStringValue(record, "sys_id"),
		Name:        getStringValue(record, "name"),
		Title:       getStringValue(record, "title"),
		Description: getStringValue(record, "description"),
		Category:    getStringValue(record, "category"),
		Active:      getBoolValue(record, "active"),
		Order:       getIntValue(record, "order"),
		Scope:       getDisplayValue(record, "sys_scope"),
		CreatedOn:   getStringValue(record, "sys_created_on"),
		UpdatedOn:   getStringValue(record, "sys_updated_on"),
	}
}

// appModuleFromRecord converts a record map to an appModule struct
func appModuleFromRecord(record map[string]any) appModule {
	return appModule{
		SysID:      getStringValue(record, "sys_id"),
		Name:       getStringValue(record, "name"),
		Title:      getStringValue(record, "title"),
		Menu:       getStringValue(record, "application"),
		MenuName:   getDisplayValue(record, "application"),
		LinkType:   getStringValue(record, "link_type"),
		Arguments:  getStringValue(record, "arguments"),
		WindowName: getStringValue(record, "window_name"),
		Active:     getBoolValue(record, "active"),
		Order:      getIntValue(record, "order"),
		CreatedOn:  getStringValue(record, "sys_created_on"),
		UpdatedOn:  getStringValue(record, "sys_updated_on"),
	}
}

// printStyledAppMenu outputs styled menu details.
func printStyledAppMenu(menu appMenu, modules []appModule) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	posStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))

	fmt.Println()

	// Title
	status := ""
	if !menu.Active {
		status = " [INACTIVE]"
	}
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s%s", menu.Title, status)))
	fmt.Println()

	// Details
	if menu.Description != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Description"), fieldStyle.Render(menu.Description))
	}
	if menu.Category != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Category"), fieldStyle.Render(menu.Category))
	}
	if menu.Scope != "" && menu.Scope != "Global" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Scope"), fieldStyle.Render(menu.Scope))
	}
	fmt.Printf("  %s: %s\n", labelStyle.Render("Sys ID"), fieldStyle.Render(menu.SysID))
	fmt.Println()

	// Modules
	fmt.Println(sectionStyle.Render("─ Modules ─"))
	if len(modules) == 0 {
		fmt.Println(labelStyle.Render("  (no modules)"))
	} else {
		for i, mod := range modules {
			status := ""
			if !mod.Active {
				status = inactiveStyle.Render(" [inactive]")
			}
			linkType := ""
			if mod.LinkType != "" {
				linkType = labelStyle.Render(fmt.Sprintf(" (%s)", mod.LinkType))
			}
			fmt.Printf("  %s  %s%s%s\n",
				posStyle.Render(fmt.Sprintf("%2d.", i+1)),
				fieldStyle.Render(mod.Title),
				linkType,
				status,
			)
		}
	}
	fmt.Println()

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		"jsn dev appmenu list",
		labelStyle.Render("List all menus"),
	)
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn records list --table sys_app_module --query \"application=%s\"", menu.SysID),
		labelStyle.Render("Query modules directly"),
	)

	fmt.Println()
	return nil
}
