package commands

import (
	"context"
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// uiScriptsListFlags holds the flags for the ui-scripts list command.
type uiScriptsListFlags struct {
	limit int
	query string
	order string
	desc  bool
}

// NewUIScriptsCmd creates the ui-scripts command group.
func NewUIScriptsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "ui-scripts",
		Aliases: []string{"uiscripts", "ui-script", "uiscript"},
		Short:   "Manage UI Scripts",
		Long:    "List and view ServiceNow UI Scripts (sys_ui_script).",
	}

	cmd.AddCommand(
		newUIScriptsListCmd(),
		newUIScriptsShowCmd(),
	)

	return cmd
}

// newUIScriptsListCmd creates the ui-scripts list command.
func newUIScriptsListCmd() *cobra.Command {
	var flags uiScriptsListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List UI Scripts",
		Long: `List all ServiceNow UI Scripts.

Examples:
  jsn ui-scripts list
  jsn ui-scripts list --limit 50
  jsn ui-scripts list --query "active=true"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUIScriptsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of UI scripts to fetch")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")

	return cmd
}

// runUIScriptsList executes the ui-scripts list command.
func runUIScriptsList(cmd *cobra.Command, flags uiScriptsListFlags) error {
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

	opts := &sdk.ListUIScriptsOptions{
		Limit:     flags.limit,
		Query:     flags.query,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	scripts, err := sdkClient.ListUIScripts(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list UI scripts: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledUIScriptsList(cmd, scripts, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownUIScriptsList(cmd, scripts, instanceURL)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, script := range scripts {
		row := map[string]any{
			"sys_id":      script.SysID,
			"name":        script.Name,
			"description": script.Description,
			"active":      script.Active,
			"ui_type":     script.UIType,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_ui_script.do?sys_id=%s", instanceURL, script.SysID)
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         "jsn ui-scripts show <name>",
			Description: "Show UI script details",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d UI scripts", len(scripts))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledUIScriptsList outputs styled UI scripts list.
func printStyledUIScriptsList(cmd *cobra.Command, scripts []sdk.UIScript, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	brandStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("UI Scripts"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-30s %-20s %-10s %s\n",
		mutedStyle.Render("Name"),
		headerStyle.Render("UI Type"),
		headerStyle.Render("Active"),
		headerStyle.Render("Description"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// UI Scripts
	for _, script := range scripts {
		activeStr := "✓"
		if !script.Active {
			activeStr = "✗"
		}

		// Create hyperlink if instance URL available
		nameDisplay := script.Name
		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_ui_script.do?sys_id=%s", instanceURL, script.SysID)
			nameDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, script.Name)
		}

		desc := script.Description
		if len(desc) > 30 {
			desc = desc[:27] + "..."
		}
		if desc == "" {
			desc = "-"
		}

		uiType := script.UIType
		if uiType == "" {
			uiType = "All"
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-30s %-20s %-10s %s\n",
			brandStyle.Render(nameDisplay),
			labelStyle.Render(uiType),
			activeStr,
			mutedStyle.Render(desc),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn ui-scripts show <name>",
		labelStyle.Render("Show UI script details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownUIScriptsList outputs markdown UI scripts list.
func printMarkdownUIScriptsList(cmd *cobra.Command, scripts []sdk.UIScript, instanceURL string) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**UI Scripts**")
	fmt.Fprintln(cmd.OutOrStdout())

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Name | UI Type | Active | Description |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|---------|--------|-------------|")

	// UI Scripts
	for _, script := range scripts {
		activeStr := "Yes"
		if !script.Active {
			activeStr = "No"
		}
		uiType := script.UIType
		if uiType == "" {
			uiType = "All"
		}
		desc := script.Description
		if desc == "" {
			desc = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
			script.Name, uiType, activeStr, desc)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newUIScriptsShowCmd creates the ui-scripts show command.
func newUIScriptsShowCmd() *cobra.Command {
	var showScript bool

	cmd := &cobra.Command{
		Use:   "show [<name>]",
		Short: "Show UI script details",
		Long: `Display detailed information about a UI Script.

If no name is provided, an interactive picker will help you select one.

Use --script flag to show the script content.

Examples:
  jsn ui-scripts show pwd_enroll_questions_ui
  jsn ui-scripts show pwd_enroll_questions_ui --script`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runUIScriptsShow(cmd, name, showScript)
		},
	}

	cmd.Flags().BoolVar(&showScript, "script", false, "Show script content")

	return cmd
}

// runUIScriptsShow executes the ui-scripts show command.
func runUIScriptsShow(cmd *cobra.Command, name string, showScript bool) error {
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

	// Interactive picker if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("UI Script name is required in non-interactive mode")
		}

		selected, err := pickUIScript(cmd.Context(), sdkClient, "Select a UI script:")
		if err != nil {
			return err
		}
		name = selected
	}

	script, err := sdkClient.GetUIScript(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get UI script: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		if showScript {
			return printStyledUIScriptCode(cmd, script)
		}
		return printStyledUIScript(cmd, script, instanceURL)
	}

	if format == output.FormatMarkdown {
		if showScript {
			return printMarkdownUIScriptCode(cmd, script)
		}
		return printMarkdownUIScript(cmd, script, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         "jsn ui-scripts list",
			Description: "List all UI scripts",
		},
	}

	return outputWriter.OK(script,
		output.WithSummary(fmt.Sprintf("UI Script: %s", script.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledUIScript outputs styled UI script details.
func printStyledUIScript(cmd *cobra.Command, script *sdk.UIScript, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(script.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic Info
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Basic Information ─"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Name:"), valueStyle.Render(script.Name))
	if script.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Description:"), valueStyle.Render(script.Description))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("Active:"), valueStyle.Render(fmt.Sprintf("%v", script.Active)))
	uiType := script.UIType
	if uiType == "" {
		uiType = "All"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s  %s\n", labelStyle.Render("UI Type:"), valueStyle.Render(uiType))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_script.do?sys_id=%s", instanceURL, script.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("UI Script URL:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn ui-scripts list",
		labelStyle.Render("List all UI scripts"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn ui-scripts show %s --script", script.Name),
		labelStyle.Render("Show script content"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownUIScript outputs markdown UI script details.
func printMarkdownUIScript(cmd *cobra.Command, script *sdk.UIScript, instanceURL string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", script.Name)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Basic Information")
	fmt.Fprintf(cmd.OutOrStdout(), "- **Name:** %s\n", script.Name)
	if script.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", script.Description)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Active:** %v\n", script.Active)
	uiType := script.UIType
	if uiType == "" {
		uiType = "All"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **UI Type:** %s\n", uiType)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_ui_script.do?sys_id=%s", instanceURL, script.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **UI Script URL:** %s\n", link)
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "#### View Script")
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn ui-scripts show %s --script`\n", script.Name)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printStyledUIScriptCode outputs styled UI script with code.
func printStyledUIScriptCode(cmd *cobra.Command, script *sdk.UIScript) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#a6e22e"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(script.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Script section
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Script ─"))
	if script.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout(), codeStyle.Render(script.Script))
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  (empty)"))
	}
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownUIScriptCode outputs markdown UI script with code.
func printMarkdownUIScriptCode(cmd *cobra.Command, script *sdk.UIScript) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", script.Name)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Script")
	if script.Script != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "```javascript\n%s\n```\n\n", script.Script)
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "*(empty)*")
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// pickUIScript shows an interactive UI script picker and returns the selected name.
func pickUIScript(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListUIScriptsOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		scripts, err := sdkClient.ListUIScripts(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, s := range scripts {
			desc := s.Description
			if desc == "" {
				desc = fmt.Sprintf("UI Type: %s", s.UIType)
			}
			items = append(items, tui.PickerItem{
				ID:          s.Name,
				Title:       s.Name,
				Description: desc,
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
