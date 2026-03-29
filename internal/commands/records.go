package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// recordsListFlags holds the flags for the records list command.
type recordsListFlags struct {
	limit  int
	query  string
	fields string
	order  string
	desc   bool
	all    bool
}

// NewRecordsCmd creates the records command group.
func NewRecordsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "records",
		Short: "Manage table records",
		Long:  "List, show, create, update, and delete records from any ServiceNow table via the Table API.",
	}

	cmd.AddCommand(
		newRecordsListCmd(),
		newRecordsShowCmd(),
		newRecordsCreateCmd(),
		newRecordsUpdateCmd(),
		newRecordsDeleteCmd(),
		newRecordsQueryCmd(),
		newRecordsCountCmd(),
		newRecordsVariablesCmd(),
	)

	return cmd
}

// newRecordsListCmd creates the records list command.
func newRecordsListCmd() *cobra.Command {
	var flags recordsListFlags

	cmd := &cobra.Command{
		Use:   "list [<table>]",
		Short: "List records from a table",
		Long: `List records from any ServiceNow table with optional filtering.

Interactive Mode:
  When running in a terminal without a table argument, automatically uses an interactive
  picker to select a table.

Filtering:
  --query <encoded_query>  Use ServiceNow encoded query syntax
  --fields <field1,field2> Comma-separated list of fields to display
  --order <field>          Order by field (default: sys_updated_on)
  --desc                   Sort in descending order

Default Output:
  Shows sys_id, number (or u_number), and the table's display column.

Examples:
  jsn records list incident
  jsn records list incident --query "priority=1^state!=6" --limit 50
  jsn records list --fields "sys_id,number,short_description" incident`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table string
			if len(args) > 0 {
				table = args[0]
			}
			return runRecordsList(cmd, table, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of records to fetch")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.fields, "fields", "", "Comma-separated fields to display (default: sys_id,number,display_field)")
	// Default order: "sys_updated_on" for most recently changed - shows active records first
	cmd.Flags().StringVar(&flags.order, "order", "sys_updated_on", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all records (no limit)")

	return cmd
}

// runRecordsList executes the records list command.
func runRecordsList(cmd *cobra.Command, table string, flags recordsListFlags) error {
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

	// Interactive table selection if no table provided
	if table == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal || appCtx.NoInteractive() {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table to list records from:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

	// Get the display column for this table
	displayColumn, err := sdkClient.GetTableDisplayColumn(cmd.Context(), table)
	if err != nil {
		displayColumn = "name" // fallback
	}

	// Build fields list
	var fields []string
	if flags.fields != "" {
		fields = strings.Split(flags.fields, ",")
		// Trim spaces
		for i, f := range fields {
			fields[i] = strings.TrimSpace(f)
		}
	} else {
		// Default fields: sys_id, number, and display column
		fields = []string{"sys_id", "number", displayColumn}
	}

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	// Build options
	opts := &sdk.ListRecordsOptions{
		Limit:     limit,
		Query:     flags.query,
		Fields:    fields,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	records, err := sdkClient.ListRecords(cmd.Context(), table, opts)
	if err != nil {
		return fmt.Errorf("failed to list records: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledRecordsList(cmd, table, records, fields, displayColumn, instanceURL, flags.query)
	}

	if format == output.FormatMarkdown {
		return printMarkdownRecordsList(cmd, table, records, fields, instanceURL, flags.query)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, record := range records {
		row := make(map[string]any)
		for _, field := range fields {
			row[field] = getFieldValue(record, field)
		}
		// Add link for styled output
		if instanceURL != "" {
			sysID := getFieldValue(record, "sys_id")
			if sysIDStr, ok := sysID.(string); ok && sysIDStr != "" {
				row["link"] = fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysIDStr)
			}
		}
		data = append(data, row)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "show",
			Cmd:         fmt.Sprintf("jsn records show %s <sys_id>", table),
			Description: "Show record details",
		},
		{
			Action:      "create",
			Cmd:         fmt.Sprintf("jsn records create %s", table),
			Description: "Create new record",
		},
	}

	// Add filter link breadcrumb if query was used, has valid operators, and instance URL is available
	if flags.query != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, flags.query)
		if filterLink != "" {
			breadcrumbs = append(breadcrumbs, output.Breadcrumb{
				Action:      "filter",
				Cmd:         filterLink,
				Description: "View filter in ServiceNow",
			})
		}
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d records from %s", len(records), table)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledRecordsList outputs styled records list.
func printStyledRecordsList(cmd *cobra.Command, table string, records []map[string]interface{}, fields []string, displayColumn, instanceURL, query string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	brandStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())

	// Title - make it a link to the filter when query is present and has valid operators
	title := fmt.Sprintf("Records from %s", table)
	if query != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, query)
		if filterLink != "" {
			// Render title as hyperlink
			titleWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", filterLink, title)
			fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(titleWithLink))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
		}
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers - sys_id is exactly 32 chars, number ~20, display variable
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s\n",
		mutedStyle.Render("Sys ID"),
		headerStyle.Render("Number"),
		headerStyle.Render(stringsTitle(displayColumn)),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Records
	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		number := getStringField(record, "number")
		display := getStringField(record, displayColumn)

		// Truncate display value if too long
		displayWidth := 50
		if len(display) > displayWidth {
			display = display[:displayWidth-3] + "..."
		}

		// Create hyperlink if instance URL available (wrap sys_id with link)
		if instanceURL != "" {
			link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysID)
			sysIDWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, sysID)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s\n",
				mutedStyle.Render(sysIDWithLink),
				brandStyle.Render(number),
				mutedStyle.Render(display),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s\n",
				mutedStyle.Render(sysID),
				brandStyle.Render(number),
				mutedStyle.Render(display),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn records show %s <sys_id>", table),
		labelStyle.Render("Show record details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn records create %s", table),
		labelStyle.Render("Create new record"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn tables schema %s", table),
		labelStyle.Render("View table schema"),
	)
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Query with --query or jsn records query <table> <encoded_query>"))
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Operators: = != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR"))
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Full docs: jsn docs operators"))

	// Show filter link if query was used, has valid operators, and instance URL is available
	if query != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, query)
		if filterLink != "" {
			fmt.Fprintln(cmd.OutOrStdout())
			fmt.Fprintf(cmd.OutOrStdout(), "  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
				labelStyle.Render("Filter:"),
				filterLink,
				filterLink,
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownRecordsList outputs markdown records list.
func printMarkdownRecordsList(cmd *cobra.Command, table string, records []map[string]interface{}, fields []string, instanceURL, query string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Records from %s**\n\n", table)

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Number | Display |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|--------|---------|")

	// Records
	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		number := getStringField(record, "number")
		display := ""
		// Try to find a display value
		for _, field := range fields {
			if field != "sys_id" && field != "number" {
				display = getStringField(record, field)
				break
			}
		}

		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s |\n", sysID, number, display)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Show filter link if query was used, has valid operators, and instance URL is available
	if query != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, query)
		if filterLink != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "**Filter:** %s\n\n", filterLink)
		}
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records show %s <sys_id>` — Show record details\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records create %s` — Create new record\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables schema %s` — View table schema\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- Query with `--query` or `jsn records query %s <encoded_query>`\n", table)
	fmt.Fprintln(cmd.OutOrStdout(), "- Operators: `= != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR`")
	fmt.Fprintln(cmd.OutOrStdout(), "- Full docs: `jsn docs operators`")
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// newRecordsShowCmd creates the records show command.
// recordsShowFlags holds the flags for the records show command.
type recordsShowFlags struct {
	fields string
}

func newRecordsShowCmd() *cobra.Command {
	var flags recordsShowFlags

	cmd := &cobra.Command{
		Use:     "show [<table>] <sys_id>",
		Aliases: []string{"get"},
		Short:   "Show record details",
		Long: `Display detailed information about a specific record.

If no table is provided, an interactive picker will help you select one.

Examples:
  jsn records show incident <sys_id>
  jsn records show incident <sys_id> --fields number,state,short_description
  jsn records show <sys_id>  # Interactive table selection`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table, sysID string
			if len(args) == 2 {
				table = args[0]
				sysID = args[1]
			} else {
				sysID = args[0]
			}
			return runRecordsShow(cmd, table, sysID, flags)
		},
	}

	cmd.Flags().StringVarP(&flags.fields, "fields", "f", "", "Comma-separated list of fields to display (e.g., 'number,state,short_description')")

	return cmd
}

