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

// aclsListFlags holds the flags for the acls list command.
type aclsListFlags struct {
	limit     int
	table     string
	operation string
	aclType   string
	active    bool
	search    string
	query     string
	order     string
	desc      bool
	all       bool
}

// NewACLsCmd creates the acls command.
func NewACLsCmd() *cobra.Command {
	var flags aclsListFlags

	cmd := &cobra.Command{
		Use:   "acls [<name_or_sys_id>]",
		Short: "Manage Access Control Lists (ACLs)",
		Long: `List and inspect ServiceNow ACLs (sys_security_acl).

Usage:
  jsn acls                                    Interactive picker (TTY) or usage info
  jsn acls <name_or_sys_id>                   Show ACL details
  jsn acls --search <term>                    Fuzzy search on name (LIKE match)
  jsn acls --query <encoded_query>            Raw ServiceNow encoded query

Filtering:
  --search <term>   Fuzzy search on name (LIKE match)
  --query <query>   Raw ServiceNow encoded query for advanced filtering
  --table <name>    Filter by table name
  --active          Show only active ACLs

Examples:
  jsn acls "incident.read"
  jsn acls --table incident
  jsn acls --search read
  jsn acls --operation write
  jsn acls --type record
  jsn acls --active --json
  jsn acls --query "nameLIKEread^active=true" --limit 50`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct lookup by name or sys_id
			if len(args) > 0 {
				return runACLsShow(cmd, args[0])
			}

			// Mode 2 & 3: Search/list (handles interactive picker when no filters)
			return runACLsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of ACLs to fetch")
	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().StringVarP(&flags.operation, "operation", "o", "", "Filter by operation (read, write, create, delete, execute)")
	cmd.Flags().StringVar(&flags.aclType, "type", "", "Filter by ACL type (record, field, processor, etc.)")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active ACLs")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on name")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	// Default order: "name" for alphabetical browsing - most intuitive for finding ACLs
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all ACLs (no limit)")

	cmd.AddCommand(
		newACLsScriptCmd(),
		newACLsCheckCmd(),
	)

	return cmd
}

