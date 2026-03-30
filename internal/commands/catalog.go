package commands

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// catalogItemListFlags holds the flags for the catalog-item command.
type catalogItemListFlags struct {
	limit   int
	catalog string
	active  bool
	query   string
}

// NewCatalogItemCmd creates the catalog-item command group.
func NewCatalogItemCmd() *cobra.Command {
	var flags catalogItemListFlags

	cmd := &cobra.Command{
		Use:     "catalog-item [<sys_id_or_name>]",
		Aliases: []string{"cat-item", "ci"},
		Short:   "Manage Service Catalog items",
		Long: `List, show, and manage Service Catalog items and their variables.

Usage:
  jsn catalog-item                               List catalog items (interactive picker in TTY)
  jsn catalog-item <sys_id_or_name>              Show item details with variables
  jsn catalog-item --query <encoded_query>       Raw ServiceNow encoded query
  jsn catalog-item --active                      Only show active items
  jsn catalog-item --catalog "Service Catalog"   Filter by catalog name

Examples:
  jsn catalog-item "Order Nothing Phone"
  jsn catalog-item --active --limit 50
  jsn catalog-item --query "nameLIKEphone"`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct lookup by identifier
			if len(args) > 0 {
				return runCatalogItemShow(cmd, args[0])
			}

			// Mode 2: List/search (handles interactive picker when no filters)
			return runCatalogItemList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of items to fetch")
	cmd.Flags().StringVar(&flags.catalog, "catalog", "", "Filter by catalog name")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Only show active items")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")

	cmd.AddCommand(
		newCatalogItemCreateCmd(),
		newCatalogItemCreateVariableCmd(),
		newCatalogItemVariablesCmd(),
	)

	return cmd
}