// runRecordsShow executes the records show command.
func runRecordsShow(cmd *cobra.Command, table, sysID string, flags recordsShowFlags) error {
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

	// Interactive table selection if no table provided
	if table == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

	// Get the record
	record, err := sdkClient.GetRecord(cmd.Context(), table, sysID)
	if err != nil {
		return fmt.Errorf("failed to get record: %w", err)
	}

	// Filter fields if specified
	if flags.fields != "" {
		fieldList := strings.Split(flags.fields, ",")
		filteredRecord := make(map[string]interface{})
		// Always include sys_id
		if v, ok := record["sys_id"]; ok {
			filteredRecord["sys_id"] = v
		}
		for _, field := range fieldList {
			field = strings.TrimSpace(field)
			if v, ok := record[field]; ok {
				filteredRecord[field] = v
			}
		}
		record = filteredRecord
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		err := printStyledRecord(cmd, table, record, instanceURL)
		if err != nil {
			return err
		}
		// If this is a request item, show variables
		if table == "sc_req_item" {
			_ = printSingleRowVariables(cmd, sdkClient, sysID)
			_ = printMRVS(cmd, sdkClient, sysID, instanceURL)
		}
		return nil
	}

	if format == output.FormatMarkdown {
		return printMarkdownRecord(cmd, table, record, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         fmt.Sprintf("jsn records list %s", table),
			Description: "List all records",
		},
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn records update %s %s", table, sysID),
			Description: "Update this record",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn records delete %s %s", table, sysID),
			Description: "Delete this record",
		},
	}

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Record from %s", table)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledRecord outputs styled record details.
func printStyledRecord(cmd *cobra.Command, table string, record map[string]interface{}, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	number := getStringField(record, "number")
	if number == "" {
		number = getStringField(record, "sys_id")
	}
	title := fmt.Sprintf("%s (%s)", number, table)
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Define field categories and their order
	fieldCategories := map[string][]string{
		"Core": {
			"number", "sys_id", "sys_class_name", "state", "stage", "active",
			"short_description", "description", "priority", "urgency", "impact",
		},
		"People": {
			"opened_by", "requested_for", "assigned_to", "assignment_group",
			"closed_by", "resolved_by", "caller_id", "u_requester",
		},
		"Request Info": {
			"cat_item", "sc_catalog", "request", "order_guide", "quantity",
			"price", "recurring_price", "recurring_frequency", "backordered",
			"billable", "configuration_item", "cmdb_ci", "business_service",
		},
		"Dates & Times": {
			"opened_at", "sys_created_on", "sys_updated_on", "closed_at",
			"resolved_at", "work_start", "work_end", "due_date", "expected_start",
			"estimated_delivery", "sla_due", "activity_due", "approval_set",
		},
		"Status & Approvals": {
			"approval", "approval_history", "approval_set", "upon_approval",
			"upon_reject", "escalation", "made_sla",
		},
		"System": {
			"sys_domain", "sys_domain_path", "sys_created_by", "sys_updated_by",
			"sys_mod_count", "sys_tags",
		},
	}

	// Track which fields have been printed
	printed := make(map[string]bool)

	// Print fields by category
	for category, fields := range fieldCategories {
		categoryPrinted := false
		for _, field := range fields {
			if value, exists := record[field]; exists && !printed[field] {
				if !categoryPrinted {
					fmt.Fprintln(cmd.OutOrStdout())
					fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ "+category+" ─"))
					categoryPrinted = true
				}
				valStr := formatValue(value)
				fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
					labelStyle.Render(field+":"),
					valueStyle.Render(valStr),
				)
				printed[field] = true
			}
		}
	}

	// Print remaining uncategorized fields (sorted alphabetically)
	var remaining []string
	for key := range record {
		if !printed[key] {
			remaining = append(remaining, key)
		}
	}
	if len(remaining) > 0 {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Other ─"))
		// Sort alphabetically
		for i := 0; i < len(remaining)-1; i++ {
			for j := i + 1; j < len(remaining); j++ {
				if remaining[i] > remaining[j] {
					remaining[i], remaining[j] = remaining[j], remaining[i]
				}
			}
		}
		for _, key := range remaining {
			valStr := formatValue(record[key])
			fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
				labelStyle.Render(key+":"),
				valueStyle.Render(valStr),
			)
		}
	}

	// Link
	if instanceURL != "" {
		sysID := getStringField(record, "sys_id")
		link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Link:"),
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
		fmt.Sprintf("jsn records list %s", table),
		labelStyle.Render("List all records"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn records update %s %s", table, getStringField(record, "sys_id")),
		labelStyle.Render("Update this record"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn records delete %s %s", table, getStringField(record, "sys_id")),
		labelStyle.Render("Delete this record"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownRecord outputs markdown record details.
func printMarkdownRecord(cmd *cobra.Command, table string, record map[string]interface{}, instanceURL string) error {
	number := getStringField(record, "number")
	if number == "" {
		number = getStringField(record, "sys_id")
	}
	fmt.Fprintf(cmd.OutOrStdout(), "**%s (%s)**\n\n", number, table)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Fields")
	fmt.Fprintln(cmd.OutOrStdout())

	for key, value := range record {
		valStr := formatValue(value)
		fmt.Fprintf(cmd.OutOrStdout(), "- **%s:** %s\n", key, valStr)
	}

	if instanceURL != "" {
		sysID := getStringField(record, "sys_id")
		link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records list %s` — List all records\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records update %s %s` — Update this record\n", table, getStringField(record, "sys_id"))
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records delete %s %s` — Delete this record\n", table, getStringField(record, "sys_id"))
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records list %s --query \"active=true\"` — Query with filter\n", table)
	fmt.Fprintln(cmd.OutOrStdout(), "- Query operators: `= != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR`")
	fmt.Fprintln(cmd.OutOrStdout(), "- Full docs: `jsn docs operators`")

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newRecordsCreateCmd creates the records create command.
func newRecordsCreateCmd() *cobra.Command {
	var fields []string
	var jsonData string

	cmd := &cobra.Command{
		Use:   "create [<table>]",
		Short: "Create a new record",
		Long: `Create a new record in the specified table.

Field Input:
  Use --field (or -f) to set field values: --field short_description="Server down"
  Use --data (or -d) to provide a JSON object: --data '{"short_description":"Server down"}'
  Use @file to read a value from a file: -f script=@/tmp/script.js

Interactive Mode:
  If no table is provided, an interactive picker will help you select one.

Examples:
  jsn records create incident --field short_description="Server down" --field priority=1
  jsn records create incident -f short_description="Server down" -f priority=1
  jsn records create incident -f script=@/tmp/my_script.js
  jsn records create incident --data '{"short_description":"Server down","priority":"1"}'
  jsn records create incident -d '{"short_description":"Server down","priority":"1"}'`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table string
			if len(args) > 0 {
				table = args[0]
			}
			return runRecordsCreate(cmd, table, fields, jsonData)
		},
	}

	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Set field value (name=value, use @file to read from file)")
	cmd.Flags().StringVarP(&jsonData, "data", "d", "", "JSON object with field values")

	return cmd
}

// resolveFieldValue resolves a field value, reading from a file if it starts with @.
func resolveFieldValue(value string) (string, error) {
	if strings.HasPrefix(value, "@") {
		filePath := value[1:]
		content, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("reading %s: %w", filePath, err)
		}
		return string(content), nil
	}
	return value, nil
}

// runRecordsCreate executes the records create command.
func runRecordsCreate(cmd *cobra.Command, table string, fields []string, jsonData string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no table provided
	if table == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table to create record in:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

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

	// Create the record
	record, err := sdkClient.CreateRecord(cmd.Context(), table, data)
	if err != nil {
		return fmt.Errorf("failed to create record: %w", err)
	}

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Created record in %s", table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn records show %s %s", table, getStringField(record, "sys_id")),
				Description: "View record",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn records list %s", table),
				Description: "List all records",
			},
		),
	)
}

