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

// scriptedRestAPI represents a Scripted REST API (sys_ws_definition record).
type scriptedRestAPI struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	APIVersion  string `json:"api_version"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
	Protected   bool   `json:"protected"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	UpdatedOn   string `json:"sys_updated_on"`
}

// scriptedRestResource represents a Scripted REST Resource (sys_ws_operation record).
type scriptedRestResource struct {
	SysID          string `json:"sys_id"`
	Name           string `json:"name"`
	Operation      string `json:"operation"`
	WebService     string `json:"web_service"`
	WebServiceName string `json:"web_service.name"`
	Script         string `json:"script"`
	Active         bool   `json:"active"`
	Route          string `json:"route"`
	Consumes       string `json:"consumes"`
	Produces       string `json:"produces"`
	Order          int    `json:"order"`
	CreatedOn      string `json:"sys_created_on"`
	UpdatedOn      string `json:"sys_updated_on"`
}

// NewScRAPICmd creates the scrapi command group.
func NewScRAPICmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "scrapi",
		Aliases: []string{"scripted-rest", "rest-api"},
		Short:   "Manage Scripted REST APIs",
		Long: `List and view Scripted REST APIs and their resources.

Scripted REST APIs (sys_ws_definition) allow you to create custom REST
endpoints with server-side scripts. Each API can have multiple resources
(sys_ws_operation) that define HTTP methods (GET, POST, PUT, DELETE).

Examples:
  # List all Scripted REST APIs
  jsn dev scrapi list

  # Show API details and its resources
  jsn dev scrapi show "My API"

  # Show by sys_id
  jsn dev scrapi show 1234567890abcdef...`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// No subcommand - show help
			return cmd.Help()
		},
	}

	cmd.AddCommand(
		newScRAPIListCmd(),
		newScRAPIShowCmd(),
	)

	return cmd
}

// newScRAPIListCmd creates the scrapi list subcommand
func newScRAPIListCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Scripted REST APIs",
		Long: `List all Scripted REST APIs.

Examples:
  jsn dev scrapi list
  jsn dev scrapi list --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return listScRAPIs(ctx, app, limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "l", 50, "Maximum number of APIs to fetch")

	return cmd
}

// newScRAPIShowCmd creates the scrapi show subcommand
func newScRAPIShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show [api-name]",
		Short: "Show Scripted REST API details",
		Long: `Show detailed Scripted REST API including its resources.

This displays the API structure: namespace, version, and all resources
(GET, POST, PUT, DELETE operations) with their scripts.

