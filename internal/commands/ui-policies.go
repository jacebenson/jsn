package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// uiPoliciesListFlags holds the flags for the ui-policies list command.
type uiPoliciesListFlags struct {
	limit  int
	table  string
	active bool
	search string
	query  string
	order  string
	desc   bool
	all    bool
}

// NewUIPoliciesCmd creates the ui-policies command group.
func NewUIPoliciesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ui-policies",
		Short: "Manage UI policies",
		Long:  "List and inspect ServiceNow UI policies (sys_ui_policy).",
	}

	cmd.AddCommand(
		newUIPoliciesListCmd(),
		newUIPoliciesShowCmd(),
		newUIPoliciesScriptCmd(),
	)

	return cmd
}

// newUIPoliciesListCmd creates the ui-policies list command.
func newUIPoliciesListCmd() *cobra.Command {
	var flags uiPoliciesListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI policies",
		Long: `List UI policies from sys_ui_policy.

Filtering:
  --search <term>   Fuzzy search on short_description (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering

Examples:
  jsn ui-policies list --table incident
  jsn ui-policies list --search approval
  jsn ui-policies list --active
  jsn ui-policies list --query "short_descriptionLIKEapproval^active=true" --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUIPoliciesList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of policies to fetch")
	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active policies")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on short_description")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "order" for execution sequence - policies run in this order on forms
	cmd.Flags().StringVar(&flags.order, "order", "order", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all policies (no limit)")

	return cmd
}

// runUIPoliciesList executes the ui-policies list command.
func runUIPoliciesList(cmd *cobra.Command, flags uiPoliciesListFlags) error {
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
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.search != "" {
		queryParts = append(queryParts, fmt.Sprintf("short_descriptionLIKE%s", flags.search))
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_ui_policy"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListUIPoliciesOptions{
		Table:     flags.table,
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	policies, err := sdkClient.ListUIPolicies(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list UI policies: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a policy to view (auto-detect TTY)
	useInteractive := isTerminal && !appCtx.NoInteractive() && format == output.FormatAuto
	if useInteractive {
		selectedPolicy, err := pickUIPolicyFromList(policies)
		if err != nil {
			return err
		}
		if selectedPolicy == "" {
			return fmt.Errorf("no policy selected")
		}
		// Show the selected policy
		return runUIPoliciesShow(cmd, selectedPolicy)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUIPoliciesList(cmd, policies, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUIPoliciesList(cmd, policies)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, policy := range policies {
		row := map[string]any{
			"sys_id":           policy.SysID,
			"name":             policy.Name,
			"active":           policy.Active,
			"table":            policy.Table,
			"order":            policy.Order,
			"onload":           policy.OnLoad,
			"onchange":         policy.OnChange,
			"run_scripts":      policy.RunScripts,
			"reverse_if_false": policy.ReverseIfFalse,
			"sys_updated_on":   policy.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_ui_policy.do?sys_id=%s", instanceURL, policy.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d UI policies", len(policies))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn ui-policies show <sys_id>",
				Description: "Show policy details",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         "jsn ui-policies script <sys_id>",
				Description: "View scripts only",
			},
		),
	)
}

// printStyledUIPoliciesList outputs styled UI policies list.
func printStyledUIPoliciesList(cmd *cobra.Command, policies []sdk.UIPolicy, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("UI Policies"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-20s %-8s %-10s %-10s\n",
		headerStyle.Render("Sys ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Table"),
		headerStyle.Render("Order"),
		headerStyle.Render("On Load"),
		headerStyle.Render("On Change"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Policies
	for _, policy := range policies {
		statusStyle := activeStyle
		if !policy.Active {
			statusStyle = inactiveStyle
		}

		name := policy.Name
		if len(name) > 30 {
			name = name[:27] + "..."
		}

		onLoad := "No"
		if policy.OnLoad {
			onLoad = "Yes"
		}

		onChange := "No"
		if policy.OnChange {
			onChange = "Yes"
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_ui_policy.do?sys_id=%s", instanceURL, policy.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-20s %-8s %-10s %-10s\n",
				mutedStyle.Render(policy.SysID),
				nameWithLink,
				mutedStyle.Render(policy.Table),
				statusStyle.Render(fmt.Sprintf("%d", policy.Order)),
				mutedStyle.Render(onLoad),
				mutedStyle.Render(onChange),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-20s %-8s %-10s %-10s\n",
				mutedStyle.Render(policy.SysID),
				name,
				mutedStyle.Render(policy.Table),
				statusStyle.Render(fmt.Sprintf("%d", policy.Order)),
				mutedStyle.Render(onLoad),
				mutedStyle.Render(onChange),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn ui-policies show <sys_id>",
		mutedStyle.Render("Show policy details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn ui-policies script <sys_id>",
		mutedStyle.Render("View scripts only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownUIPoliciesList outputs markdown UI policies list.
func printMarkdownUIPoliciesList(cmd *cobra.Command, policies []sdk.UIPolicy) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**UI Policies**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Name | Table | Order | On Load | On Change |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------|-------|-------|---------|-----------|")

	for _, policy := range policies {
		onLoad := "No"
		if policy.OnLoad {
			onLoad = "Yes"
		}
		onChange := "No"
		if policy.OnChange {
			onChange = "Yes"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %d | %s | %s |\n", policy.SysID, policy.Name, policy.Table, policy.Order, onLoad, onChange)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newUIPoliciesShowCmd creates the ui-policies show command.
func newUIPoliciesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [<sys_id>]",
		Short: "Show UI policy details",
		Long: `Display detailed information about a UI policy.

If no sys_id is provided, an interactive picker will help you select one.

Examples:
  jsn ui-policies show 0123456789abcdef0123456789abcdef
  jsn ui-policies show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var sysID string
			if len(args) > 0 {
				sysID = args[0]
			}
			return runUIPoliciesShow(cmd, sysID)
		},
	}
}