// newRecordsUpdateCmd creates the records update command.
func newRecordsUpdateCmd() *cobra.Command {
	var fields []string
	var jsonData string

	cmd := &cobra.Command{
		Use:   "update [<table>] <sys_id>",
		Short: "Update an existing record",
		Long: `Update an existing record by sys_id.

Field Input:
  Use --field (or -f) to set field values: --field short_description="Updated description"
  Use --data (or -d) to provide a JSON object: --data '{"short_description":"Updated"}'
  Use @file to read a value from a file: -f script=@/tmp/script.js

Interactive Mode:
  If no table is provided, an interactive picker will help you select one.

Examples:
  jsn records update incident <sys_id> --field priority=2
  jsn records update incident <sys_id> -f state=6 -f close_code="Resolved"
  jsn records update incident <sys_id> --data '{"state":"6","close_code":"Resolved"}'
  jsn records update sys_script <sys_id> -f script=@/tmp/fix.js`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table, sysID string
			if len(args) == 2 {
				table = args[0]
				sysID = args[1]
			} else {
				sysID = args[0]
			}
			return runRecordsUpdate(cmd, table, sysID, fields, jsonData)
		},
	}

	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Set field value (name=value, use @file to read from file)")
	cmd.Flags().StringVarP(&jsonData, "data", "d", "", "JSON object with field values")

	return cmd
}

