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

// scriptIncludesListFlags holds the flags for the script-includes list command.
type scriptIncludesListFlags struct {
	limit       int
	scope       string
	active      bool
	query       string
	order       string
	desc        bool
	all         bool
	interactive bool
}

// NewScriptIncludesCmd creates the script-includes command group.
func NewScriptIncludesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "script-includes",
		Aliases: []string{"scripts"},
		Short:   "Manage script includes",
		Long:    "List and inspect ServiceNow script includes (sys_script_include).",
	}

	cmd.AddCommand(
		newScriptIncludesListCmd(),
		newScriptIncludesShowCmd(),
		newScriptIncludesCodeCmd(),
	)

	return cmd
}

// newScriptIncludesListCmd creates the script-includes list command.
func newScriptIncludesListCmd() *cobra.Command {
	var flags scriptIncludesListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List script includes",
		Long: `List script includes from sys_script_include.

Examples:
  jsn script-includes list
  jsn script-includes list --scope global
  jsn script-includes list --active --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScriptIncludesList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of script includes to fetch")
	cmd.Flags().StringVarP(&flags.scope, "scope", "s", "", "Filter by scope")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active script includes")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all script includes (no limit)")
	cmd.Flags().BoolVarP(&flags.interactive, "interactive", "i", false, "Interactive mode - select a script include to view details")

	return cmd
}

// runScriptIncludesList executes the script-includes list command.
func runScriptIncludesList(cmd *cobra.Command, flags scriptIncludesListFlags) error {
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
	if flags.scope != "" {
		queryParts = append(queryParts, fmt.Sprintf("sys_scope.scope=%s", flags.scope))
	}
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_script_include"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListScriptIncludesOptions{
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	scripts, err := sdkClient.ListScriptIncludes(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list script includes: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a script include to view
	if flags.interactive && isTerminal {
		selectedScript, err := pickScriptIncludeFromList(scripts)
		if err != nil {
			return err
		}
		if selectedScript == "" {
			return fmt.Errorf("no script include selected")
		}
		// Show the selected script include
		return runScriptIncludesShow(cmd, selectedScript)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledScriptIncludesList(cmd, scripts, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownScriptIncludesList(cmd, scripts)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, script := range scripts {
		row := map[string]any{
			"sys_id":         script.SysID,
			"name":           script.Name,
			"active":         script.Active,
			"scope":          script.Scope,
			"sys_scope":      script.SysScope,
			"sys_updated_on": script.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_script_include.do?sys_id=%s", instanceURL, script.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d script includes", len(scripts))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn script-includes show <name>",
				Description: "Show script include details",
			},
			output.Breadcrumb{
				Action:      "code",
				Cmd:         "jsn script-includes code <name>",
				Description: "View code only",
			},
		),
	)
}

// printStyledScriptIncludesList outputs styled script-includes list.
func printStyledScriptIncludesList(cmd *cobra.Command, scripts []sdk.ScriptInclude, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Script Includes"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
		headerStyle.Render("Name"),
		headerStyle.Render("Status"),
		headerStyle.Render("Scope"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Scripts
	for _, script := range scripts {
		status := "Active"
		statusStyle := activeStyle
		if !script.Active {
			status = "Inactive"
			statusStyle = inactiveStyle
		}

		scope := script.Scope
		if scope == "" {
			scope = script.SysScope
		}
		if scope == "" {
			scope = "global"
		}

		name := script.Name
		if len(name) > 38 {
			name = name[:35] + "..."
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_script_include.do?sys_id=%s", instanceURL, script.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
				nameWithLink,
				statusStyle.Render(status),
				mutedStyle.Render(scope),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-20s\n",
				name,
				statusStyle.Render(status),
				mutedStyle.Render(scope),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn script-includes show <name>",
		mutedStyle.Render("Show script include details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn script-includes code <name>",
		mutedStyle.Render("View code only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownScriptIncludesList outputs markdown script-includes list.
func printMarkdownScriptIncludesList(cmd *cobra.Command, scripts []sdk.ScriptInclude) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Script Includes**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Name | Status | Scope |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|--------|-------|")

	for _, script := range scripts {
		status := "Active"
		if !script.Active {
			status = "Inactive"
		}
		scope := script.Scope
		if scope == "" {
			scope = script.SysScope
		}
		if scope == "" {
			scope = "global"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s |\n", script.Name, status, scope)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newScriptIncludesShowCmd creates the script-includes show command.
func newScriptIncludesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [<name>]",
		Short: "Show script include details",
		Long: `Display detailed information about a script include.

If no name is provided, an interactive picker will help you select one.

Examples:
  jsn script-includes show "MyScriptInclude"
  jsn script-includes show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runScriptIncludesShow(cmd, name)
		},
	}
}

