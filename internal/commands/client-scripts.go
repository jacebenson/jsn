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

// clientScriptsListFlags holds the flags for the client-scripts list command.
type clientScriptsListFlags struct {
	limit      int
	table      string
	scriptType string
	active     bool
	search     string
	query      string
	order      string
	desc       bool
	all        bool
}

// NewClientScriptsCmd creates the client-scripts command.
func NewClientScriptsCmd() *cobra.Command {
	var flags clientScriptsListFlags

	cmd := &cobra.Command{
		Use:   "client-scripts [<name_or_sys_id>]",
		Short: "Manage client scripts",
		Long: `List and inspect ServiceNow client scripts (sys_script_client).

With no arguments, lists client scripts (with optional filters).
With a name or sys_id argument, shows details for that client script.

Examples:
  jsn client-scripts                          # List client scripts (interactive)
  jsn client-scripts --search validate        # Search by name
  jsn client-scripts --table incident         # Filter by table
  jsn client-scripts --type onLoad            # Filter by type
  jsn client-scripts --active --limit 50      # Active only, limit 50
  jsn client-scripts MyClientScript           # Show details for a client script
  jsn client-scripts <sys_id>                 # Show by sys_id`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return runClientScriptsShow(cmd, args[0])
			}
			return runClientScriptsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of scripts to fetch")
	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().StringVar(&flags.scriptType, "type", "", "Filter by type (onLoad, onChange, onSubmit, onCellEdit)")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active scripts")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on name")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "order" for execution sequence - scripts run in this order on forms
	cmd.Flags().StringVar(&flags.order, "order", "order", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all scripts (no limit)")

	cmd.AddCommand(
		newClientScriptsScriptCmd(),
	)

	return cmd
}

// runClientScriptsList executes the client-scripts list command.
func runClientScriptsList(cmd *cobra.Command, flags clientScriptsListFlags) error {
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
		queryParts = append(queryParts, fmt.Sprintf("nameLIKE%s", flags.search))
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_script_client"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListClientScriptsOptions{
		Table:     flags.table,
		Type:      flags.scriptType,
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	scripts, err := sdkClient.ListClientScripts(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list client scripts: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a script to view (auto-detect TTY)
	useInteractive := isTerminal && !appCtx.NoInteractive() && format == output.FormatAuto
	if useInteractive {
		selectedScript, err := pickClientScriptFromList(scripts)
		if err != nil {
			return err
		}
		if selectedScript == "" {
			return fmt.Errorf("no script selected")
		}
		// Show the selected script
		return runClientScriptsShow(cmd, selectedScript)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledClientScriptsList(cmd, scripts, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownClientScriptsList(cmd, scripts)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, script := range scripts {
		row := map[string]any{
			"sys_id":         script.SysID,
			"name":           script.Name,
			"active":         script.Active,
			"table":          script.Table,
			"type":           script.Type,
			"field_name":     script.FieldName,
			"order":          script.Order,
			"ui_type":        script.UiType,
			"sys_updated_on": script.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_script_client.do?sys_id=%s", instanceURL, script.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d client scripts", len(scripts))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn client-scripts <name>",
				Description: "Show script details",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         "jsn client-scripts script <sys_id>",
				Description: "View script only",
			},
		),
	)
}

// printStyledClientScriptsList outputs styled client scripts list.
func printStyledClientScriptsList(cmd *cobra.Command, scripts []sdk.ClientScript, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Client Scripts"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-15s %-12s %-8s %-10s\n",
		headerStyle.Render("Sys ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Table"),
		headerStyle.Render("Type"),
		headerStyle.Render("Order"),
		headerStyle.Render("UI Type"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Scripts
	for _, script := range scripts {
		statusStyle := activeStyle
		if !script.Active {
			statusStyle = inactiveStyle
		}

		name := script.Name
		if len(name) > 30 {
			name = name[:27] + "..."
		}

		table := script.Table
		if len(table) > 13 {
			table = table[:10] + "..."
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_script_client.do?sys_id=%s", instanceURL, script.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-15s %-12s %-8s %-10s\n",
				mutedStyle.Render(script.SysID),
				nameWithLink,
				mutedStyle.Render(table),
				statusStyle.Render(script.Type),
				mutedStyle.Render(fmt.Sprintf("%d", script.Order)),
				mutedStyle.Render(script.UiType),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-32s %-15s %-12s %-8s %-10s\n",
				mutedStyle.Render(script.SysID),
				name,
				mutedStyle.Render(table),
				statusStyle.Render(script.Type),
				mutedStyle.Render(fmt.Sprintf("%d", script.Order)),
				mutedStyle.Render(script.UiType),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn client-scripts <name>",
		mutedStyle.Render("Show script details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn client-scripts script <sys_id>",
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownClientScriptsList outputs markdown client scripts list.
func printMarkdownClientScriptsList(cmd *cobra.Command, scripts []sdk.ClientScript) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Client Scripts**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Name | Table | Type | Order | UI Type |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------|-------|------|-------|---------|")

	for _, script := range scripts {
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %d | %s |\n", script.SysID, script.Name, script.Table, script.Type, script.Order, script.UiType)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// runClientScriptsShow executes the client-scripts show command.
func runClientScriptsShow(cmd *cobra.Command, sysID string) error {
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

	// Interactive script selection if no sys_id provided
	if sysID == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Client script sys_id is required in non-interactive mode")
		}

		selectedScript, err := pickClientScript(cmd.Context(), sdkClient, "Select a client script:")
		if err != nil {
			return err
		}
		sysID = selectedScript
	}

	// Get the script
	script, err := sdkClient.GetClientScript(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get client script: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledClientScript(cmd, script, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownClientScript(cmd, script, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         script.SysID,
		"name":           script.Name,
		"active":         script.Active,
		"table":          script.Table,
		"type":           script.Type,
		"field_name":     script.FieldName,
		"order":          script.Order,
		"script":         script.Script,
		"isolate_script": script.Isolate,
		"ui_type":        script.UiType,
		"description":    script.Description,
		"scope":          script.Scope,
		"sys_created_on": script.CreatedOn,
		"sys_created_by": script.CreatedBy,
		"sys_updated_on": script.UpdatedOn,
		"sys_updated_by": script.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_script_client.do?sys_id=%s", instanceURL, script.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Client Script: %s", script.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn client-scripts --search <term>",
				Description: "List all scripts",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         fmt.Sprintf("jsn client-scripts script %s", sysID),
				Description: "View script only",
			},
		),
	)
}

// printStyledClientScript outputs styled client script details.
func printStyledClientScript(cmd *cobra.Command, script *sdk.ClientScript, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(script.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !script.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(script.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Table:"), valueStyle.Render(script.Table))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Type:"), valueStyle.Render(script.Type))
	if script.FieldName != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Field:"), valueStyle.Render(script.FieldName))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Order:"), valueStyle.Render(fmt.Sprintf("%d", script.Order)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("UI Type:"), valueStyle.Render(script.UiType))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Isolate Script:"), valueStyle.Render(fmt.Sprintf("%v", script.Isolate)))

	if script.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(script.Description))
	}

	// Script section
	if script.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script:"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(script.Script, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", script.CreatedOn, script.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", script.UpdatedOn, script.UpdatedBy)))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_script_client.do?sys_id=%s", instanceURL, script.SysID)
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
		"jsn client-scripts --search <term>",
		mutedStyle.Render("List all scripts"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn client-scripts script %s", script.SysID),
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownClientScript outputs markdown client script details.
func printMarkdownClientScript(cmd *cobra.Command, script *sdk.ClientScript, instanceURL string) error {
	status := "Active"
	if !script.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", script.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", script.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Table:** %s\n", script.Table)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Type:** %s\n", script.Type)
	if script.FieldName != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Field:** %s\n", script.FieldName)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Order:** %d\n", script.Order)
	fmt.Fprintf(cmd.OutOrStdout(), "- **UI Type:** %s\n", script.UiType)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Isolate Script:** %v\n", script.Isolate)
	if script.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", script.Description)
	}

	if script.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script:**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), script.Script)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n- **Created:** %s by %s\n", script.CreatedOn, script.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", script.UpdatedOn, script.UpdatedBy)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_script_client.do?sys_id=%s", instanceURL, script.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newClientScriptsScriptCmd creates the client-scripts script command.
func newClientScriptsScriptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "script <sys_id>",
		Short: "Output just the script",
		Long: `Output only the script content of a client script.

Examples:
  jsn client-scripts script 0123456789abcdef0123456789abcdef
  jsn client-scripts script 0123456789abcdef0123456789abcdef > script.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runClientScriptsScript(cmd, args[0])
		},
	}
}

// runClientScriptsScript executes the client-scripts script command.
func runClientScriptsScript(cmd *cobra.Command, sysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the script
	script, err := sdkClient.GetClientScript(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get client script: %w", err)
	}

	// Just output the script
	fmt.Fprintln(cmd.OutOrStdout(), script.Script)
	return nil
}

// pickClientScript shows an interactive client script picker and returns the selected script sys_id.
func pickClientScript(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListClientScriptsOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		scripts, err := sdkClient.ListClientScripts(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, s := range scripts {
			status := "Active"
			if !s.Active {
				status = "Inactive"
			}
			items = append(items, tui.PickerItem{
				ID:          s.SysID,
				Title:       s.Name,
				Description: fmt.Sprintf("%s - %s - %s", s.Table, s.Type, status),
			})
		}

		hasMore := len(scripts) >= limit
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

// pickClientScriptFromList shows a picker from an already-fetched list of client scripts.
func pickClientScriptFromList(scripts []sdk.ClientScript) (string, error) {
	var items []tui.PickerItem
	for _, s := range scripts {
		status := "Active"
		if !s.Active {
			status = "Inactive"
		}
		items = append(items, tui.PickerItem{
			ID:          s.SysID,
			Title:       s.Name,
			Description: fmt.Sprintf("%s - %s - %s", s.Table, s.Type, status),
		})
	}

	selected, err := tui.Pick("Select a client script to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