// runRecordsUpdate executes the records update command.
func runRecordsUpdate(cmd *cobra.Command, table, sysID string, fields []string, jsonData string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no table provided
	if table == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

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
		return output.ErrUsage("No updates specified. Use --field or --data")
	}

	// Update the record
	record, err := sdkClient.UpdateRecord(cmd.Context(), table, sysID, data)
	if err != nil {
		return fmt.Errorf("failed to update record: %w", err)
	}

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Updated record in %s", table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn records show %s %s", table, sysID),
				Description: "View updated record",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn records list %s", table),
				Description: "List all records",
			},
		),
	)
}

// newRecordsDeleteCmd creates the records delete command.
func newRecordsDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete [<table>] <sys_id>",
		Short: "Delete a record",
		Long: `Delete a record by sys_id.

Interactive Mode:
  If no table is provided, an interactive picker will help you select one.

Examples:
  jsn records delete incident <sys_id>
  jsn records delete incident <sys_id> --force  # Skip confirmation`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table, sysID string
			if len(args) == 2 {
				table = args[0]
				sysID = args[1]
			} else {
				sysID = args[0]
			}
			return runRecordsDelete(cmd, table, sysID, force)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

// runRecordsDelete executes the records delete command.
func runRecordsDelete(cmd *cobra.Command, table, sysID string, force bool) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive table selection if no table provided
	if table == "" {
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

	// Get record details for confirmation
	record, err := sdkClient.GetRecord(cmd.Context(), table, sysID)
	if err != nil {
		return fmt.Errorf("failed to find record: %w", err)
	}

	// Confirm deletion unless --force
	if !force && isTerminal {
		number := getStringField(record, "number")
		if number == "" {
			number = sysID
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Delete record %s from %s? [y/N]: ", number, table)
		var response string
		_, _ = fmt.Scanln(&response) // Ignore error - user can just press enter
		if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
			return fmt.Errorf("deletion cancelled")
		}
	}

	// Delete the record
	if err := sdkClient.DeleteRecord(cmd.Context(), table, sysID); err != nil {
		return fmt.Errorf("failed to delete record: %w", err)
	}

	return outputWriter.OK(map[string]string{
		"sys_id": sysID,
		"table":  table,
		"status": "deleted",
	},
		output.WithSummary(fmt.Sprintf("Deleted record from %s", table)),
	)
}

