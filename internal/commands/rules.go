package commands

import (
	"context"
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// rulesListFlags holds the flags for the rules list command.
type rulesListFlags struct {
	limit       int
	table       string
	active      bool
	query       string
	order       string
	desc        bool
	all         bool
	interactive bool
}

// NewRulesCmd creates the rules command group.
func NewRulesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rules",
		Short: "Manage business rules",
		Long:  "List and inspect ServiceNow business rules (sys_script).",
	}

	cmd.AddCommand(
		newRulesListCmd(),
		newRulesShowCmd(),
		newRulesScriptCmd(),
	)

	return cmd
}

// newRulesListCmd creates the rules list command.
func newRulesListCmd() *cobra.Command {
	var flags rulesListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List business rules",
		Long: `List business rules from sys_script.

Examples:
  jsn rules list --table incident
  jsn rules list --active
  jsn rules list --query "nameLIKEapproval" --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRulesList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of rules to fetch")
	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active rules")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all rules (no limit)")
	cmd.Flags().BoolVarP(&flags.interactive, "interactive", "i", false, "Interactive mode - select a rule to view details")

	return cmd
}

// runRulesList executes the rules list command.
func runRulesList(cmd *cobra.Command, flags rulesListFlags) error {
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
	var queryParts []string
	if flags.table != "" {
		queryParts = append(queryParts, fmt.Sprintf("collection=%s", flags.table))
	}
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_script"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListRulesOptions{
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	rules, err := sdkClient.ListRules(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list rules: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a rule to view
	if flags.interactive && isTerminal {
		selectedRule, err := pickRuleFromList(rules)
		if err != nil {
			return err
		}
		if selectedRule == "" {
			return fmt.Errorf("no rule selected")
		}
		// Show the selected rule
		return runRulesShow(cmd, selectedRule)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledRulesList(cmd, rules, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownRulesList(cmd, rules)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, rule := range rules {
		row := map[string]any{
			"sys_id":         rule.SysID,
			"name":           rule.Name,
			"active":         rule.Active,
			"table":          rule.Collection,
			"when":           rule.When,
			"order":          rule.Order,
			"sys_updated_on": rule.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_script.do?sys_id=%s", instanceURL, rule.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d business rules", len(rules))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn rules show <sys_id>",
				Description: "Show rule details",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         "jsn rules script <sys_id>",
				Description: "View script only",
			},
		),
	)
}

// printStyledRulesList outputs styled rules list.
func printStyledRulesList(cmd *cobra.Command, rules []sdk.BusinessRule, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Business Rules"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-35s %-15s %-10s %-8s\n",
		headerStyle.Render("Name"),
		headerStyle.Render("Table"),
		headerStyle.Render("When"),
		headerStyle.Render("Order"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Rules
	for _, rule := range rules {
		statusStyle := activeStyle
		if !rule.Active {
			statusStyle = inactiveStyle
		}

		name := rule.Name
		if len(name) > 33 {
			name = name[:30] + "..."
		}

		table := rule.Collection
		if table == "" {
			table = "global"
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_script.do?sys_id=%s", instanceURL, rule.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-35s %-15s %-10s %-8s\n",
				nameWithLink,
				mutedStyle.Render(table),
				mutedStyle.Render(rule.When),
				statusStyle.Render(fmt.Sprintf("%d", rule.Order)),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-35s %-15s %-10s %-8s\n",
				name,
				mutedStyle.Render(table),
				mutedStyle.Render(rule.When),
				statusStyle.Render(fmt.Sprintf("%d", rule.Order)),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn rules show <sys_id>",
		mutedStyle.Render("Show rule details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn rules script <sys_id>",
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownRulesList outputs markdown rules list.
func printMarkdownRulesList(cmd *cobra.Command, rules []sdk.BusinessRule) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Business Rules**\n")
	fmt.Fprintln(cmd.OutOrStdout(), "| Name | Table | When | Order |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|-------|------|-------|")

	for _, rule := range rules {
		table := rule.Collection
		if table == "" {
			table = "global"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %d |\n", rule.Name, table, rule.When, rule.Order)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newRulesShowCmd creates the rules show command.
func newRulesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [<sys_id>]",
		Short: "Show business rule details",
		Long: `Display detailed information about a business rule.

If no sys_id is provided, an interactive picker will help you select one.

Examples:
  jsn rules show 0123456789abcdef0123456789abcdef
  jsn rules show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var sysID string
			if len(args) > 0 {
				sysID = args[0]
			}
			return runRulesShow(cmd, sysID)
		},
	}
}