// runUIPoliciesShow executes the ui-policies show command.
func runUIPoliciesShow(cmd *cobra.Command, sysID string) error {
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

	// Interactive policy selection if no sys_id provided
	if sysID == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("UI policy sys_id is required in non-interactive mode")
		}

		selectedPolicy, err := pickUIPolicy(cmd.Context(), sdkClient, "Select a UI policy:")
		if err != nil {
			return err
		}
		sysID = selectedPolicy
	}

	// Get the policy
	policy, err := sdkClient.GetUIPolicy(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get UI policy: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUIPolicy(cmd, policy, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUIPolicy(cmd, policy, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":            policy.SysID,
		"name":              policy.Name,
		"active":            policy.Active,
		"table":             policy.Table,
		"short_description": policy.ShortDesc,
		"order":             policy.Order,
		"run_scripts":       policy.RunScripts,
		"isolate_script":    policy.IsolateScript,
		"onload":            policy.OnLoad,
		"onchange":          policy.OnChange,
		"conditions":        policy.Conditions,
		"script_true":       policy.ScriptTrue,
		"script_false":      policy.ScriptFalse,
		"reverse_if_false":  policy.ReverseIfFalse,
		"inherited":         policy.Inherited,
		"scope":             policy.Scope,
		"sys_created_on":    policy.CreatedOn,
		"sys_created_by":    policy.CreatedBy,
		"sys_updated_on":    policy.UpdatedOn,
		"sys_updated_by":    policy.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_ui_policy.do?sys_id=%s", instanceURL, policy.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("UI Policy: %s", policy.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn ui-policies list",
				Description: "List all policies",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         fmt.Sprintf("jsn ui-policies script %s", sysID),
				Description: "View scripts only",
			},
		),
	)
}