// newRecordsQueryCmd creates the records query command.
func newRecordsQueryCmd() *cobra.Command {
	var flags recordsListFlags

	cmd := &cobra.Command{
		Use:   "query <table> <encoded_query>",
		Short: "Query records with raw encoded query",
		Long: `Query records using ServiceNow's encoded query syntax.

This is a convenience command equivalent to:
  jsn records list <table> --query "<encoded_query>"

Examples:
  jsn records query incident "priority=1^state!=6"
  jsn records query incident "active=true^assigned_toISEMPTY" --limit 100`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			flags.query = args[1]
			return runRecordsList(cmd, args[0], flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of records to fetch")
	cmd.Flags().StringVar(&flags.fields, "fields", "", "Comma-separated fields to display")
	// Default order: "sys_updated_on" for most recently changed - shows active records first
	cmd.Flags().StringVar(&flags.order, "order", "sys_updated_on", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all records (no limit)")

	return cmd
}

// newRecordsCountCmd creates the records count command.
func newRecordsCountCmd() *cobra.Command {
	var query string

	cmd := &cobra.Command{
		Use:   "count [<table>]",
		Short: "Count records in a table",
		Long: `Count the number of records in a ServiceNow table.

Interactive Mode:
  When running in a terminal without a table argument, automatically uses an interactive
  picker to select a table.

Examples:
  jsn records count incident
  jsn records count incident --query "active=true"
  jsn records count --query "priority=1" incident`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var table string
			if len(args) > 0 {
				table = args[0]
			}
			return runRecordsCount(cmd, table, query)
		},
	}

	cmd.Flags().StringVar(&query, "query", "", "ServiceNow encoded query filter")

	return cmd
}

// runRecordsCount executes the records count command.
func runRecordsCount(cmd *cobra.Command, table, query string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Interactive table selection if no table provided
	if table == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Table name is required in non-interactive mode")
		}

		selectedTable, err := pickTable(cmd.Context(), sdkClient, "Select a table to count records from:")
		if err != nil {
			return err
		}
		table = selectedTable
	}

	// Count the records
	opts := &sdk.CountRecordsOptions{
		Query: query,
	}

	count, err := sdkClient.CountRecords(cmd.Context(), table, opts)
	if err != nil {
		return fmt.Errorf("failed to count records: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCount(cmd, table, count, query)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCount(cmd, table, count, query)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         fmt.Sprintf("jsn records list %s", table),
			Description: "List records",
		},
		{
			Action:      "query",
			Cmd:         fmt.Sprintf("jsn records query %s \"%s\"", table, query),
			Description: "Query with filter",
		},
	}

	return outputWriter.OK(map[string]interface{}{
		"table": table,
		"count": count,
		"query": query,
	},
		output.WithSummary(fmt.Sprintf("%d records in %s", count, table)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledCount outputs styled count result.
func printStyledCount(cmd *cobra.Command, table string, count int, query string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Record Count: %s", table)))
	fmt.Fprintln(cmd.OutOrStdout())

	// Count display
	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n",
		labelStyle.Render("Count:"),
		headerStyle.Render(fmt.Sprintf("%d", count)),
	)

	// Show query if provided
	if query != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n",
			labelStyle.Render("Query:"),
			query,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn records list %s", table),
		labelStyle.Render("List all records"),
	)
	if query != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
			fmt.Sprintf("jsn records query %s \"%s\"", table, query),
			labelStyle.Render("Query with filter"),
		)
	}
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Query operators: = != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR"))
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Full docs: jsn docs operators"))

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownCount outputs markdown count result.
func printMarkdownCount(cmd *cobra.Command, table string, count int, query string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Record Count: %s**\n\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Count:** %d\n", count)
	if query != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Query:** `%s`\n", query)
	}
	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// Helper functions