Examples:
  # Show API by name
  jsn dev scrapi show "My API"

  # Show by sys_id
  jsn dev scrapi show 1234567890abcdef...`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			ctx := cmd.Context()

			return showScRAPI(ctx, app, args[0])
		},
	}

	return cmd
}

// listScRAPIs lists all Scripted REST APIs
// In interactive mode (TTY), shows a picker. Otherwise, returns JSON/list output.
func listScRAPIs(ctx context.Context, app *appctx.App, limit int) error {
	if limit <= 0 {
		limit = 50
	}

	// Check if we're in an interactive terminal
	isInteractive := output.IsTTY(os.Stdout) && output.IsTTY(os.Stdin)

	// If interactive and no specific format is forced, use the picker
	if isInteractive && app.Output.GetFormat() == output.FormatAuto {
		return listScRAPIsInteractive(ctx, app, limit)
	}

	// Non-interactive: use normal list output
	params := url.Values{}
	params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	params.Set("sysparm_fields", "sys_id,name,namespace,api_version,description,active,protected,sys_scope")
	params.Set("sysparm_display_value", "all")
	params.Set("sysparm_query", "ORDERBYname")

	records, err := app.SDK.List(ctx, "sys_ws_definition", params)
	if err != nil {
		return fmt.Errorf("failed to list Scripted REST APIs: %w", err)
	}

	// Parse APIs
	var apis []scriptedRestAPI
	for _, record := range records {
		apis = append(apis, scriptedRestAPI{
			SysID:       getStringValue(record, "sys_id"),
			Name:        getStringValue(record, "name"),
			Namespace:   getStringValue(record, "namespace"),
			APIVersion:  getStringValue(record, "api_version"),
			Description: getStringValue(record, "description"),
			Active:      getBoolValue(record, "active"),
			Protected:   getBoolValue(record, "protected"),
			Scope:       getDisplayValue(record, "sys_scope"),
		})
	}

	// Sort by name
	sort.Slice(apis, func(i, j int) bool {
		return apis[i].Name < apis[j].Name
	})

	// Build records as []map[string]string for styled output
	var recordsOut []map[string]string
	for _, api := range apis {
		status := "✓"
		if !api.Active {
			status = "✗"
		}
		if api.Protected {
			status += " P"
		}
		recordsOut = append(recordsOut, map[string]string{
			"name":      api.Name,
			"namespace": api.Namespace,
			"version":   api.APIVersion,
			"status":    status,
			"sys_id":    api.SysID,
		})
	}

	return app.OK(map[string]any{
		"count":        len(apis),
		"records":      recordsOut,
		"instance_url": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary(fmt.Sprintf("%d Scripted REST API(s)", len(apis))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn dev scrapi show <api-name>",
				Description: "Show API details",
			},
		),
	)
}

// listScRAPIsInteractive shows an interactive picker for Scripted REST APIs
func listScRAPIsInteractive(ctx context.Context, app *appctx.App, pageSize int) error {
	fetcher := tui.NewListFetcher("sys_ws_definition").
		WithColumns("name", "namespace", "api_version", "description", "active", "protected", "sys_scope").
		WithOrderBy("ORDERBYname").
		WithFormatItem(func(record map[string]any) tui.PickerItem {
			name := getStringValue(record, "name")
			namespace := getStringValue(record, "namespace")
			version := getStringValue(record, "api_version")
			active := getBoolValue(record, "active")
			protected := getBoolValue(record, "protected")
			sysID := getStringValue(record, "sys_id")

			// Format: NAME | namespace [vX] [protected] [inactive]
			display := name
			extra := namespace
			if version != "" {
				extra += " [v" + version + "]"
			}
			if extra != "" {
				display = fmt.Sprintf("%s  | %s", name, extra)
			}
			if protected {
				display += " [protected]"
			}
			if !active {
				display += " [inactive]"
			}

			return tui.PickerItem{
				ID:    sysID,
				Title: display,
			}
		})

	selected, err := tui.ListInteractive(ctx, app, fetcher, pageSize)
	if err != nil {
		return err
	}

	if selected != nil {
		// Use the sys_id to show details
		return showScRAPI(ctx, app, selected.ID)
	}

	return nil
}

// showScRAPI displays API details and its resources
func showScRAPI(ctx context.Context, app *appctx.App, identifier string) error {
	// Try to find API by name or sys_id
	var api scriptedRestAPI
	found := false

	// First try by sys_id (32 character hex)
	if len(identifier) == 32 {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,namespace,api_version,description,active,protected,sys_scope,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "sys_id="+identifier)

		records, err := app.SDK.List(ctx, "sys_ws_definition", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			api = scRAPIFromRecord(record)
			found = true
		}
	}

	// If not found, try by name
	if !found {
		params := url.Values{}
		params.Set("sysparm_limit", "1")
		params.Set("sysparm_fields", "sys_id,name,namespace,api_version,description,active,protected,sys_scope,sys_created_on,sys_updated_on")
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_query", "name="+identifier)

		records, err := app.SDK.List(ctx, "sys_ws_definition", params)
		if err == nil && len(records) > 0 {
			record := records[0]
			api = scRAPIFromRecord(record)
			found = true
		}
	}

	if !found {
		return fmt.Errorf("Scripted REST API not found: %s", identifier)
	}

	// Fetch resources for this API
	var resources []scriptedRestResource
	resParams := url.Values{}
	resParams.Set("sysparm_limit", "100")
	resParams.Set("sysparm_fields", "sys_id,name,operation,web_service,script,active,route,consumes,produces,order,sys_created_on,sys_updated_on")
	resParams.Set("sysparm_display_value", "all")
	resParams.Set("sysparm_query", "web_service="+api.SysID+"^ORDERBYorder")

	resRecords, err := app.SDK.List(ctx, "sys_ws_operation", resParams)
	if err == nil {
		for _, record := range resRecords {
			resources = append(resources, scRAPIResourceFromRecord(record))
		}
	}

	// Sort by order
	sort.Slice(resources, func(i, j int) bool {
		return resources[i].Order < resources[j].Order
	})

	// Check output format
	format := app.Output.GetFormat()
	isTerminal := output.IsTTY(os.Stdout)

	// Styled output - print directly
	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledScRAPI(api, resources)
	}

	// Build data for JSON/Quiet output
	var resourcesData []map[string]any
	for _, res := range resources {
		resourcesData = append(resourcesData, map[string]any{
			"sys_id":    res.SysID,
			"name":      res.Name,
			"operation": res.Operation,
			"route":     res.Route,
			"script":    res.Script,
			"consumes":  res.Consumes,
			"produces":  res.Produces,
			"order":     res.Order,
			"active":    res.Active,
		})
	}

	data := map[string]any{
		"api": map[string]any{
			"sys_id":      api.SysID,
			"name":        api.Name,
			"namespace":   api.Namespace,
			"api_version": api.APIVersion,
			"description": api.Description,
			"active":      api.Active,
			"protected":   api.Protected,
			"scope":       api.Scope,
		},
		"resources": resourcesData,
		"_context": map[string]any{
			"instance_url": app.Config.GetEffectiveInstance(),
			"table":        "sys_ws_definition",
		},
	}

	return app.OK(data,
		output.WithSummary(fmt.Sprintf("API: %s - %d resources", api.Name, len(resources))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn dev scrapi list",
				Description: "List all APIs",
			},
		),
	)
}

// scRAPIFromRecord converts a record map to a scriptedRestAPI struct
func scRAPIFromRecord(record map[string]any) scriptedRestAPI {
	return scriptedRestAPI{
		SysID:       getStringValue(record, "sys_id"),
		Name:        getStringValue(record, "name"),
		Namespace:   getStringValue(record, "namespace"),
		APIVersion:  getStringValue(record, "api_version"),
		Description: getStringValue(record, "description"),
		Active:      getBoolValue(record, "active"),
		Protected:   getBoolValue(record, "protected"),
		Scope:       getDisplayValue(record, "sys_scope"),
		CreatedOn:   getStringValue(record, "sys_created_on"),
		UpdatedOn:   getStringValue(record, "sys_updated_on"),
	}
}

// scRAPIResourceFromRecord converts a record map to a scriptedRestResource struct
func scRAPIResourceFromRecord(record map[string]any) scriptedRestResource {
	return scriptedRestResource{
		SysID:          getStringValue(record, "sys_id"),
		Name:           getStringValue(record, "name"),
		Operation:      getStringValue(record, "operation"),
		WebService:     getStringValue(record, "web_service"),
		WebServiceName: getDisplayValue(record, "web_service"),
		Script:         getStringValue(record, "script"),
		Active:         getBoolValue(record, "active"),
		Route:          getStringValue(record, "route"),
		Consumes:       getStringValue(record, "consumes"),
		Produces:       getStringValue(record, "produces"),
		Order:          getIntValue(record, "order"),
		CreatedOn:      getStringValue(record, "sys_created_on"),
		UpdatedOn:      getStringValue(record, "sys_updated_on"),
	}
}

// printStyledScRAPI outputs styled API details.
func printStyledScRAPI(api scriptedRestAPI, resources []scriptedRestResource) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8a217"))
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	fieldStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#cccccc"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#a8a8a8"))
	posStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))

	fmt.Println()

	// Title
	status := ""
	if !api.Active {
		status = " [INACTIVE]"
	}
	if api.Protected {
		status += " [PROTECTED]"
	}
	fmt.Println(headerStyle.Render(fmt.Sprintf("%s%s", api.Name, status)))
	fmt.Println()

	// Details
	if api.Namespace != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Namespace"), fieldStyle.Render(api.Namespace))
	}
	if api.APIVersion != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("API Version"), fieldStyle.Render(api.APIVersion))
	}
	if api.Description != "" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Description"), fieldStyle.Render(api.Description))
	}
	if api.Scope != "" && api.Scope != "Global" {
		fmt.Printf("  %s: %s\n", labelStyle.Render("Scope"), fieldStyle.Render(api.Scope))
	}
	fmt.Printf("  %s: %s\n", labelStyle.Render("Sys ID"), fieldStyle.Render(api.SysID))
	fmt.Println()

	// Resources
	fmt.Println(sectionStyle.Render("─ Resources ─"))
	if len(resources) == 0 {
		fmt.Println(labelStyle.Render("  (no resources)"))
	} else {
		for i, res := range resources {
			status := ""
			if !res.Active {
				status = inactiveStyle.Render(" [inactive]")
			}
			method := res.Operation
			if method == "" {
				method = "GET"
			}
			route := res.Route
			if route == "" {
				route = "/"
			}
			fmt.Printf("  %s  %s %s%s\n",
				posStyle.Render(fmt.Sprintf("%2d.", i+1)),
				fieldStyle.Render(fmt.Sprintf("[%s]", method)),
				fieldStyle.Render(route),
				status,
			)
			if res.Name != "" {
				fmt.Printf("      %s: %s\n",
					labelStyle.Render("Name"),
					fieldStyle.Render(res.Name),
				)
			}
			if res.Consumes != "" {
				fmt.Printf("      %s: %s\n",
					labelStyle.Render("Consumes"),
					fieldStyle.Render(res.Consumes),
				)
			}
			if res.Produces != "" {
				fmt.Printf("      %s: %s\n",
					labelStyle.Render("Produces"),
					fieldStyle.Render(res.Produces),
				)
			}
			if res.Script != "" {
				fmt.Printf("      %s:\n", labelStyle.Render("Script"))
				lines := splitLines(res.Script, 60)
				for _, line := range lines[:min(len(lines), 5)] {
					fmt.Printf("        %s\n", codeStyle.Render(line))
				}
				if len(lines) > 5 {
					fmt.Printf("        %s\n", codeStyle.Render("..."))
				}
			}
			fmt.Println()
		}
	}

	// Hints
	fmt.Println("─────")
	fmt.Println()
	fmt.Println(headerStyle.Render("Hints:"))
	fmt.Printf("  %-50s  %s\n",
		"jsn dev scrapi list",
		labelStyle.Render("List all APIs"),
	)
	fmt.Printf("  %-50s  %s\n",
		fmt.Sprintf("jsn records list --table sys_ws_operation --query \"web_service=%s\"", api.SysID),
		labelStyle.Render("Query resources directly"),
	)

	fmt.Println()
	return nil
}

// splitLines splits a string into lines of max length
func splitLines(s string, maxLen int) []string {
	var lines []string
	for len(s) > maxLen {
		lines = append(lines, s[:maxLen])
		s = s[maxLen:]
	}
	if len(s) > 0 {
		lines = append(lines, s)
	}
	return lines
}

// min returns the minimum of two ints
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