// printStyledUIPolicy outputs styled UI policy details.
func printStyledUIPolicy(cmd *cobra.Command, policy *sdk.UIPolicy, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(policy.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !policy.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(policy.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Table:"), valueStyle.Render(policy.Table))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Order:"), valueStyle.Render(fmt.Sprintf("%d", policy.Order)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("On Load:"), valueStyle.Render(fmt.Sprintf("%v", policy.OnLoad)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("On Change:"), valueStyle.Render(fmt.Sprintf("%v", policy.OnChange)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Run Scripts:"), valueStyle.Render(fmt.Sprintf("%v", policy.RunScripts)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Reverse If False:"), valueStyle.Render(fmt.Sprintf("%v", policy.ReverseIfFalse)))

	if policy.ShortDesc != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(policy.ShortDesc))
	}

	if policy.Conditions != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Conditions:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(policy.Conditions))
	}

	// Script sections
	if policy.ScriptTrue != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script (True):"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(policy.ScriptTrue, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	if policy.ScriptFalse != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script (False):"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(policy.ScriptFalse, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", policy.CreatedOn, policy.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", policy.UpdatedOn, policy.UpdatedBy)))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_policy.do?sys_id=%s", instanceURL, policy.SysID)
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
		"jsn ui-policies list",
		mutedStyle.Render("List all policies"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn ui-policies script %s", policy.SysID),
		mutedStyle.Render("View scripts only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownUIPolicy outputs markdown UI policy details.
func printMarkdownUIPolicy(cmd *cobra.Command, policy *sdk.UIPolicy, instanceURL string) error {
	status := "Active"
	if !policy.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", policy.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", policy.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Table:** %s\n", policy.Table)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Order:** %d\n", policy.Order)
	fmt.Fprintf(cmd.OutOrStdout(), "- **On Load:** %v\n", policy.OnLoad)
	fmt.Fprintf(cmd.OutOrStdout(), "- **On Change:** %v\n", policy.OnChange)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Run Scripts:** %v\n", policy.RunScripts)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Reverse If False:** %v\n", policy.ReverseIfFalse)
	if policy.ShortDesc != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", policy.ShortDesc)
	}
	if policy.Conditions != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Conditions:** %s\n", policy.Conditions)
	}

	if policy.ScriptTrue != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script (True):**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), policy.ScriptTrue)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	if policy.ScriptFalse != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script (False):**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), policy.ScriptFalse)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n- **Created:** %s by %s\n", policy.CreatedOn, policy.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", policy.UpdatedOn, policy.UpdatedBy)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_policy.do?sys_id=%s", instanceURL, policy.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newUIPoliciesScriptCmd creates the ui-policies script command.
func newUIPoliciesScriptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "script <sys_id>",
		Short: "Output the UI policy scripts",
		Long: `Output the script content of a UI policy.

Both "Execute if true" and "Execute if false" scripts are displayed
if they exist.

Examples:
  jsn ui-policies script 0123456789abcdef0123456789abcdef
  jsn ui-policies script 0123456789abcdef0123456789abcdef > scripts.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUIPoliciesScript(cmd, args[0])
		},
	}
}

// runUIPoliciesScript executes the ui-policies script command.
func runUIPoliciesScript(cmd *cobra.Command, sysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the policy
	policy, err := sdkClient.GetUIPolicy(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get UI policy: %w", err)
	}

	// Output scripts
	if policy.ScriptTrue != "" {
		fmt.Fprintln(cmd.OutOrStdout(), "// Execute if true")
		fmt.Fprintln(cmd.OutOrStdout(), policy.ScriptTrue)
	}

	if policy.ScriptFalse != "" {
		if policy.ScriptTrue != "" {
			fmt.Fprintln(cmd.OutOrStdout())
		}
		fmt.Fprintln(cmd.OutOrStdout(), "// Execute if false")
		fmt.Fprintln(cmd.OutOrStdout(), policy.ScriptFalse)
	}

	if policy.ScriptTrue == "" && policy.ScriptFalse == "" {
		fmt.Fprintln(cmd.OutOrStdout(), "// No scripts defined for this UI policy")
	}

	return nil
}

// pickUIPolicy shows an interactive UI policy picker and returns the selected policy sys_id.
func pickUIPolicy(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListUIPoliciesOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		policies, err := sdkClient.ListUIPolicies(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, p := range policies {
			status := "Active"
			if !p.Active {
				status = "Inactive"
			}
			items = append(items, tui.PickerItem{
				ID:          p.SysID,
				Title:       p.Name,
				Description: fmt.Sprintf("%s - %s", p.Table, status),
			})
		}

		hasMore := len(policies) >= limit
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

// pickUIPolicyFromList shows a picker from an already-fetched list of UI policies.
func pickUIPolicyFromList(policies []sdk.UIPolicy) (string, error) {
	var items []tui.PickerItem
	for _, p := range policies {
		status := "Active"
		if !p.Active {
			status = "Inactive"
		}
		items = append(items, tui.PickerItem{
			ID:          p.SysID,
			Title:       p.Name,
			Description: fmt.Sprintf("%s - %s", p.Table, status),
		})
	}

	selected, err := tui.Pick("Select a UI policy to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