// pickTable shows an interactive table picker and returns the selected table name.
func pickTable(ctx context.Context, sdkClient *sdk.Client, title string) (string, error) {
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

	selected, err := tui.PickWithPagination(title, fetcher, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", fmt.Errorf("selection cancelled")
	}

	return selected.ID, nil
}

// getFieldValue safely extracts a value from a record map.
func getFieldValue(record map[string]interface{}, field string) interface{} {
	if v, ok := record[field]; ok && v != nil {
		return v
	}
	return ""
}

// getStringField safely extracts a string value from a record map.
func getStringField(record map[string]interface{}, field string) string {
	v := getFieldValue(record, field)
	if v == nil {
		return ""
	}

	switch val := v.(type) {
	case string:
		return val
	case map[string]interface{}:
		// Handle reference field display value
		if display, ok := val["display_value"].(string); ok {
			return display
		}
		if value, ok := val["value"].(string); ok {
			return value
		}
		return fmt.Sprintf("%v", val)
	default:
		return fmt.Sprintf("%v", val)
	}
}

// formatValue formats a value for display.
func formatValue(v interface{}) string {
	if v == nil {
		return ""
	}

	switch val := v.(type) {
	case string:
		return val
	case map[string]interface{}:
		// Handle reference field display value
		if display, ok := val["display_value"].(string); ok {
			return display
		}
		if value, ok := val["value"].(string); ok {
			return value
		}
		return fmt.Sprintf("%v", val)
	case []interface{}:
		// Handle array values
		var parts []string
		for _, item := range val {
			parts = append(parts, formatValue(item))
		}
		return strings.Join(parts, ", ")
	default:
		return fmt.Sprintf("%v", val)
	}
}

// strings.Title replacement for Go 1.18+
func stringsTitle(s string) string {
	if s == "" {
		return ""
	}
	// Simple title case - capitalize first letter
	return strings.ToUpper(s[:1]) + s[1:]
}

