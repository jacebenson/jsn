package commands

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// tablesListFlags holds the flags for the tables list command.
type tablesListFlags struct {
	limit         int
	app           string
	showExtends   bool
	search        string
	order         string
	desc          bool
	all           bool
	noInteractive bool
}

// chainItem represents a table in the inheritance chain
type chainItem struct {
	Name  string
	Label string
	Scope string
	SysID string
}

// NewTablesCmd creates the tables command group.
func NewTablesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tables",
		Short: "Manage tables",
		Long:  "List and inspect ServiceNow tables via the Table API.",
	}

	cmd.AddCommand(
		newTablesListCmd(),
		newTablesShowCmd(),
		newTablesSchemaCmd(),
		newTablesColumnsCmd(),
		newTablesRelationshipsCmd(),
		newTablesDependenciesCmd(),
		newTablesDiagramCmd(),
	)

	return cmd
}

// newTablesListCmd creates the tables list command.
func newTablesListCmd() *cobra.Command {
	var flags tablesListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List tables",
		Long: `List tables from sys_db_object with optional filtering.

Interactive Mode:
  When running in a terminal, automatically uses an interactive picker
  that allows scrolling through all tables with pagination. Use --no-interactive
  to disable and get a static list output.

Filtering:
  --app <scope>        Filter by application scope
  --search <term>      Search name OR label LIKE term
  --search <query>     If contains '^', use as raw encoded query
  --no-interactive     Disable interactive mode (use static list output)

Examples:
  jsn tables list --search incident
  jsn tables list --search "name=incident^active=true"
  jsn tables list --app "incident" --show-extends --order label
  jsn tables list --no-interactive --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTablesList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 100, "Maximum number of tables to fetch (use with --no-interactive)")
	cmd.Flags().StringVar(&flags.app, "app", "", "Filter by application scope")
	cmd.Flags().BoolVar(&flags.showExtends, "show-extends", false, "Show what table each extends")
	cmd.Flags().StringVar(&flags.search, "search", "", "Search term or raw query (if contains '^')")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field (name, label, sys_created_on, etc.)")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all tables (no limit)")
	cmd.Flags().BoolVar(&flags.noInteractive, "no-interactive", false, "Disable interactive mode and show static list")

	return cmd
}

// runTablesList executes the tables list command.
func runTablesList(cmd *cobra.Command, flags tablesListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	// Get output writer
	outputWriter := appCtx.Output.(*output.Writer)

	// Get instance URL for links
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Determine if we should use interactive mode
	// Disable interactive mode when:
	// - Not in a terminal
	// - --no-interactive flag is set
	// - Explicit output format requested (json/md/quiet)
	// - Agent mode (via format detection)
	isTerminal := output.IsTTY(cmd.OutOrStdout())
	explicitFormat := cmd.Flags().Changed("json") || cmd.Flags().Changed("md") || cmd.Flags().Changed("quiet")
	isAgentMode := outputWriter.GetFormat() == output.FormatQuiet || outputWriter.GetFormat() == output.FormatJSON
	useInteractive := isTerminal && !flags.noInteractive && !explicitFormat && !isAgentMode

	// Interactive mode with pagination
	if useInteractive {
		// Build query for filtering
		var queryParts []string
		if flags.app != "" && flags.app != "global" {
			queryParts = append(queryParts, fmt.Sprintf("sys_scope.name=%s", flags.app))
		}
		if flags.search != "" {
			if strings.Contains(flags.search, "^") {
				queryParts = append(queryParts, flags.search)
			} else {
				queryParts = append(queryParts, fmt.Sprintf("nameLIKE%s^ORlabelLIKE%s", flags.search, flags.search))
			}
		}
		sysparmQuery := strings.Join(queryParts, "^")

		// Create paginated fetcher
		fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
			opts := &sdk.ListTablesOptions{
				Limit:       limit,
				Offset:      offset,
				Query:       sysparmQuery,
				OrderBy:     flags.order,
				OrderDesc:   flags.desc,
				ShowExtends: flags.showExtends,
			}
			tables, err := sdkClient.ListTables(ctx, opts)
			if err != nil {
				return nil, err
			}

			var items []tui.PickerItem
			for _, t := range tables {
				scope := t.Scope
				if scope == "" {
					scope = "global"
				}
				desc := fmt.Sprintf("%s (%s)", t.Label, scope)
				if t.Label == "" {
					desc = scope
				}
				items = append(items, tui.PickerItem{
					ID:          t.Name,
					Title:       t.Name,
					Description: desc,
				})
			}

			hasMore := len(tables) >= limit
			return &tui.PageResult{
				Items:   items,
				HasMore: hasMore,
			}, nil
		}

		// Show picker with pagination
		selected, err := tui.PickWithPagination("Select a table:", fetcher,
			tui.WithMaxVisible(15),
		)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}

		// After selection, show the table details
		return runTablesShow(cmd, selected.ID)
	}

	// Build query
	var queryParts []string

	// Application scope filter
	if flags.app != "" && flags.app != "global" {
		queryParts = append(queryParts, fmt.Sprintf("sys_scope.name=%s", flags.app))
	}

	// Search/query filter
	if flags.search != "" {
		if strings.Contains(flags.search, "^") {
			// Raw encoded query
			queryParts = append(queryParts, flags.search)
		} else {
			// Search name OR label
			queryParts = append(queryParts, fmt.Sprintf("nameLIKE%s^ORlabelLIKE%s", flags.search, flags.search))
		}
	}

	// Combine query parts
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	// Build options
	opts := &sdk.ListTablesOptions{
		Limit:       limit,
		Query:       sysparmQuery,
		OrderBy:     flags.order,
		OrderDesc:   flags.desc,
		ShowExtends: flags.showExtends,
	}

	tables, err := sdkClient.ListTables(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list tables: %w", err)
	}

	// Convert tables to maps for output
	var data []map[string]any
	for _, t := range tables {
		row := map[string]any{
			"name":  t.Name,
			"scope": t.Scope,
			"label": t.Label,
		}
		if row["scope"] == "" {
			row["scope"] = "global"
		}
		if flags.showExtends && t.SuperClass != "" {
			row["extends"] = t.SuperClass
		}
		// Add link for styled output with hyperlinks
		if instanceURL != "" {
			queryValue := url.QueryEscape(fmt.Sprintf("name=%s", t.Name))
			row["link"] = fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=%s", instanceURL, queryValue)
		}
		data = append(data, row)
	}

	// Output with summary and breadcrumbs
	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d tables", len(tables))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn tables show <name>",
				Description: "Show table details",
			},
		),
	)
}

// newTablesShowCmd creates the tables show command.
func newTablesShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [<name>]",
		Short: "Show table details",
		Long:  "Display detailed information about a table including columns and inheritance. If no name is provided, shows an interactive picker.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesShow(cmd, name)
		},
	}
}

// runTablesShow executes the tables show command.
func runTablesShow(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	// Get output writer
	outputWriter := appCtx.Output.(*output.Writer)

	// Get instance URL for links
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive mode if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		// Create paginated fetcher for tables
		fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
			opts := &sdk.ListTablesOptions{
				Limit:   limit,
				Offset:  offset,
				OrderBy: "name",
			}
			tables, err := sdkClient.ListTables(ctx, opts)
			if err != nil {
				return nil, err
			}

			var items []tui.PickerItem
			for _, t := range tables {
				scope := t.Scope
				if scope == "" {
					scope = "global"
				}
				desc := fmt.Sprintf("%s (%s)", t.Label, scope)
				if t.Label == "" {
					desc = scope
				}
				items = append(items, tui.PickerItem{
					ID:          t.Name,
					Title:       t.Name,
					Description: desc,
				})
			}

			hasMore := len(tables) >= limit
			return &tui.PageResult{
				Items:   items,
				HasMore: hasMore,
			}, nil
		}

		// Show picker with pagination
		selected, err := tui.PickWithPagination("Select a table:", fetcher,
			tui.WithMaxVisible(15),
		)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		name = selected.ID
	}

	// Get table details
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Get columns for the table
	columns, err := sdkClient.GetTableColumns(cmd.Context(), name)
	if err != nil {
		// Don't fail if we can't get columns, just show table details
		columns = nil
	}

	// Get parent table info if extends
	var parentTable *sdk.Table
	if table.SuperClass != "" {
		parentTable, _ = sdkClient.GetTable(cmd.Context(), table.SuperClass)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledTableDetails(cmd, table, columns, parentTable, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownTableDetails(cmd, table, columns, parentTable, instanceURL)
	}

	// Build result for JSON/quiet
	scope := table.Scope
	if scope == "" {
		scope = "global"
	}

	result := map[string]any{
		"name":          table.Name,
		"label":         table.Label,
		"sys_id":        table.SysID,
		"scope":         scope,
		"is_extendable": table.IsExtendable,
	}

	if table.SuperClass != "" {
		result["extends"] = table.SuperClass
		if parentTable != nil {
			result["extends_label"] = parentTable.Label
		}
	}

	if columns != nil {
		result["columns"] = len(columns)
	}

	// Build breadcrumbs
	var breadcrumbs []output.Breadcrumb
	if table.SuperClass != "" {
		breadcrumbs = append(breadcrumbs, output.Breadcrumb{
			Action:      "show",
			Cmd:         fmt.Sprintf("jsn tables show %s", table.SuperClass),
			Description: fmt.Sprintf("View parent table (%s)", table.SuperClass),
		})
	}
	breadcrumbs = append(breadcrumbs, output.Breadcrumb{
		Action:      "list",
		Cmd:         "jsn tables list",
		Description: "List all tables",
	})

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("%s (%s)", table.Label, table.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledTableDetails outputs styled table details.
func printStyledTableDetails(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn, parentTable *sdk.Table, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	title := fmt.Sprintf("%s (%s)", table.Label, table.Name)
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Metadata section
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Metadata"))

	scope := table.Scope
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Sys ID:"), valueStyle.Render(table.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Scope:"), valueStyle.Render(scope))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Extendable:"), valueStyle.Render(fmt.Sprintf("%v", table.IsExtendable)))

	if table.SuperClass != "" {
		parentStr := table.SuperClass
		if parentTable != nil && parentTable.Label != "" {
			parentStr = fmt.Sprintf("%s (%s)", parentTable.Label, table.SuperClass)
		}
		if instanceURL != "" {
			parentLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.SuperClass)
			parentStr = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", parentLink, parentStr)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Extends:"), valueStyle.Render(parentStr))
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n", labelStyle.Render("Link:"), link, link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Columns count in metadata
	if columns != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Columns:"), valueStyle.Render(fmt.Sprintf("%d", len(columns))))
	}

	// Hints section
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))

	if table.SuperClass != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			fmt.Sprintf("jsn tables show %s", table.SuperClass),
			labelStyle.Render(fmt.Sprintf("View parent (%s)", table.SuperClass)),
		)
	}
	if columns != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			fmt.Sprintf("jsn tables columns %s", table.Name),
			labelStyle.Render("View columns"),
		)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn tables list",
		labelStyle.Render("List all tables"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownTableDetails outputs markdown table details.
func printMarkdownTableDetails(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn, parentTable *sdk.Table, instanceURL string) error {
	title := fmt.Sprintf("**%s (%s)**", table.Label, table.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Metadata")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", table.SysID)

	scope := table.Scope
	if scope == "" {
		scope = "global"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", scope)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Extendable:** %v\n", table.IsExtendable)

	if table.SuperClass != "" {
		parentStr := table.SuperClass
		if parentTable != nil && parentTable.Label != "" {
			parentStr = fmt.Sprintf("%s (%s)", parentTable.Label, table.SuperClass)
		}
		if instanceURL != "" {
			parentLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.SuperClass)
			fmt.Fprintf(cmd.OutOrStdout(), "- **Extends:** %s — %s\n", parentStr, parentLink)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "- **Extends:** %s\n", parentStr)
		}
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Columns count
	if columns != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Columns:** %d\n", len(columns))
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())

	if table.SuperClass != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables show %s` — View parent (%s)\n", table.SuperClass, table.SuperClass)
	}
	if columns != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables columns %s` — View columns\n", table.Name)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables list` — List all tables\n")

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newTablesSchemaCmd creates the tables schema command.
func newTablesSchemaCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "schema [<name>]",
		Short: "Show detailed table schema",
		Long:  "Display detailed schema information for a table including all columns with types, references, defaults, and constraints. If no name is provided, shows an interactive picker.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesSchema(cmd, name)
		},
	}
}

