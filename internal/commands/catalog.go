package commands

import (
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

// NewCatalogItemCmd creates the catalog-item command group.
func NewCatalogItemCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "catalog-item",
		Aliases: []string{"cat-item", "ci"},
		Short:   "Manage Service Catalog items",
		Long:    "List, show, and manage Service Catalog items and their variables.",
	}

	cmd.AddCommand(
		newCatalogItemListCmd(),
		newCatalogItemShowCmd(),
		newCatalogItemVariablesCmd(),
	)

	return cmd
}

// catalogItemListFlags holds the flags for the catalog-item list command.
type catalogItemListFlags struct {
	limit   int
	catalog string
	active  bool
	query   string
}

// newCatalogItemListCmd creates the catalog-item list command.
func newCatalogItemListCmd() *cobra.Command {
	var flags catalogItemListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List catalog items",
		Long: `List Service Catalog items with optional filtering.

Examples:
  jsn catalog-item list
  jsn catalog-item list --catalog "Service Catalog"
  jsn catalog-item list --active --limit 50
  jsn catalog-item list --query "nameLIKEphone"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCatalogItemList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of items to fetch")
	cmd.Flags().StringVar(&flags.catalog, "catalog", "", "Filter by catalog name")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Only show active items")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")

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
			Cmd:         "jsn catalog-item show <sys_id>",
			Description: "Show item details",
		},
		{
			Action:      "variables",
			Cmd:         "jsn catalog-item variables <sys_id>",
			Description: "List item variables",
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
		"jsn catalog-item show <sys_id>",
		labelStyle.Render("Show item details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item variables <sys_id>",
		labelStyle.Render("List variables on item"),
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

// newCatalogItemShowCmd creates the catalog-item show command.
func newCatalogItemShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "show <sys_id_or_name>",
		Aliases: []string{"get"},
		Short:   "Show catalog item details",
		Long: `Display detailed information about a catalog item.

Examples:
  jsn catalog-item show cd21f895c3bbb2103c71770d050131a3
  jsn catalog-item show "Order Nothing Phone"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCatalogItemShow(cmd, args[0])
		},
	}
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

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCatalogItem(cmd, item, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCatalogItem(cmd, item, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "variables",
			Cmd:         fmt.Sprintf("jsn catalog-item variables %s", sysID),
			Description: "List item variables",
		},
		{
			Action:      "list",
			Cmd:         "jsn catalog-item list",
			Description: "List all catalog items",
		},
	}

	return outputWriter.OK(item,
		output.WithSummary(fmt.Sprintf("Catalog item: %s", getStringField(item, "name"))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledCatalogItem outputs styled catalog item details.
func printStyledCatalogItem(cmd *cobra.Command, item map[string]interface{}, instanceURL string) error {
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

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn catalog-item variables %s", sysID),
		labelStyle.Render("List item variables"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn catalog-item list",
		labelStyle.Render("List all catalog items"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownCatalogItem outputs markdown catalog item details.
func printMarkdownCatalogItem(cmd *cobra.Command, item map[string]interface{}, instanceURL string) error {
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

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
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
	varQuery.Set("sysparm_fields", "sys_id,name,question_text,type,mandatory,order,active")
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
			Cmd:         fmt.Sprintf("jsn catalog-item show %s", catItemSysID),
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
	fmt.Fprintf(cmd.OutOrStdout(), "  %-5s %-20s %-35s %-15s %s\n",
		mutedStyle.Render("Order"),
		headerStyle.Render("Name"),
		headerStyle.Render("Question"),
		headerStyle.Render("Type"),
		headerStyle.Render("Required"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	for _, v := range variables {
		order := getStringField(v, "order")
		name := getStringField(v, "name")
		question := getStringField(v, "question_text")
		varType := getStringField(v, "type")
		mandatory := getStringField(v, "mandatory")
		active := getStringField(v, "active")

		// Truncate question if too long
		if len(question) > 33 {
			question = question[:30] + "..."
		}

		// Convert type number to name
		typeName := variableTypeName(varType)

		// Style based on active status
		nameStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
		if active == "false" {
			nameStyle = mutedStyle
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-5s %-20s %-35s %-15s %s\n",
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
	fmt.Fprintln(cmd.OutOrStdout(), "| Order | Name | Question | Type | Required | Active |")
	fmt.Fprintln(cmd.OutOrStdout(), "|-------|------|----------|------|----------|--------|")

	for _, v := range variables {
		order := getStringField(v, "order")
		name := getStringField(v, "name")
		question := getStringField(v, "question_text")
		varType := getStringField(v, "type")
		mandatory := getStringField(v, "mandatory")
		active := getStringField(v, "active")

		typeName := variableTypeName(varType)

		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s | %s |\n",
			order, name, question, typeName, mandatory, active)
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