// printMRVS displays multi-row variable set answers for a request item
func printMRVS(cmd *cobra.Command, sdkClient *sdk.Client, ritmSysID string, instanceURL string) error {
	// Query MRVS data
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_query", fmt.Sprintf("parent_id=%s", ritmSysID))
	query.Set("sysparm_fields", "row_index,item_option_new,value")
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(cmd.Context(), "sc_multi_row_question_answer", query)
	if err != nil {
		return err // Silently fail - MRVS is optional
	}

	if len(resp.Result) == 0 {
		return nil // No MRVS data
	}

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	// Group by row_index
	rows := make(map[string]map[string]string)
	var rowOrder []string
	var allColumns []string
	columnSet := make(map[string]bool)

	for _, record := range resp.Result {
		rowID := getStringField(record, "row_index")
		if rowID == "" {
			continue
		}

		// Track row order
		if _, exists := rows[rowID]; !exists {
			rowOrder = append(rowOrder, rowID)
			rows[rowID] = make(map[string]string)
		}

		// Get column name (handle display_value objects)
		colName := ""
		if v, ok := record["item_option_new"]; ok && v != nil {
			switch val := v.(type) {
			case string:
				colName = val
			case map[string]interface{}:
				if dv, ok := val["display_value"].(string); ok {
					colName = dv
				}
			}
		}

		value := getStringField(record, "value")

		if colName != "" {
			rows[rowID][colName] = value
			if !columnSet[colName] {
				columnSet[colName] = true
				allColumns = append(allColumns, colName)
			}
		}
	}

	if len(rows) == 0 {
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Multi-Row Variable Set Answers"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Calculate column widths
	colWidths := make(map[string]int)
	for _, col := range allColumns {
		colWidths[col] = len(col)
	}
	for _, row := range rows {
		for col, val := range row {
			if len(val) > colWidths[col] {
				colWidths[col] = len(val)
			}
		}
	}
	// Ensure minimum width and maximum width
	for col := range colWidths {
		if colWidths[col] < 12 {
			colWidths[col] = 12
		}
		if colWidths[col] > 40 {
			colWidths[col] = 40
		}
	}

	// Print header
	fmt.Print("│ Row │")
	for _, col := range allColumns {
		fmt.Printf(" %-*s │", colWidths[col], col)
	}
	fmt.Println()

	// Print separator
	fmt.Print("│-----│")
	for _, col := range allColumns {
		fmt.Printf(" %s │", strings.Repeat("-", colWidths[col]))
	}
	fmt.Println()

	// Print rows
	for i, rowID := range rowOrder {
		row := rows[rowID]
		fmt.Printf("│ %3d │", i+1)
		for _, col := range allColumns {
			val := row[col]
			if len(val) > colWidths[col] {
				val = val[:colWidths[col]-3] + "..."
			}
			fmt.Printf(" %-*s │", colWidths[col], val)
		}
		fmt.Println()
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", mutedStyle.Render(fmt.Sprintf("%d rows", len(rows))))

	return nil
}

// printSingleRowVariables displays single-row catalog variables for a request item
func printSingleRowVariables(cmd *cobra.Command, sdkClient *sdk.Client, ritmSysID string) error {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_query", fmt.Sprintf("request_item=%s", ritmSysID))
	query.Set("sysparm_fields", "item_option_new,value")
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(cmd.Context(), "sc_item_option", query)
	if err != nil {
		return err
	}

	if len(resp.Result) == 0 {
		return nil
	}

	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	// Filter to only show variables with values
	var variables []struct {
		question string
		value    string
	}

	for _, record := range resp.Result {
		question := ""
		if v, ok := record["item_option_new"]; ok && v != nil {
			switch val := v.(type) {
			case string:
				question = val
			case map[string]interface{}:
				if dv, ok := val["display_value"].(string); ok {
					question = dv
				}
			}
		}

		value := getStringField(record, "value")

		if question != "" && value != "" {
			variables = append(variables, struct {
				question string
				value    string
			}{question, value})
		}
	}

	if len(variables) == 0 {
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Catalog Variables ─"))
	for _, v := range variables {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
			labelStyle.Render(v.question+":"),
			valueStyle.Render(v.value),
		)
	}

	return nil
}

// newRecordsVariablesCmd creates the records variables command.
func newRecordsVariablesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "variables <ritm_sys_id>",
		Short: "Show all variables (single-row and MRVS) for a request item",
		Long: `Display all catalog variables for a request item including:
- Single-row variables (from sc_item_option)
- Multi-row variable sets (from sc_multi_row_question_answer)

Examples:
  jsn records variables 18c086abc32f36103c71770d0501312e`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecordsVariables(cmd, args[0])
		},
	}
}