// runTablesSchema executes the tables schema command.
func runTablesSchema(cmd *cobra.Command, name string) error {
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

	// Interactive mode if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		// Create paginated fetcher for tables
		fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
			opts := &sdk.ListTablesOptions{
				Limit:   limit,
				Offset:  offset,
				OrderBy: "name",
			}
			tables, err := sdkClient.ListTables(ctx, opts)
			if err != nil {
				return nil, err
			}

			var items []tui.PickerItem
			for _, t := range tables {
				scope := t.Scope
				if scope == "" {
					scope = "global"
				}
				desc := fmt.Sprintf("%s (%s)", t.Label, scope)
				if t.Label == "" {
					desc = scope
				}
				items = append(items, tui.PickerItem{
					ID:          t.Name,
					Title:       t.Name,
					Description: desc,
				})
			}

			hasMore := len(tables) >= limit
			return &tui.PageResult{
				Items:   items,
				HasMore: hasMore,
			}, nil
		}

		// Show picker with pagination
		selected, err := tui.PickWithPagination("Select a table:", fetcher,
			tui.WithMaxVisible(15),
		)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		name = selected.ID
	}

	// Get table details
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Get inheritance chain (parents - what this table extends FROM)
	var parentChain []chainItem
	currentTable := table
	for currentTable.SuperClass != "" {
		parent, err := sdkClient.GetTable(cmd.Context(), currentTable.SuperClass)
		if err != nil {
			break
		}
		parentChain = append([]chainItem{{
			Name:  parent.Name,
			Label: parent.Label,
			Scope: parent.Scope,
			SysID: parent.SysID,
		}}, parentChain...)
		currentTable = parent
	}

	// Get child tables (what extends this table)
	childTables, _ := sdkClient.GetChildTables(cmd.Context(), table.Name)

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledSchema(cmd, table, parentChain, childTables, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownSchema(cmd, table, parentChain, childTables, instanceURL)
	}

	// Build result for JSON/quiet
	scope := table.Scope
	if scope == "" {
		scope = "global"
	}

	result := map[string]any{
		"name":          table.Name,
		"label":         table.Label,
		"sys_id":        table.SysID,
		"scope":         scope,
		"is_extendable": table.IsExtendable,
	}

	if len(parentChain) > 0 {
		result["extends_from"] = parentChain
	}

	if len(childTables) > 0 {
		var childItems []map[string]string
		for _, child := range childTables {
			childScope := child.Scope
			if childScope == "" {
				childScope = "global"
			}
			childItems = append(childItems, map[string]string{
				"name":  child.Name,
				"label": child.Label,
				"scope": childScope,
			})
		}
		result["extends_to"] = childItems
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "columns",
			Cmd:         fmt.Sprintf("jsn tables columns %s", table.Name),
			Description: "View columns only",
		},
		{
			Action:      "list",
			Cmd:         "jsn tables list",
			Description: "List all tables",
		},
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("%s (%s)", table.Label, table.Name)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledSchema outputs styled schema details.
func printStyledSchema(cmd *cobra.Command, table *sdk.Table, parentChain []chainItem, childTables []sdk.Table, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	title := fmt.Sprintf("%s (%s)", table.Label, table.Name)
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Metadata section
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Metadata"))

	scope := table.Scope
	if scope == "" {
		scope = "global"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Sys ID:"), valueStyle.Render(table.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Scope:"), valueStyle.Render(scope))
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n", labelStyle.Render("Extendable:"), valueStyle.Render(fmt.Sprintf("%v", table.IsExtendable)))

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n", labelStyle.Render("Link:"), link, link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Inheritance tree view
	if len(parentChain) > 0 || len(childTables) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Inheritance Hierarchy"))
		fmt.Fprintln(cmd.OutOrStdout())

		// Print parent chain (single inheritance path - all use └──)
		for i, item := range parentChain {
			// Build indent - each level is 4 spaces
			var indent strings.Builder
			for d := 0; d < i; d++ {
				indent.WriteString("    ")
			}

			itemScope := item.Scope
			if itemScope == "" {
				itemScope = "global"
			}

			tableDisplay := fmt.Sprintf("%s (%s)", item.Name, item.Label)
			if instanceURL != "" {
				itemLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, item.Name)
				tableDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", itemLink, tableDisplay)
			}

			// Root (i=0) needs 4 spaces padding to align with └── below it
			// └── is 3 chars + 1 space = 4 chars total
			if i == 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "%s    %s  %s\n",
					indent.String(),
					valueStyle.Render(tableDisplay),
					labelStyle.Render(fmt.Sprintf("[%s]", itemScope)),
				)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "%s└── %s  %s\n",
					indent.String(),
					valueStyle.Render(tableDisplay),
					labelStyle.Render(fmt.Sprintf("[%s]", itemScope)),
				)
			}
		}

		// Print current table (highlighted)
		{
			var indent strings.Builder
			for d := 0; d < len(parentChain); d++ {
				indent.WriteString("    ")
			}

			itemScope := table.Scope
			if itemScope == "" {
				itemScope = "global"
			}

			targetStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
			tableDisplay := fmt.Sprintf("%s (%s) *", table.Name, table.Label)

			if instanceURL != "" {
				itemLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.Name)
				tableDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", itemLink, tableDisplay)
			}

			if len(childTables) > 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "%s└── %s  %s\n",
					indent.String(),
					targetStyle.Render(tableDisplay),
					labelStyle.Render(fmt.Sprintf("[%s]", itemScope)),
				)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "%s└── %s  %s\n",
					indent.String(),
					targetStyle.Render(tableDisplay),
					labelStyle.Render(fmt.Sprintf("[%s]", itemScope)),
				)
			}
		}

		// Print children
		if len(childTables) > 0 {
			// Print "[N children]" line
			{
				var indent strings.Builder
				for d := 0; d <= len(parentChain); d++ {
					indent.WriteString("    ")
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s├── %s\n",
					indent.String(),
					labelStyle.Render(fmt.Sprintf("[%d children]", len(childTables))),
				)
			}

			// Print each child
			for i, child := range childTables {
				var indent strings.Builder
				for d := 0; d <= len(parentChain); d++ {
					indent.WriteString("    ")
				}

				childScope := child.Scope
				if childScope == "" {
					childScope = "global"
				}

				tableDisplay := fmt.Sprintf("%s (%s)", child.Name, child.Label)
				if instanceURL != "" {
					childLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, child.Name)
					tableDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", childLink, tableDisplay)
				}

				// Last child uses └──, others use ├──
				branch := "├──"
				if i == len(childTables)-1 {
					branch = "└──"
				}

				fmt.Fprintf(cmd.OutOrStdout(), "%s%s %s  %s\n",
					indent.String(),
					branch,
					valueStyle.Render(tableDisplay),
					labelStyle.Render(fmt.Sprintf("[%s]", childScope)),
				)
			}
		}

		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Hints section
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))

	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn tables columns %s", table.Name),
		labelStyle.Render("View columns only"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn tables list",
		labelStyle.Render("List all tables"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownSchema outputs markdown schema details.
func printMarkdownSchema(cmd *cobra.Command, table *sdk.Table, parentChain []chainItem, childTables []sdk.Table, instanceURL string) error {
	title := fmt.Sprintf("**%s (%s)**", table.Label, table.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Metadata")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", table.SysID)

	scope := table.Scope
	if scope == "" {
		scope = "global"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Scope:** %s\n", scope)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Extendable:** %v\n", table.IsExtendable)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, table.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Inheritance FROM (parents)
	if len(parentChain) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "#### Extends From")
		fmt.Fprintln(cmd.OutOrStdout())
		for _, item := range parentChain {
			itemScope := item.Scope
			if itemScope == "" {
				itemScope = "global"
			}
			if instanceURL != "" {
				itemLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, item.Name)
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s** (%s) [%s] — %s\n", item.Name, item.Label, itemScope, itemLink)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s** (%s) [%s]\n", item.Name, item.Label, itemScope)
			}
		}
		// Show current table at the end
		fmt.Fprintf(cmd.OutOrStdout(), "- **%s** (%s) [%s] *\n", table.Name, table.Label, scope)
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Inheritance TO (children)
	if len(childTables) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "#### Extends To (%d)\n", len(childTables))
		fmt.Fprintln(cmd.OutOrStdout())
		for _, child := range childTables {
			childScope := child.Scope
			if childScope == "" {
				childScope = "global"
			}
			if instanceURL != "" {
				childLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_db_object.do?sysparm_query=name=%s", instanceURL, child.Name)
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s** (%s) [%s] — %s\n", child.Name, child.Label, childScope, childLink)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- **%s** (%s) [%s]\n", child.Name, child.Label, childScope)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables columns %s` — View columns only\n", table.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables list` — List all tables\n")

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newTablesColumnsCmd creates the tables columns command.
func newTablesColumnsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "columns [<name>]",
		Short: "Show table columns only",
		Long:  "Display only the columns for a table in a focused view. If no name is provided, shows an interactive picker.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesColumns(cmd, name)
		},
	}
}