// runCatalogItemList executes the catalog-item list command.
func runCatalogItemList(cmd *cobra.Command, flags catalogItemListFlags) error {
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

	// Build query
	queryParts := []string{}
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.catalog != "" {
		queryParts = append(queryParts, fmt.Sprintf("sc_catalogsLIKE%s", flags.catalog))
	}
	if flags.query != "" {
		queryParts = append(queryParts, flags.query)
	}

	query := url.Values{}
	query.Set("sysparm_limit", fmt.Sprintf("%d", flags.limit))
	query.Set("sysparm_fields", "sys_id,name,short_description,active,category,sc_catalogs,price")
	query.Set("sysparm_display_value", "true")
	if len(queryParts) > 0 {
		query.Set("sysparm_query", strings.Join(queryParts, "^"))
	}

	resp, err := sdkClient.Get(cmd.Context(), "sc_cat_item", query)
	if err != nil {
		return fmt.Errorf("failed to list catalog items: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCatalogItemList(cmd, resp.Result, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCatalogItemList(cmd, resp.Result, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn catalog-item <sys_id>",
			Description: "Show item details",
		},
		{
			Action:      "variables",
			Cmd:         "jsn catalog-item variables <sys_id>",
			Description: "List item variables",
		},
		{
			Action:      "create",
			Cmd:         "jsn catalog-item create --field name=\"...\"",
			Description: "Create new catalog item",
		},
	}

	return outputWriter.OK(resp.Result,
		output.WithSummary(fmt.Sprintf("%d catalog items", len(resp.Result))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledCatalogItemList outputs styled catalog item list.
func printStyledCatalogItemList(cmd *cobra.Command, items []map[string]interface{}, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Catalog Items"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-40s %s\n",
		mutedStyle.Render("Sys ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Category"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	for _, item := range items {
		sysID := getStringField(item, "sys_id")
		name := getStringField(item, "name")
		category := getStringField(item, "category")
		active := getStringField(item, "active")

		// Truncate name if too long
		if len(name) > 38 {
			name = name[:35] + "..."
		}

		// Style based on active status
		nameStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
		if active == "false" {
			nameStyle = mutedStyle
		}

		// Create hyperlink if instance URL available
		displayID := sysID
		if instanceURL != "" {
			link := fmt.Sprintf("%s/sc_cat_item.do?sys_id=%s", instanceURL, sysID)
			displayID = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, sysID)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-40s %s\n",
			mutedStyle.Render(displayID),
			nameStyle.Render(name),
			mutedStyle.Render(category),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item <sys_id>",
		labelStyle.Render("Show item details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item create --field name=\"...\"",
		labelStyle.Render("Create new catalog item"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable-types",
		labelStyle.Render("View variable type reference"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownCatalogItemList outputs markdown catalog item list.
func printMarkdownCatalogItemList(cmd *cobra.Command, items []map[string]interface{}, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "## Catalog Items")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Name | Category | Active |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------|----------|--------|")

	for _, item := range items {
		sysID := getStringField(item, "sys_id")
		name := getStringField(item, "name")
		category := getStringField(item, "category")
		active := getStringField(item, "active")

		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
			sysID, name, category, active)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// runCatalogItemShow executes the catalog-item show command.
func runCatalogItemShow(cmd *cobra.Command, identifier string) error {
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

	// Try to find by sys_id first, then by name
	var item map[string]interface{}

	// Check if it looks like a sys_id (32 hex chars)
	if len(identifier) == 32 {
		record, err := sdkClient.GetRecord(cmd.Context(), "sc_cat_item", identifier)
		if err == nil {
			item = record
		}
	}

	// If not found, search by name
	if item == nil {
		query := url.Values{}
		query.Set("sysparm_limit", "1")
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
		query.Set("sysparm_display_value", "true")

		resp, err := sdkClient.Get(cmd.Context(), "sc_cat_item", query)
		if err != nil {
			return fmt.Errorf("failed to find catalog item: %w", err)
		}

		if len(resp.Result) == 0 {
			return output.ErrNotFound(fmt.Sprintf("catalog item '%s' not found", identifier))
		}

		item = resp.Result[0]
	}

	sysID := getStringField(item, "sys_id")

	// Fetch variables for this catalog item (both direct and from variable sets)
	variables := []map[string]interface{}{}
	variableSetNames := map[string]string{} // map[sys_id]name for display

	// 1. Get variables directly attached to the catalog item
	varQuery := url.Values{}
	varQuery.Set("sysparm_limit", "100")
	varQuery.Set("sysparm_query", fmt.Sprintf("cat_item=%s^ORDERBYorder", sysID))
	varQuery.Set("sysparm_fields", "sys_id,name,question_text,common_question,type,mandatory,order,active,variable_set")
	varQuery.Set("sysparm_display_value", "true")

	varResp, err := sdkClient.Get(cmd.Context(), "item_option_new", varQuery)
	if err == nil {
		variables = append(variables, varResp.Result...)
	}

	// 2. Get variable sets linked to this catalog item
	setQuery := url.Values{}
	setQuery.Set("sysparm_limit", "100")
	setQuery.Set("sysparm_query", fmt.Sprintf("sc_cat_item=%s", sysID))
	setQuery.Set("sysparm_fields", "variable_set,order")
	setQuery.Set("sysparm_display_value", "true")

	setResp, err := sdkClient.Get(cmd.Context(), "io_set_item", setQuery)
	if err == nil && len(setResp.Result) > 0 {
		// For each variable set, get its variables
		for _, setItem := range setResp.Result {
			varSetID := ""
			varSetName := ""

			// Handle variable_set reference field
			if v, ok := setItem["variable_set"]; ok && v != nil {
				switch val := v.(type) {
				case string:
					varSetID = val
					varSetName = val
				case map[string]interface{}:
					if dv, ok := val["display_value"].(string); ok {
						varSetName = dv
					}
					// Extract sys_id from link field (e.g., ".../table/item_option_new_set/3820df57...")
					if link, ok := val["link"].(string); ok && link != "" {
						parts := strings.Split(link, "/")
						if len(parts) > 0 {
							varSetID = parts[len(parts)-1]
						}
					}
				}
			}

			if varSetID != "" {
				variableSetNames[varSetID] = varSetName

				// Get variables from this variable set
				setVarQuery := url.Values{}
				setVarQuery.Set("sysparm_limit", "100")
				setVarQuery.Set("sysparm_query", fmt.Sprintf("variable_set=%s^ORDERBYorder", varSetID))
				setVarQuery.Set("sysparm_fields", "sys_id,name,question_text,common_question,type,mandatory,order,active,variable_set")
				setVarQuery.Set("sysparm_display_value", "true")

				setVarResp, err := sdkClient.Get(cmd.Context(), "item_option_new", setVarQuery)
				if err == nil {
					// Mark these variables as coming from a variable set
					for _, v := range setVarResp.Result {
						v["_variable_set_name"] = varSetName
						variables = append(variables, v)
					}
				}
			}
		}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCatalogItem(cmd, item, variables, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCatalogItem(cmd, item, variables, instanceURL)
	}

	// Build response with variables embedded
	response := map[string]interface{}{
		"item":      item,
		"variables": variables,
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         "jsn catalog-item",
			Description: "List all catalog items",
		},
	}

	return outputWriter.OK(response,
		output.WithSummary(fmt.Sprintf("Catalog item: %s (%d variables)", getStringField(item, "name"), len(variables))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledCatalogItem outputs styled catalog item details.
func printStyledCatalogItem(cmd *cobra.Command, item map[string]interface{}, variables []map[string]interface{}, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	name := getStringField(item, "name")
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Core fields
	coreFields := []string{"sys_id", "name", "short_description", "active", "category", "sc_catalogs", "price"}
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("- Core -"))
	for _, field := range coreFields {
		if val, exists := item[field]; exists {
			valStr := formatValue(val)
			if valStr != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
					labelStyle.Render(field+":"),
					valueStyle.Render(valStr),
				)
			}
		}
	}

	// Link
	sysID := getStringField(item, "sys_id")
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sc_cat_item.do?sys_id=%s", instanceURL, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Link:"),
			link,
			link,
		)
	}

	// Variables section
	if len(variables) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("- Variables ("+fmt.Sprintf("%d", len(variables))+") -"))

		// Separate direct variables from variable set variables
		var directVars, setVars []map[string]interface{}
		for _, v := range variables {
			if _, ok := v["_variable_set_name"]; ok {
				setVars = append(setVars, v)
			} else {
				directVars = append(directVars, v)
			}
		}

		// Print direct variables
		if len(directVars) > 0 {
			fmt.Fprintln(cmd.OutOrStdout())
			fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", labelStyle.Render("Direct Variables:"))
			printVariableTable(cmd, directVars, labelStyle, headerStyle)
		}

		// Print variable set variables grouped by set
		if len(setVars) > 0 {
			// Group by variable set name
			setGroups := make(map[string][]map[string]interface{})
			for _, v := range setVars {
				setName := ""
				if sn, ok := v["_variable_set_name"].(string); ok {
					setName = sn
				}
				setGroups[setName] = append(setGroups[setName], v)
			}

			// Print each variable set group
			for setName, vars := range setGroups {
				fmt.Fprintln(cmd.OutOrStdout())
				fmt.Fprintf(cmd.OutOrStdout(), "  %s %s\n", labelStyle.Render("Variable Set:"), setName)
				printVariableTable(cmd, vars, labelStyle, headerStyle)
			}
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item",
		labelStyle.Render("List all catalog items"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn catalog-item create-variable %s <name> --type 6 --question \"...\"", sysID),
		labelStyle.Render("Create a variable on this item"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item create --field name=\"...\"",
		labelStyle.Render("Create new catalog item"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable-types",
		labelStyle.Render("View variable type reference"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printVariableTable prints a table of variables
func printVariableTable(cmd *cobra.Command, variables []map[string]interface{}, labelStyle lipgloss.Style, headerStyle lipgloss.Style) {
	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "    %-32s %-6s %-20s %-25s %-15s %s\n",
		labelStyle.Render("Sys ID"),
		labelStyle.Render("Order"),
		labelStyle.Render("Name"),
		labelStyle.Render("Question"),
		labelStyle.Render("Type"),
		labelStyle.Render("Req"),
	)

	for _, v := range variables {
		sysID := getStringField(v, "sys_id")
		order := getStringField(v, "order")
		varName := getStringField(v, "name")
		question := getStringField(v, "question_text")
		if question == "" {
			question = getStringField(v, "common_question")
		}
		varType := getStringField(v, "type")
		mandatory := getStringField(v, "mandatory")
		active := getStringField(v, "active")

		// Truncate question if too long
		if len(question) > 23 {
			question = question[:20] + "..."
		}

		// Truncate name if too long
		if len(varName) > 18 {
			varName = varName[:15] + "..."
		}

		// Convert type number to name
		typeName := variableTypeName(varType)

		// Style based on active status
		nameStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
		if active == "false" {
			nameStyle = labelStyle
		}

		reqMarker := ""
		if mandatory == "true" {
			reqMarker = "*"
		}

		fmt.Fprintf(cmd.OutOrStdout(), "    %-32s %-6s %-20s %-25s %-15s %s\n",
			labelStyle.Render(sysID),
			labelStyle.Render(order),
			nameStyle.Render(varName),
			labelStyle.Render(question),
			labelStyle.Render(typeName),
			labelStyle.Render(reqMarker),
		)
	}
	fmt.Fprintln(cmd.OutOrStdout())
}

// printMarkdownCatalogItem outputs markdown catalog item details.
func printMarkdownCatalogItem(cmd *cobra.Command, item map[string]interface{}, variables []map[string]interface{}, instanceURL string) error {
	name := getStringField(item, "name")
	fmt.Fprintf(cmd.OutOrStdout(), "## %s\n\n", name)

	for key, val := range item {
		valStr := formatValue(val)
		if valStr != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "- **%s:** %s\n", key, valStr)
		}
	}

	sysID := getStringField(item, "sys_id")
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sc_cat_item.do?sys_id=%s", instanceURL, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	// Variables section
	if len(variables) > 0 {
		// Separate direct variables from variable set variables
		var directVars, setVars []map[string]interface{}
		for _, v := range variables {
			if _, ok := v["_variable_set_name"]; ok {
				setVars = append(setVars, v)
			} else {
				directVars = append(directVars, v)
			}
		}

		// Print direct variables
		if len(directVars) > 0 {
			fmt.Fprintln(cmd.OutOrStdout())
			fmt.Fprintf(cmd.OutOrStdout(), "### Direct Variables (%d)\n\n", len(directVars))
			fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Order | Name | Question | Type | Required | Active |")
			fmt.Fprintln(cmd.OutOrStdout(), "|--------|-------|------|----------|------|----------|--------|")

			for _, v := range directVars {
				sysID := getStringField(v, "sys_id")
				order := getStringField(v, "order")
				varName := getStringField(v, "name")
				question := getStringField(v, "question_text")
				if question == "" {
					question = getStringField(v, "common_question")
				}
				varType := getStringField(v, "type")
				mandatory := getStringField(v, "mandatory")
				active := getStringField(v, "active")

				typeName := variableTypeName(varType)

				fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s | %s | %s |\n",
					sysID, order, varName, question, typeName, mandatory, active)
			}
		}

		// Print variable set variables grouped by set
		if len(setVars) > 0 {
			// Group by variable set name
			setGroups := make(map[string][]map[string]interface{})
			for _, v := range setVars {
				setName := ""
				if sn, ok := v["_variable_set_name"].(string); ok {
					setName = sn
				}
				setGroups[setName] = append(setGroups[setName], v)
			}

			// Print each variable set group
			for setName, vars := range setGroups {
				fmt.Fprintln(cmd.OutOrStdout())
				fmt.Fprintf(cmd.OutOrStdout(), "### Variable Set: %s (%d)\n\n", setName, len(vars))
				fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Order | Name | Question | Type | Required | Active |")
				fmt.Fprintln(cmd.OutOrStdout(), "|--------|-------|------|----------|------|----------|--------|")

				for _, v := range vars {
					sysID := getStringField(v, "sys_id")
					order := getStringField(v, "order")
					varName := getStringField(v, "name")
					question := getStringField(v, "question_text")
					if question == "" {
						question = getStringField(v, "common_question")
					}
					varType := getStringField(v, "type")
					mandatory := getStringField(v, "mandatory")
					active := getStringField(v, "active")

					typeName := variableTypeName(varType)

					fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s | %s | %s |\n",
						sysID, order, varName, question, typeName, mandatory, active)
				}
			}
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newCatalogItemCreateCmd creates the catalog-item create command.
func newCatalogItemCreateCmd() *cobra.Command {
	var fields []string
	var jsonData string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new catalog item",
		Long: `Create a new Service Catalog item.

Field Input:
  Use --field (or -f) to set field values: --field name="New Catalog Item"
  Use --data (or -d) to provide a JSON object: --data '{"name":"New Catalog Item"}'
  Use @file to read a value from a file: -f script=@/tmp/script.js

Required Fields:
  At minimum, you should provide a name for the catalog item.
  Other commonly used fields: short_description, category, sc_catalogs

Examples:
  jsn catalog-item create --field name="New Laptop Request"
  jsn catalog-item create -f name="New Laptop Request" -f short_description="Request a new laptop"
  jsn catalog-item create -f name="New Request" -f category="Hardware"
  jsn catalog-item create --data '{"name":"New Request","short_description":"Description"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCatalogItemCreate(cmd, fields, jsonData)
		},
	}

	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Set field value (name=value, use @file to read from file)")
	cmd.Flags().StringVarP(&jsonData, "data", "d", "", "JSON object with field values")

	return cmd
}

// runCatalogItemCreate executes the catalog-item create command.
func runCatalogItemCreate(cmd *cobra.Command, fields []string, jsonData string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build data from fields and/or JSON
	data := make(map[string]interface{})

	// Parse JSON if provided
	if jsonData != "" {
		if err := json.Unmarshal([]byte(jsonData), &data); err != nil {
			return output.ErrUsage(fmt.Sprintf("Invalid JSON: %v", err))
		}
	}

	// Parse field flags (override JSON values)
	for _, field := range fields {
		parts := strings.SplitN(field, "=", 2)
		if len(parts) != 2 {
			return output.ErrUsage(fmt.Sprintf("Invalid field format: %s (expected name=value)", field))
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		resolved, err := resolveFieldValue(value)
		if err != nil {
			return output.ErrUsage(fmt.Sprintf("Failed to read file for field %s: %v", key, err))
		}
		data[key] = resolved
	}

	if len(data) == 0 {
		return output.ErrUsage("No field values provided. Use --field or --data")
	}

	// Ensure name is provided
	if _, ok := data["name"]; !ok {
		return output.ErrUsage("Catalog item name is required. Use --field name=\"...\"")
	}

	// Create the catalog item
	record, err := sdkClient.CreateRecord(cmd.Context(), "sc_cat_item", data)
	if err != nil {
		return fmt.Errorf("failed to create catalog item: %w", err)
	}

	sysID := getStringField(record, "sys_id")

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Created catalog item: %s", getStringField(record, "name"))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn catalog-item %s", sysID),
				Description: "View catalog item details",
			},
			output.Breadcrumb{
				Action:      "variables",
				Cmd:         fmt.Sprintf("jsn catalog-item variables %s", sysID),
				Description: "List item variables",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn catalog-item",
				Description: "List all catalog items",
			},
		),
	)
}

// newCatalogItemCreateVariableCmd creates the catalog-item create-variable command.
func newCatalogItemCreateVariableCmd() *cobra.Command {
	var varType string
	var mandatory bool
	var questionText string
	var order int
	var fields []string

	cmd := &cobra.Command{
		Use:   "create-variable <catalog_item_sys_id> <variable_name>",
		Short: "Create a variable on a catalog item",
		Long: `Create a new variable (question) on a Service Catalog item.

Required Fields:
  - Catalog item sys_id
  - Variable name (internal name, no spaces)
  - Variable type (use --type flag)
  - Question text (use --question flag)

Variable Types:
  Use 'jsn variable-types' to see all available types.
  Common types: 6 (Single Line Text), 2 (Multi Line Text), 5 (Select Box),
                7 (CheckBox), 9 (Date), 10 (Date/Time)

Examples:
  jsn catalog-item create-variable 0317ba9d47120510f53d37d2846d43bb new_field --type 6 --question "Enter your name"
  jsn catalog-item create-variable <sys_id> priority --type 5 --question "Select Priority" --mandatory
  jsn catalog-item create-variable <sys_id> notes --type 2 --question "Additional Notes" -f default_value="N/A"`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCatalogItemCreateVariable(cmd, args[0], args[1], varType, mandatory, questionText, order, fields)
		},
	}

	cmd.Flags().StringVarP(&varType, "type", "t", "", "Variable type number (required, see 'jsn variable-types')")
	cmd.Flags().BoolVarP(&mandatory, "mandatory", "m", false, "Make this variable mandatory")
	cmd.Flags().StringVar(&questionText, "question", "", "Question text displayed to users (required)")
	cmd.Flags().IntVarP(&order, "order", "o", 100, "Sort order for the variable")
	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Additional field values (name=value)")

	_ = cmd.MarkFlagRequired("type")
	_ = cmd.MarkFlagRequired("question")

	return cmd
}

// runCatalogItemCreateVariable executes the catalog-item create-variable command.
func runCatalogItemCreateVariable(cmd *cobra.Command, catItemSysID, varName, varType string, mandatory bool, questionText string, order int, fields []string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build the variable data
	data := map[string]interface{}{
		"cat_item":      catItemSysID,
		"name":          varName,
		"type":          varType,
		"question_text": questionText,
		"mandatory":     mandatory,
		"order":         order,
		"active":        true,
	}

	// Parse additional field flags
	for _, field := range fields {
		parts := strings.SplitN(field, "=", 2)
		if len(parts) != 2 {
			return output.ErrUsage(fmt.Sprintf("Invalid field format: %s (expected name=value)", field))
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		data[key] = value
	}

	// Create the variable in item_option_new table
	record, err := sdkClient.CreateRecord(cmd.Context(), "item_option_new", data)
	if err != nil {
		return fmt.Errorf("failed to create variable: %w", err)
	}

	sysID := getStringField(record, "sys_id")

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Created variable '%s' on catalog item", varName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn catalog-item %s", catItemSysID),
				Description: "View catalog item with variables",
			},
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn variable show %s", sysID),
				Description: "View variable details",
			},
		),
	)
}

// newCatalogItemVariablesCmd creates the catalog-item variables command.
func newCatalogItemVariablesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "variables <sys_id>",
		Short: "List variables on a catalog item",
		Long: `List all variables (questions) configured on a catalog item.

This queries the item_option_new table where cat_item references the catalog item.

Examples:
  jsn catalog-item variables cd21f895c3bbb2103c71770d050131a3`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCatalogItemVariables(cmd, args[0])
		},
	}
}

// runCatalogItemVariables executes the catalog-item variables command.
func runCatalogItemVariables(cmd *cobra.Command, catItemSysID string) error {
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

	// Query item_option_new directly where cat_item points to the catalog item
	varQuery := url.Values{}
	varQuery.Set("sysparm_limit", "100")
	varQuery.Set("sysparm_query", fmt.Sprintf("cat_item=%s^ORDERBYorder", catItemSysID))
	varQuery.Set("sysparm_fields", "sys_id,name,question_text,common_question,type,mandatory,order,active")
	varQuery.Set("sysparm_display_value", "true")

	varResp, err := sdkClient.Get(cmd.Context(), "item_option_new", varQuery)
	if err != nil {
		return fmt.Errorf("failed to get variable details: %w", err)
	}

	if len(varResp.Result) == 0 {
		return outputWriter.OK([]map[string]interface{}{},
			output.WithSummary("No variables found on this catalog item"),
		)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCatalogVariables(cmd, varResp.Result, catItemSysID, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCatalogVariables(cmd, varResp.Result, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         fmt.Sprintf("jsn catalog-item %s", catItemSysID),
			Description: "Show catalog item",
		},
		{
			Action:      "variable-types",
			Cmd:         "jsn variable-types",
			Description: "View variable type reference",
		},
	}

	return outputWriter.OK(varResp.Result,
		output.WithSummary(fmt.Sprintf("%d variables", len(varResp.Result))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledCatalogVariables outputs styled catalog variables list.
func printStyledCatalogVariables(cmd *cobra.Command, variables []map[string]interface{}, catItemSysID, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Catalog Item Variables"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-5s %-20s %-30s %-15s %s\n",
		mutedStyle.Render("Sys ID"),
		mutedStyle.Render("Order"),
		headerStyle.Render("Name"),
		headerStyle.Render("Question"),
		headerStyle.Render("Type"),
		headerStyle.Render("Required"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	for _, v := range variables {
		sysID := getStringField(v, "sys_id")
		order := getStringField(v, "order")
		name := getStringField(v, "name")
		question := getStringField(v, "question_text")
		if question == "" {
			question = getStringField(v, "common_question")
		}
		varType := getStringField(v, "type")
		mandatory := getStringField(v, "mandatory")
		active := getStringField(v, "active")

		// Truncate question if too long
		if len(question) > 28 {
			question = question[:25] + "..."
		}

		// Truncate name if too long
		if len(name) > 18 {
			name = name[:15] + "..."
		}

		// Convert type number to name
		typeName := variableTypeName(varType)

		// Style based on active status
		nameStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
		if active == "false" {
			nameStyle = mutedStyle
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-5s %-20s %-30s %-15s %s\n",
			mutedStyle.Render(sysID),
			mutedStyle.Render(order),
			nameStyle.Render(name),
			mutedStyle.Render(question),
			mutedStyle.Render(typeName),
			mutedStyle.Render(mandatory),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable add-choice <var_name> \"choice\"",
		labelStyle.Render("Add choice to dropdown variable"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable-types",
		labelStyle.Render("View variable type reference"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownCatalogVariables outputs markdown catalog variables list.
func printMarkdownCatalogVariables(cmd *cobra.Command, variables []map[string]interface{}, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "## Catalog Item Variables")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Order | Name | Question | Type | Required | Active |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|-------|------|----------|------|----------|--------|")

	for _, v := range variables {
		sysID := getStringField(v, "sys_id")
		order := getStringField(v, "order")
		name := getStringField(v, "name")
		question := getStringField(v, "question_text")
		if question == "" {
			question = getStringField(v, "common_question")
		}
		varType := getStringField(v, "type")
		mandatory := getStringField(v, "mandatory")
		active := getStringField(v, "active")

		typeName := variableTypeName(varType)

		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s | %s | %s |\n",
			sysID, order, name, question, typeName, mandatory, active)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// variableTypeName converts a variable type number to a human-readable name.
func variableTypeName(typeNum string) string {
	types := map[string]string{
		"1":  "Yes/No",
		"2":  "Multi Line Text",
		"3":  "Multiple Choice",
		"4":  "Numeric Scale",
		"5":  "Select Box",
		"6":  "Single Line Text",
		"7":  "CheckBox",
		"8":  "Reference",
		"9":  "Date",
		"10": "Date/Time",
		"11": "Label",
		"12": "Break",
		"14": "Macro",
		"15": "UI Page",
		"16": "Wide Single Line Text",
		"17": "Macro with Label",
		"18": "Lookup Select Box",
		"19": "Container Start",
		"20": "Container End",
		"21": "List Collector",
		"22": "Lookup Multiple Choice",
		"23": "HTML",
		"24": "Container Split",
		"25": "Masked",
		"26": "Email",
		"27": "URL",
		"28": "IP Address",
		"29": "Duration",
		"30": "Attachment",
	}

	if name, ok := types[typeNum]; ok {
		return name
	}
	return typeNum
}