// runRulesShow executes the rules show command.
func runRulesShow(cmd *cobra.Command, sysID string) error {
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

	// Interactive rule selection if no sys_id provided
	if sysID == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Rule sys_id is required in non-interactive mode")
		}

		selectedRule, err := pickRule(cmd.Context(), sdkClient, "Select a business rule:")
		if err != nil {
			return err
		}
		sysID = selectedRule
	}

	// Get the rule
	rule, err := sdkClient.GetRule(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get rule: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledRule(cmd, rule, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownRule(cmd, rule, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         rule.SysID,
		"name":           rule.Name,
		"active":         rule.Active,
		"collection":     rule.Collection,
		"when":           rule.When,
		"order":          rule.Order,
		"filter":         rule.Filter,
		"condition":      rule.Condition,
		"description":    rule.Description,
		"script":         rule.Script,
		"sys_created_on": rule.CreatedOn,
		"sys_updated_on": rule.UpdatedOn,
		"sys_created_by": rule.CreatedBy,
		"sys_updated_by": rule.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_script.do?sys_id=%s", instanceURL, rule.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Business Rule: %s", rule.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn rules list",
				Description: "List all rules",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         fmt.Sprintf("jsn rules script %s", sysID),
				Description: "View script only",
			},
		),
	)
}

// printStyledRule outputs styled rule details.
func printStyledRule(cmd *cobra.Command, rule *sdk.BusinessRule, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(rule.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !rule.Active {
		status = "Inactive"
	}

	table := rule.Collection
	if table == "" {
		table = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(rule.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Table:"), valueStyle.Render(table))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("When:"), valueStyle.Render(rule.When))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Order:"), valueStyle.Render(fmt.Sprintf("%d", rule.Order)))

	if rule.Filter != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Filter Condition:"), valueStyle.Render(rule.Filter))
	}
	if rule.Condition != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Advanced Condition:"), valueStyle.Render(rule.Condition))
	}

	if rule.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(rule.Description))
	}

	// Script section
	if rule.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script:"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(rule.Script, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", rule.CreatedOn, rule.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", rule.UpdatedOn, rule.UpdatedBy)))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_script.do?sys_id=%s", instanceURL, rule.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			mutedStyle.Render("Link:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn rules list",
		mutedStyle.Render("List all rules"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn rules script %s", rule.SysID),
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownRule outputs markdown rule details.
func printMarkdownRule(cmd *cobra.Command, rule *sdk.BusinessRule, instanceURL string) error {
	status := "Active"
	if !rule.Active {
		status = "Inactive"
	}

	table := rule.Collection
	if table == "" {
		table = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", rule.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", rule.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Table:** %s\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- **When:** %s\n", rule.When)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Order:** %d\n", rule.Order)
	if rule.Filter != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Filter Condition:** %s\n", rule.Filter)
	}
	if rule.Condition != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Advanced Condition:** %s\n", rule.Condition)
	}
	if rule.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", rule.Description)
	}

	if rule.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script:**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), rule.Script)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n- **Created:** %s by %s\n", rule.CreatedOn, rule.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", rule.UpdatedOn, rule.UpdatedBy)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_script.do?sys_id=%s", instanceURL, rule.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newRulesScriptCmd creates the rules script command.
func newRulesScriptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "script <sys_id>",
		Short: "Output just the script",
		Long: `Output only the script content of a business rule.

Examples:
  jsn rules script 0123456789abcdef0123456789abcdef
  jsn rules script 0123456789abcdef0123456789abcdef > script.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRulesScript(cmd, args[0])
		},
	}
}

// runRulesScript executes the rules script command.
func runRulesScript(cmd *cobra.Command, sysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the rule
	rule, err := sdkClient.GetRule(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get rule: %w", err)
	}

	// Just output the script
	fmt.Fprintln(cmd.OutOrStdout(), rule.Script)
	return nil
}

// pickRule shows an interactive rule picker and returns the selected rule sys_id.
func pickRule(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListRulesOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		rules, err := sdkClient.ListRules(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, r := range rules {
			table := r.Collection
			if table == "" {
				table = "global"
			}
			items = append(items, tui.PickerItem{
				ID:          r.SysID,
				Title:       r.Name,
				Description: fmt.Sprintf("%s - %s", table, r.When),
			})
		}

		hasMore := len(rules) >= limit
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

// pickRuleFromList shows a picker from an already-fetched list of rules.
func pickRuleFromList(rules []sdk.BusinessRule) (string, error) {
	var items []tui.PickerItem
	for _, r := range rules {
		table := r.Collection
		if table == "" {
			table = "global"
		}
		items = append(items, tui.PickerItem{
			ID:          r.SysID,
			Title:       r.Name,
			Description: fmt.Sprintf("%s - %s", table, r.When),
		})
	}

	selected, err := tui.Pick("Select a rule to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