// runRecordsVariables executes the records variables command.
func runRecordsVariables(cmd *cobra.Command, ritmSysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Request Item Variables"))
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "RITM: %s\n\n", ritmSysID)

	// 1. Query single-row variables (sc_item_option)
	query1 := url.Values{}
	query1.Set("sysparm_limit", "100")
	query1.Set("sysparm_query", fmt.Sprintf("request_item=%s", ritmSysID))
	query1.Set("sysparm_fields", "item_option_new,value")
	query1.Set("sysparm_display_value", "true")

	resp1, err := sdkClient.Get(cmd.Context(), "sc_item_option", query1)
	if err == nil && len(resp1.Result) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Single-Row Variables ─"))
		for _, record := range resp1.Result {
			question := ""
			if v, ok := record["item_option_new"]; ok && v != nil {
				switch val := v.(type) {
				case string:
					question = val
				case map[string]interface{}:
					if dv, ok := val["display_value"].(string); ok {
						question = dv
					}
				}
			}
			value := getStringField(record, "value")
			if question != "" && value != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
					labelStyle.Render(question+":"),
					valueStyle.Render(value),
				)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// 2. Query MRVS data (sc_multi_row_question_answer)
	query2 := url.Values{}
	query2.Set("sysparm_limit", "100")
	query2.Set("sysparm_query", fmt.Sprintf("parent_id=%s", ritmSysID))
	query2.Set("sysparm_fields", "row_index,item_option_new,value")
	query2.Set("sysparm_display_value", "true")

	resp2, err := sdkClient.Get(cmd.Context(), "sc_multi_row_question_answer", query2)
	if err == nil && len(resp2.Result) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Multi-Row Variable Sets ─"))

		// Group by row_index
		rows := make(map[string]map[string]string)
		var rowOrder []string
		columnSet := make(map[string]bool)
		var allColumns []string

		for _, record := range resp2.Result {
			rowID := getStringField(record, "row_index")
			if rowID == "" {
				continue
			}

			if _, exists := rows[rowID]; !exists {
				rowOrder = append(rowOrder, rowID)
				rows[rowID] = make(map[string]string)
			}

			colName := ""
			if v, ok := record["item_option_new"]; ok && v != nil {
				switch val := v.(type) {
				case string:
					colName = val
				case map[string]interface{}:
					if dv, ok := val["display_value"].(string); ok {
						colName = dv
					}
				}
			}

			value := getStringField(record, "value")

			if colName != "" {
				rows[rowID][colName] = value
				if !columnSet[colName] {
					columnSet[colName] = true
					allColumns = append(allColumns, colName)
				}
			}
		}

		// Display as table
		if len(rows) > 0 {
			// Calculate column widths
			colWidths := make(map[string]int)
			for _, col := range allColumns {
				colWidths[col] = len(col)
			}
			for _, row := range rows {
				for col, val := range row {
					if len(val) > colWidths[col] {
						colWidths[col] = len(val)
					}
				}
			}
			for col := range colWidths {
				if colWidths[col] < 12 {
					colWidths[col] = 12
				}
				if colWidths[col] > 40 {
					colWidths[col] = 40
				}
			}

			// Print header
			fmt.Print("│ Row │")
			for _, col := range allColumns {
				fmt.Printf(" %-*s │", colWidths[col], col)
			}
			fmt.Println()

			// Print separator
			fmt.Print("│-----│")
			for _, col := range allColumns {
				fmt.Printf(" %s │", strings.Repeat("-", colWidths[col]))
			}
			fmt.Println()

			// Print rows
			for i, rowID := range rowOrder {
				row := rows[rowID]
				fmt.Printf("│ %3d │", i+1)
				for _, col := range allColumns {
					val := row[col]
					if len(val) > colWidths[col] {
						val = val[:colWidths[col]-3] + "..."
					}
					fmt.Printf(" %-*s │", colWidths[col], val)
				}
				fmt.Println()
			}
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	if len(resp1.Result) == 0 && len(resp2.Result) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No variables found for this request item.")
	}

	return nil
}