// runACLsList executes the acls list command.
func runACLsList(cmd *cobra.Command, flags aclsListFlags) error {
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
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, "sys_security_acl"))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListACLOptions{
		Table:     flags.table,
		Operation: flags.operation,
		Type:      flags.aclType,
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	acls, err := sdkClient.ListACLs(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list ACLs: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - auto-detect TTY unless disabled or explicit format requested
	// Show picker automatically in terminal when no explicit format is requested
	if isTerminal && !appCtx.NoInteractive() && format == output.FormatAuto {
		selectedACL, err := pickACLFromList(acls)
		if err != nil {
			return err
		}
		if selectedACL == "" {
			return fmt.Errorf("no ACL selected")
		}
		// Show the selected ACL
		return runACLsShow(cmd, selectedACL)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledACLsList(cmd, acls, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownACLsList(cmd, acls)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, acl := range acls {
		row := map[string]any{
			"sys_id":          acl.SysID,
			"name":            acl.Name,
			"active":          acl.Active,
			"operation":       acl.Operation,
			"type":            acl.Type,
			"field":           acl.Field,
			"advanced":        acl.Advanced,
			"admin_overrides": acl.AdminOver,
			"sys_updated_on":  acl.UpdatedOn,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d ACLs", len(acls))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn acls <name>",
				Description: "Show ACL details",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         "jsn acls script <sys_id>",
				Description: "View script only",
			},
		),
	)
}

// printStyledACLsList outputs styled ACLs list.
func printStyledACLsList(cmd *cobra.Command, acls []sdk.ACL, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Access Control Lists (ACLs)"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-10s %-10s\n",
		headerStyle.Render("Sys ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Operation"),
		headerStyle.Render("Type"),
		headerStyle.Render("Advanced"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// ACLs
	for _, acl := range acls {
		statusStyle := activeStyle
		if !acl.Active {
			statusStyle = inactiveStyle
		}

		name := acl.Name
		if len(name) > 34 {
			name = name[:31] + "..."
		}

		advanced := "No"
		if acl.Advanced {
			advanced = "Yes"
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-10s %-10s\n",
				mutedStyle.Render(acl.SysID),
				nameWithLink,
				statusStyle.Render(acl.Operation),
				mutedStyle.Render(acl.Type),
				mutedStyle.Render(advanced),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-36s %-12s %-10s %-10s\n",
				mutedStyle.Render(acl.SysID),
				name,
				statusStyle.Render(acl.Operation),
				mutedStyle.Render(acl.Type),
				mutedStyle.Render(advanced),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn acls <name>",
		mutedStyle.Render("Show ACL details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn acls script <sys_id>",
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownACLsList outputs markdown ACLs list.
func printMarkdownACLsList(cmd *cobra.Command, acls []sdk.ACL) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Access Control Lists (ACLs)**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Name | Operation | Type | Advanced |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|------|-----------|------|----------|")

	for _, acl := range acls {
		advanced := "No"
		if acl.Advanced {
			advanced = "Yes"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s |\n", acl.SysID, acl.Name, acl.Operation, acl.Type, advanced)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// runACLsShow executes the acls show command.
func runACLsShow(cmd *cobra.Command, sysID string) error {
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

	// Interactive ACL selection if no sys_id provided
	if sysID == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("ACL sys_id is required in non-interactive mode")
		}

		selectedACL, err := pickACL(cmd.Context(), sdkClient, "Select an ACL:")
		if err != nil {
			return err
		}
		sysID = selectedACL
	}

	// Get the ACL
	acl, err := sdkClient.GetACL(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get ACL: %w", err)
	}

	// Get roles for this ACL
	roles, err := sdkClient.GetACLRoles(cmd.Context(), sysID)
	if err != nil {
		// Non-fatal - just show ACL without roles
		roles = []sdk.ACLRole{}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledACL(cmd, acl, roles, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownACL(cmd, acl, roles, instanceURL)
	}

	// Build role list for JSON
	var roleList []map[string]string
	for _, role := range roles {
		roleList = append(roleList, map[string]string{
			"sys_id": role.SysID,
			"role":   role.Role,
			"name":   role.RoleName,
		})
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":          acl.SysID,
		"name":            acl.Name,
		"active":          acl.Active,
		"operation":       acl.Operation,
		"type":            acl.Type,
		"field":           acl.Field,
		"advanced":        acl.Advanced,
		"condition":       acl.Condition,
		"script":          acl.Script,
		"description":     acl.Description,
		"admin_overrides": acl.AdminOver,
		"scope":           acl.Scope,
		"roles":           roleList,
		"sys_created_on":  acl.CreatedOn,
		"sys_created_by":  acl.CreatedBy,
		"sys_updated_on":  acl.UpdatedOn,
		"sys_updated_by":  acl.UpdatedBy,
	}
	if instanceURL != "" {
		data["link"] = fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("ACL: %s", acl.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn acls",
				Description: "List all ACLs",
			},
			output.Breadcrumb{
				Action:      "script",
				Cmd:         fmt.Sprintf("jsn acls script %s", sysID),
				Description: "View script only",
			},
		),
	)
}

// printStyledACL outputs styled ACL details.
func printStyledACL(cmd *cobra.Command, acl *sdk.ACL, roles []sdk.ACLRole, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(acl.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !acl.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(acl.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Operation:"), valueStyle.Render(acl.Operation))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Type:"), valueStyle.Render(acl.Type))
	if acl.Field != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Field:"), valueStyle.Render(acl.Field))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Advanced:"), valueStyle.Render(fmt.Sprintf("%v", acl.Advanced)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Admin Overrides:"), valueStyle.Render(fmt.Sprintf("%v", acl.AdminOver)))

	if acl.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(acl.Description))
	}

	if acl.Condition != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Condition:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(acl.Condition))
	}

	// Roles section
	if len(roles) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Required Roles:"))
		for _, role := range roles {
			if role.RoleName != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "    • %s\n", valueStyle.Render(role.RoleName))
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "    • %s\n", valueStyle.Render(role.Role))
			}
		}
	}

	// Script section
	if acl.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script:"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(acl.Script, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", acl.CreatedOn, acl.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", acl.UpdatedOn, acl.UpdatedBy)))

	// Link
	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
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
		"jsn acls",
		mutedStyle.Render("List all ACLs"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn acls script %s", acl.SysID),
		mutedStyle.Render("View script only"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownACL outputs markdown ACL details.
func printMarkdownACL(cmd *cobra.Command, acl *sdk.ACL, roles []sdk.ACLRole, instanceURL string) error {
	status := "Active"
	if !acl.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", acl.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", acl.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Operation:** %s\n", acl.Operation)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Type:** %s\n", acl.Type)
	if acl.Field != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Field:** %s\n", acl.Field)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "- **Advanced:** %v\n", acl.Advanced)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Admin Overrides:** %v\n", acl.AdminOver)
	if acl.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", acl.Description)
	}
	if acl.Condition != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Condition:** %s\n", acl.Condition)
	}

	if len(roles) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Required Roles:**")
		for _, role := range roles {
			if role.RoleName != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", role.RoleName)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", role.Role)
			}
		}
	}

	if acl.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script:**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), acl.Script)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n- **Created:** %s by %s\n", acl.CreatedOn, acl.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", acl.UpdatedOn, acl.UpdatedBy)

	if instanceURL != "" {
		link := fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newACLsScriptCmd creates the acls script command.
func newACLsScriptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "script <sys_id>",
		Short: "Output just the script",
		Long: `Output only the script content of an ACL.

Examples:
  jsn acls script 0123456789abcdef0123456789abcdef
  jsn acls script 0123456789abcdef0123456789abcdef > script.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runACLsScript(cmd, args[0])
		},
	}
}

// runACLsScript executes the acls script command.
func runACLsScript(cmd *cobra.Command, sysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the ACL
	acl, err := sdkClient.GetACL(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get ACL: %w", err)
	}

	// Just output the script
	fmt.Fprintln(cmd.OutOrStdout(), acl.Script)
	return nil
}

// newACLsCheckCmd creates the acls check command.
func newACLsCheckCmd() *cobra.Command {
	var table, operation string

	cmd := &cobra.Command{
		Use:   "check",
		Short: "Check ACL coverage for a table",
		Long: `Check ACL coverage for a specific table and operation.

This command shows which ACLs apply to a given table and operation,
helping you understand security coverage and potential gaps.

Examples:
  jsn acls check --table incident --operation read
  jsn acls check --table task --operation write
  jsn acls check --table problem --operation create`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runACLsCheck(cmd, table, operation)
		},
	}

	cmd.Flags().StringVarP(&table, "table", "t", "", "Table name to check (required)")
	cmd.Flags().StringVarP(&operation, "operation", "o", "", "Operation to check: read, write, create, delete, execute (required)")
	if err := cmd.MarkFlagRequired("table"); err != nil {
		panic(err)
	}
	if err := cmd.MarkFlagRequired("operation"); err != nil {
		panic(err)
	}

	return cmd
}

// runACLsCheck executes the acls check command.
func runACLsCheck(cmd *cobra.Command, table, operation string) error {
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

	// Build query to find matching ACLs
	// ACL names are typically in format: table.operation or table.field.operation
	var queryParts []string
	queryParts = append(queryParts, fmt.Sprintf("nameSTARTSWITH%s.", table))
	queryParts = append(queryParts, fmt.Sprintf("operation=%s", operation))
	queryParts = append(queryParts, "active=true")
	sysparmQuery := strings.Join(queryParts, "^")

	opts := &sdk.ListACLOptions{
		Table:     table,
		Operation: operation,
		Limit:     100,
		Query:     sysparmQuery,
		OrderBy:   "name",
	}

	acls, err := sdkClient.ListACLs(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to check ACLs: %w", err)
	}

	// Filter to only ACLs that match the table prefix pattern
	var matchingACLs []sdk.ACL
	for _, acl := range acls {
		// Check if ACL name starts with table name
		if strings.HasPrefix(acl.Name, table+".") && acl.Operation == operation && acl.Active {
			matchingACLs = append(matchingACLs, acl)
		}
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledACLCheck(cmd, table, operation, matchingACLs, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownACLCheck(cmd, table, operation, matchingACLs)
	}

	// Build data for JSON/quiet output
	var aclList []map[string]any
	for _, acl := range matchingACLs {
		row := map[string]any{
			"sys_id":    acl.SysID,
			"name":      acl.Name,
			"type":      acl.Type,
			"field":     acl.Field,
			"advanced":  acl.Advanced,
			"condition": acl.Condition,
		}
		if instanceURL != "" {
			row["link"] = fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
		}
		aclList = append(aclList, row)
	}

	data := map[string]any{
		"table":     table,
		"operation": operation,
		"count":     len(matchingACLs),
		"acls":      aclList,
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d ACLs for %s.%s", len(matchingACLs), table, operation)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn acls <name>",
				Description: "Show ACL details",
			},
		),
	)
}

// printStyledACLCheck outputs styled ACL check results.
func printStyledACLCheck(cmd *cobra.Command, table, operation string, acls []sdk.ACL, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00"))
	warningStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ffaa00"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("ACL Coverage Check"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Table:"), valueStyle.Render(table))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Operation:"), valueStyle.Render(operation))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Matching ACLs:"), valueStyle.Render(fmt.Sprintf("%d", len(acls))))

	fmt.Fprintln(cmd.OutOrStdout())

	if len(acls) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), warningStyle.Render("  ⚠ No ACLs found for this table/operation combination"))
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  This could mean:"))
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  • The table inherits ACLs from a parent table"))
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  • No explicit ACL is defined (default deny)"))
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  • ACLs are inactive"))
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), successStyle.Render("  ✓ ACLs found:"))
		fmt.Fprintln(cmd.OutOrStdout())

		// Column headers
		fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-10s\n",
			headerStyle.Render("Name"),
			headerStyle.Render("Type"),
			headerStyle.Render("Field"),
			headerStyle.Render("Advanced"),
		)
		fmt.Fprintln(cmd.OutOrStdout())

		// ACLs
		for _, acl := range acls {
			name := acl.Name
			if len(name) > 38 {
				name = name[:35] + "..."
			}

			field := acl.Field
			if field == "" {
				field = "-"
			}

			advanced := "No"
			if acl.Advanced {
				advanced = "Yes"
			}

			if instanceURL != "" {
				link := fmt.Sprintf("%s/sys_security_acl.do?sys_id=%s", instanceURL, acl.SysID)
				nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
				fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-10s\n",
					nameWithLink,
					mutedStyle.Render(acl.Type),
					mutedStyle.Render(field),
					mutedStyle.Render(advanced),
				)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-10s\n",
					name,
					mutedStyle.Render(acl.Type),
					mutedStyle.Render(field),
					mutedStyle.Render(advanced),
				)
			}
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn acls --table "+table,
		mutedStyle.Render("List all ACLs for table"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn tables show %s", table),
		mutedStyle.Render("Show table details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownACLCheck outputs markdown ACL check results.
func printMarkdownACLCheck(cmd *cobra.Command, table, operation string, acls []sdk.ACL) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**ACL Coverage Check: %s.%s**\n\n", table, operation)
	fmt.Fprintf(cmd.OutOrStdout(), "**Matching ACLs:** %d\n\n", len(acls))

	if len(acls) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "⚠️ No ACLs found for this table/operation combination")
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "This could mean:")
		fmt.Fprintln(cmd.OutOrStdout(), "- The table inherits ACLs from a parent table")
		fmt.Fprintln(cmd.OutOrStdout(), "- No explicit ACL is defined (default deny)")
		fmt.Fprintln(cmd.OutOrStdout(), "- ACLs are inactive")
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "| Name | Type | Field | Advanced |")
		fmt.Fprintln(cmd.OutOrStdout(), "|------|------|-------|----------|")

		for _, acl := range acls {
			field := acl.Field
			if field == "" {
				field = "-"
			}
			advanced := "No"
			if acl.Advanced {
				advanced = "Yes"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n", acl.Name, acl.Type, field, advanced)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// pickACL shows an interactive ACL picker and returns the selected ACL sys_id.
func pickACL(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListACLOptions{
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		acls, err := sdkClient.ListACLs(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, a := range acls {
			status := "Active"
			if !a.Active {
				status = "Inactive"
			}
			items = append(items, tui.PickerItem{
				ID:          a.SysID,
				Title:       a.Name,
				Description: fmt.Sprintf("%s - %s", a.Operation, status),
			})
		}

		hasMore := len(acls) >= limit
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

// pickACLFromList shows a picker from an already-fetched list of ACLs.
func pickACLFromList(acls []sdk.ACL) (string, error) {
	var items []tui.PickerItem
	for _, a := range acls {
		status := "Active"
		if !a.Active {
			status = "Inactive"
		}
		items = append(items, tui.PickerItem{
			ID:          a.SysID,
			Title:       a.Name,
			Description: fmt.Sprintf("%s - %s", a.Operation, status),
		})
	}

	selected, err := tui.Pick("Select an ACL to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