// runScriptIncludesShow executes the script-includes show command.
func runScriptIncludesShow(cmd *cobra.Command, name string) error {
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

	// Interactive script include selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Script include name is required in non-interactive mode")
		}

		selectedScript, err := pickScriptInclude(cmd.Context(), sdkClient, "Select a script include:")
		if err != nil {
			return err
		}
		name = selectedScript
	}

	// Get the script include
	script, err := sdkClient.GetScriptInclude(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get script include: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledScriptInclude(cmd, script, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownScriptInclude(cmd, script, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         script.SysID,
		"name":           script.Name,
		"active":         script.Active,
		"scope":          script.Scope,
		"sys_scope":      script.SysScope,
		"description":    script.Description,
		"script":         script.Script,
		"sys_created_on": script.CreatedOn,
		"sys_updated_on": script.UpdatedOn,
		"sys_created_by": script.CreatedBy,
		"sys_updated_by": script.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_script_include.do?sys_id=%s", instanceURL, script.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Script Include: %s", script.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn script-includes list",
				Description: "List all script includes",
			},
			output.Breadcrumb{
				Action:      "code",
				Cmd:         fmt.Sprintf("jsn script-includes code %s", script.Name),
				Description: "View code only",
			},
		),
	)
}

// printStyledScriptInclude outputs styled script include details.
func printStyledScriptInclude(cmd *cobra.Command, script *sdk.ScriptInclude, instanceURL string) error {
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

	scope := script.Scope
	if scope == "" {
		scope = script.SysScope
	}
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(script.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Scope:"), valueStyle.Render(scope))

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
		link := fmt.Sprintf("%s/sys_script_include.do?sys_id=%s", instanceURL, script.SysID)
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
		"jsn script-includes list",
		mutedStyle.Render("List all script includes"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn script-includes code %s", script.Name),
		mutedStyle.Render("View code only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownScriptInclude outputs markdown script include details.
func printMarkdownScriptInclude(cmd *cobra.Command, script *sdk.ScriptInclude, instanceURL string) error {
	status := "Active"
	if !script.Active {
		status = "Inactive"
	}

	scope := script.Scope
	if scope == "" {
		scope = script.SysScope
	}
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", script.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", script.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", scope)
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
		link := fmt.Sprintf("%s/sys_script_include.do?sys_id=%s", instanceURL, script.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newScriptIncludesCodeCmd creates the script-includes code command.
func newScriptIncludesCodeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "code <name>",
		Short: "Output just the code",
		Long: `Output only the script code of a script include.

Examples:
  jsn script-includes code "MyScriptInclude"
  jsn script-includes code "MyScriptInclude" > script.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runScriptIncludesCode(cmd, args[0])
		},
	}
}

// runScriptIncludesCode executes the script-includes code command.
func runScriptIncludesCode(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the script include
	script, err := sdkClient.GetScriptInclude(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get script include: %w", err)
	}

	// Just output the code
	fmt.Fprintln(cmd.OutOrStdout(), script.Script)
	return nil
}

// pickScriptInclude shows an interactive script include picker and returns the selected name.
func pickScriptInclude(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListScriptIncludesOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		scripts, err := sdkClient.ListScriptIncludes(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, s := range scripts {
			scope := s.Scope
			if scope == "" {
				scope = s.SysScope
			}
			if scope == "" {
				scope = "global"
			}
			items = append(items, tui.PickerItem{
				ID:          s.Name,
				Title:       s.Name,
				Description: scope,
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

// pickScriptIncludeFromList shows a picker from an already-fetched list of script includes.
func pickScriptIncludeFromList(scripts []sdk.ScriptInclude) (string, error) {
	var items []tui.PickerItem
	for _, s := range scripts {
		scope := s.Scope
		if scope == "" {
			scope = s.SysScope
		}
		if scope == "" {
			scope = "global"
		}
		status := "Active"
		if !s.Active {
			status = "Inactive"
		}
		items = append(items, tui.PickerItem{
			ID:          s.Name,
			Title:       s.Name,
			Description: fmt.Sprintf("%s - %s", scope, status),
		})
	}

	selected, err := tui.Pick("Select a script include to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