// runTablesColumns executes the tables columns command.
func runTablesColumns(cmd *cobra.Command, name string) error {
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

	// Interactive mode if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		// Create paginated fetcher for tables
		fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
			opts := &sdk.ListTablesOptions{
				Limit:   limit,
				Offset:  offset,
				OrderBy: "name",
			}
			tables, err := sdkClient.ListTables(ctx, opts)
			if err != nil {
				return nil, err
			}

			var items []tui.PickerItem
			for _, t := range tables {
				scope := t.Scope
				if scope == "" {
					scope = "global"
				}
				desc := fmt.Sprintf("%s (%s)", t.Label, scope)
				if t.Label == "" {
					desc = scope
				}
				items = append(items, tui.PickerItem{
					ID:          t.Name,
					Title:       t.Name,
					Description: desc,
				})
			}

			hasMore := len(tables) >= limit
			return &tui.PageResult{
				Items:   items,
				HasMore: hasMore,
			}, nil
		}

		// Show picker with pagination
		selected, err := tui.PickWithPagination("Select a table:", fetcher,
			tui.WithMaxVisible(15),
		)
		if err != nil {
			return err
		}
		if selected == nil {
			return fmt.Errorf("selection cancelled")
		}
		name = selected.ID
	}

	// Get table details
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Get columns for the table
	columns, err := sdkClient.GetTableColumns(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get columns: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledColumns(cmd, table, columns, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownColumns(cmd, table, columns, instanceURL)
	}

	// Build result for JSON/quiet
	scope := table.Scope
	if scope == "" {
		scope = "global"
	}

	result := map[string]any{
		"name":    table.Name,
		"label":   table.Label,
		"scope":   scope,
		"columns": columns,
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "schema",
			Cmd:         fmt.Sprintf("jsn tables schema %s", table.Name),
			Description: fmt.Sprintf("View full schema (%s)", table.Name),
		},
		{
			Action:      "list",
			Cmd:         "jsn tables list",
			Description: "List all tables",
		},
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("%s (%s) - %d columns", table.Label, table.Name, len(columns))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledColumns outputs styled columns only view.
func printStyledColumns(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	title := fmt.Sprintf("%s (%s) - Columns", table.Label, table.Name)
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Columns list
	for _, col := range columns {
		colName := col.Name
		if col.Mandatory {
			colName = colName + " *"
		}

		colInfo := col.Label
		if col.Type != "" {
			colInfo = fmt.Sprintf("%s [%s]", colInfo, col.Type)
		}
		if col.Reference != "" {
			colInfo = fmt.Sprintf("%s → %s", colInfo, col.Reference)
		}
		if col.DefaultValue != "" {
			colInfo = fmt.Sprintf("%s (default: %s)", colInfo, col.DefaultValue)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-30s  %s\n",
			valueStyle.Render(colName),
			labelStyle.Render(colInfo),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints section
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn tables schema %s", table.Name),
		labelStyle.Render("View full schema"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn tables list",
		labelStyle.Render("List all tables"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownColumns outputs markdown columns only view.
func printMarkdownColumns(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn, instanceURL string) error {
	title := fmt.Sprintf("**%s (%s) - Columns**", table.Label, table.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	for _, col := range columns {
		mandatory := ""
		if col.Mandatory {
			mandatory = " *(required)*"
		}

		colInfo := col.Label
		if col.Type != "" {
			colInfo = fmt.Sprintf("%s [%s]", colInfo, col.Type)
		}
		if col.Reference != "" {
			colInfo = fmt.Sprintf("%s → %s", colInfo, col.Reference)
		}
		if col.DefaultValue != "" {
			colInfo = fmt.Sprintf("%s (default: %s)", colInfo, col.DefaultValue)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "- **%s**%s — %s\n", col.Name, mandatory, colInfo)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables schema %s` — View full schema\n", table.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables list` — List all tables\n")

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newTablesRelationshipsCmd creates the tables relationships command.
func newTablesRelationshipsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "relationships [<name>]",
		Short: "Show reference fields TO this table",
		Long: `Show tables that have reference fields pointing TO this table.

If no table name is provided, an interactive picker will help you select one.

Examples:
  jsn tables relationships incident
  jsn tables relationships  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesRelationships(cmd, name)
		},
	}
}

// runTablesRelationships executes the tables relationships command.
func runTablesRelationships(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table to view relationships:")
		if err != nil {
			return err
		}
		name = selectedTable
	}

	// Get the table
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Find reference fields pointing to this table
	columns, err := sdkClient.GetTableColumns(cmd.Context(), table.Name)
	if err != nil {
		return fmt.Errorf("failed to get columns: %w", err)
	}

	var referenceFields []map[string]string
	for _, col := range columns {
		if col.Reference == table.Name {
			referenceFields = append(referenceFields, map[string]string{
				"column": col.Name,
				"label":  col.Label,
				"table":  table.Name,
			})
		}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledRelationships(cmd, table.Name, referenceFields)
	}

	if format == output.FormatMarkdown {
		return printMarkdownRelationships(cmd, table.Name, referenceFields)
	}

	return outputWriter.OK(referenceFields,
		output.WithSummary(fmt.Sprintf("%d reference fields in %s", len(referenceFields), table.Name)),
	)
}

// printStyledRelationships outputs styled relationships.
func printStyledRelationships(cmd *cobra.Command, tableName string, fields []map[string]string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Reference Fields in %s", tableName)))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(fields) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No reference fields found."))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	for _, f := range fields {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s (%s)\n",
			f["column"],
			mutedStyle.Render(f["label"]),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownRelationships outputs markdown relationships.
func printMarkdownRelationships(cmd *cobra.Command, tableName string, fields []map[string]string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Reference Fields in %s**\n\n", tableName)

	if len(fields) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No reference fields found.")
		return nil
	}

	for _, f := range fields {
		fmt.Fprintf(cmd.OutOrStdout(), "- %s (%s)\n", f["column"], f["label"])
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newTablesDependenciesCmd creates the tables dependencies command.
func newTablesDependenciesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "dependencies [<name>]",
		Short: "Show what tables this table references",
		Long: `Show tables that this table has reference fields pointing TO.

If no table name is provided, an interactive picker will help you select one.

Examples:
  jsn tables dependencies incident
  jsn tables dependencies  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesDependencies(cmd, name)
		},
	}
}

// runTablesDependencies executes the tables dependencies command.
func runTablesDependencies(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table to view dependencies:")
		if err != nil {
			return err
		}
		name = selectedTable
	}

	// Get the table
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Find reference fields in this table
	columns, err := sdkClient.GetTableColumns(cmd.Context(), table.Name)
	if err != nil {
		return fmt.Errorf("failed to get columns: %w", err)
	}

	var references []map[string]string
	seen := make(map[string]bool)
	for _, col := range columns {
		if col.Reference != "" && !seen[col.Reference] {
			seen[col.Reference] = true
			references = append(references, map[string]string{
				"column":    col.Name,
				"label":     col.Label,
				"reference": col.Reference,
			})
		}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledDependencies(cmd, table.Name, references)
	}

	if format == output.FormatMarkdown {
		return printMarkdownDependencies(cmd, table.Name, references)
	}

	return outputWriter.OK(references,
		output.WithSummary(fmt.Sprintf("%d table references from %s", len(references), table.Name)),
	)
}

// printStyledDependencies outputs styled dependencies.
func printStyledDependencies(cmd *cobra.Command, tableName string, refs []map[string]string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Table References from %s", tableName)))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(refs) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No table references found."))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	for _, r := range refs {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s → %s (%s)\n",
			r["column"],
			r["reference"],
			mutedStyle.Render(r["label"]),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownDependencies outputs markdown dependencies.
func printMarkdownDependencies(cmd *cobra.Command, tableName string, refs []map[string]string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Table References from %s**\n\n", tableName)

	if len(refs) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No table references found.")
		return nil
	}

	for _, r := range refs {
		fmt.Fprintf(cmd.OutOrStdout(), "- %s → %s (%s)\n", r["column"], r["reference"], r["label"])
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newTablesDiagramCmd creates the tables diagram command.
func newTablesDiagramCmd() *cobra.Command {
	var format string

	cmd := &cobra.Command{
		Use:   "diagram [<name>]",
		Short: "Generate relationship diagram",
		Long: `Generate a relationship diagram for a table in Mermaid or DOT format.

If no table name is provided, an interactive picker will help you select one.

Examples:
  jsn tables diagram incident --format mermaid
  jsn tables diagram task --format dot`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var name string
			if len(args) > 0 {
				name = args[0]
			}
			return runTablesDiagram(cmd, name, format)
		},
	}

	cmd.Flags().StringVarP(&format, "format", "f", "mermaid", "Diagram format (mermaid, dot)")

	return cmd
}

// runTablesDiagram executes the tables diagram command.
func runTablesDiagram(cmd *cobra.Command, name, format string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no name provided
	if name == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table for diagram:")
		if err != nil {
			return err
		}
		name = selectedTable
	}

	// Get the table
	table, err := sdkClient.GetTable(cmd.Context(), name)
	if err != nil {
		return fmt.Errorf("failed to get table: %w", err)
	}

	// Get reference fields
	columns, err := sdkClient.GetTableColumns(cmd.Context(), table.Name)
	if err != nil {
		return fmt.Errorf("failed to get columns: %w", err)
	}

	// Generate diagram
	switch format {
	case "dot":
		return printDOTDiagram(cmd, table, columns)
	default:
		return printMermaidDiagram(cmd, table, columns)
	}
}

// printMermaidDiagram outputs a Mermaid diagram.
func printMermaidDiagram(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn) error {
	fmt.Fprintln(cmd.OutOrStdout(), "```mermaid")
	fmt.Fprintln(cmd.OutOrStdout(), "erDiagram")
	fmt.Fprintln(cmd.OutOrStdout())

	// Print the main table
	fmt.Fprintf(cmd.OutOrStdout(), "    %s {\n", table.Name)
	for _, col := range columns {
		if col.Reference == "" {
			fmt.Fprintf(cmd.OutOrStdout(), "        %s %s\n", col.Type, col.Name)
		}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "    }")
	fmt.Fprintln(cmd.OutOrStdout())

	// Print related tables and relationships
	seen := make(map[string]bool)
	for _, col := range columns {
		if col.Reference != "" && !seen[col.Reference] {
			seen[col.Reference] = true
			fmt.Fprintf(cmd.OutOrStdout(), "    %s ||--o{ %s : \"%s\"\n",
				table.Name, col.Reference, col.Name)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout(), "```")
	return nil
}

// printDOTDiagram outputs a DOT (Graphviz) diagram.
func printDOTDiagram(cmd *cobra.Command, table *sdk.Table, columns []sdk.TableColumn) error {
	fmt.Fprintln(cmd.OutOrStdout(), "digraph G {")
	fmt.Fprintln(cmd.OutOrStdout(), "    rankdir=LR;")
	fmt.Fprintln(cmd.OutOrStdout(), "    node [shape=box];")
	fmt.Fprintln(cmd.OutOrStdout())

	// Print nodes
	seen := make(map[string]bool)
	fmt.Fprintf(cmd.OutOrStdout(), "    \"%s\" [label=\"%s\"];\n", table.Name, table.Label)
	for _, col := range columns {
		if col.Reference != "" && !seen[col.Reference] {
			seen[col.Reference] = true
			fmt.Fprintf(cmd.OutOrStdout(), "    \"%s\";\n", col.Reference)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Print edges
	for _, col := range columns {
		if col.Reference != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "    \"%s\" -> \"%s\" [label=\"%s\"];\n",
				table.Name, col.Reference, col.Name)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout(), "}")
	return nil
}
