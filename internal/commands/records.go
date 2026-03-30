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

// recordsFlags holds the flags for the records root command.
type recordsFlags struct {
	table  string
	limit  int
	search string
	query  string
	fields string
	order  string
	desc   bool
	all    bool
	count  bool
}

// NewRecordsCmd creates the records command group.
func NewRecordsCmd() *cobra.Command {
	var flags recordsFlags

	cmd := &cobra.Command{
		Use:   "records [<sys_id>]",
		Short: "Manage table records",
		Long: `Query, inspect, and manage records from any ServiceNow table via the Table API.

The --table flag is required and inherited by all subcommands (create, update, delete).
Use specific commands (rules, flows, etc.) when they exist for a table — they provide
curated views. Use records for everything else.

Usage:
  jsn records --table <table>                       List records (with count)
  jsn records --table <table> <sys_id>              Show record details (with enrichment)
  jsn records --table <table> --search <term>       Fuzzy search on display column
  jsn records --table <table> --query <encoded>     Raw ServiceNow encoded query
  jsn records --table <table> --count               Count records only

Write Operations:
  jsn records --table <table> create -f key=value   Create a new record
  jsn records --table <table> update <sys_id> -f k=v  Update an existing record
  jsn records --table <table> delete <sys_id>       Delete a record

Filtering:
  --search <term>    Fuzzy search on the table's display column (LIKE match)
  --query <query>    Raw ServiceNow encoded query for advanced filtering
  --count            Return only the record count (composable with --search/--query)
  --fields <list>    Comma-separated fields to display

Enrichment (on show):
  All records:    Fetches record producer variable answers (question_answer table)
  sc_req_item:    Fetches catalog variables (sc_item_option_mtom → item_option_new
                  → sc_item_option) and multi-row variable sets (sc_multi_row_question_answer)
  Task classes:   If sys_class_name differs from --table, re-fetches from the actual
                  table to get class-specific fields (e.g., task → change_request)

Examples:
  jsn records --table incident
  jsn records --table incident --search "server down"
  jsn records --table incident --query "priority=1^active=true" --limit 50
  jsn records --table incident --count --query "active=true"
  jsn records --table incident 78271e1347c12200e0ef563dbb9a7109
  jsn records --table sc_req_item RITM0010042
  jsn records --table incident create -f short_description="Server down"`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Mode 1: Direct lookup by sys_id
			if len(args) > 0 {
				return runRecordsShow(cmd, args[0])
			}

			// Mode 2: Count-only mode
			if flags.count {
				return runRecordsCount(cmd, flags)
			}

			// Mode 3: List / search / picker
			return runRecordsList(cmd, flags)
		},
	}

	cmd.PersistentFlags().StringVar(&flags.table, "table", "", "ServiceNow table name (required)")
	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of records to fetch")
	cmd.Flags().StringVar(&flags.search, "search", "", "Fuzzy search on the table's display column")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.fields, "fields", "", "Comma-separated fields to display (default: sys_id,number,display_column)")
	cmd.Flags().StringVar(&flags.order, "order", "sys_updated_on", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", true, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all records (no limit)")
	cmd.Flags().BoolVar(&flags.count, "count", false, "Return only the record count")

	cmd.AddCommand(
		newRecordsCreateCmd(),
		newRecordsUpdateCmd(),
		newRecordsDeleteCmd(),
	)

	return cmd
}

// getTableFromFlags resolves the table name from the persistent --table flag,
// falling back to interactive picker if TTY and no table provided.
func getTableFromFlags(cmd *cobra.Command, sdkClient *sdk.Client, prompt string) (string, error) {
	table, _ := cmd.Flags().GetString("table")
	if table != "" {
		return table, nil
	}

	isTerminal := output.IsTTY(cmd.OutOrStdout())
	appCtx := appctx.FromContext(cmd.Context())
	if !isTerminal || (appCtx != nil && appCtx.NoInteractive()) {
		return "", output.ErrUsage("--table is required. Example: jsn records --table incident")
	}

	return pickTable(cmd.Context(), sdkClient, prompt)
}

// runRecordsList executes the records list command.
func runRecordsList(cmd *cobra.Command, flags recordsFlags) error {
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

	table, err := getTableFromFlags(cmd, sdkClient, "Select a table to list records from:")
	if err != nil {
		return err
	}

	// Get the display column for this table
	displayColumn, err := sdkClient.GetTableDisplayColumn(cmd.Context(), table)
	if err != nil {
		displayColumn = "name" // fallback
	}

	// Build query parts
	var queryParts []string
	if flags.search != "" {
		queryParts = append(queryParts, fmt.Sprintf("%sLIKE%s", displayColumn, flags.search))
	}
	if flags.query != "" {
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, table))
	}
	combinedQuery := strings.Join(queryParts, "^")

	// Determine output format early for interactive check
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - paginated picker, fetches on demand
	useInteractive := isTerminal && !appCtx.NoInteractive() && format == output.FormatAuto
	if useInteractive {
		selectedID, err := pickRecordPaginated(cmd, sdkClient, table, displayColumn, combinedQuery, flags.order, flags.desc)
		if err != nil {
			return err
		}
		return runRecordsShow(cmd, selectedID)
	}

	// Build fields list
	var fields []string
	if flags.fields != "" {
		fields = strings.Split(flags.fields, ",")
		for i, f := range fields {
			fields[i] = strings.TrimSpace(f)
		}
	} else {
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
		Query:     combinedQuery,
		Fields:    fields,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	records, err := sdkClient.ListRecords(cmd.Context(), table, opts)
	if err != nil {
		return fmt.Errorf("failed to list records: %w", err)
	}

	// Get total count for display
	countOpts := &sdk.CountRecordsOptions{
		Query: combinedQuery,
	}
	totalCount, countErr := sdkClient.CountRecords(cmd.Context(), table, countOpts)
	if countErr != nil {
		totalCount = 0
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledRecordsList(cmd, table, records, fields, displayColumn, instanceURL, combinedQuery, totalCount)
	}

	if format == output.FormatMarkdown {
		return printMarkdownRecordsList(cmd, table, records, fields, instanceURL, combinedQuery, totalCount)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, record := range records {
		row := make(map[string]any)
		for _, field := range fields {
			row[field] = getFieldValue(record, field)
		}
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
			Cmd:         fmt.Sprintf("jsn records --table %s <sys_id>", table),
			Description: "Show record details",
		},
		{
			Action:      "create",
			Cmd:         fmt.Sprintf("jsn records --table %s create", table),
			Description: "Create new record",
		},
	}

	if combinedQuery != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, combinedQuery)
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
func printStyledRecordsList(cmd *cobra.Command, table string, records []map[string]interface{}, fields []string, displayColumn, instanceURL, query string, totalCount int) error {
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
			titleWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", filterLink, title)
			fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(titleWithLink))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
		}
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
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

		displayWidth := 50
		if len(display) > displayWidth {
			display = display[:displayWidth-3] + "..."
		}

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

	// Show count
	countText := fmt.Sprintf("%d records", len(records))
	if totalCount > len(records) {
		countText = fmt.Sprintf("Showing %d of %d records", len(records), totalCount)
	}
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render(countText))
	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s <sys_id>", table),
		labelStyle.Render("Show record details"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s create", table),
		labelStyle.Render("Create new record"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn tables schema %s", table),
		labelStyle.Render("View table schema"),
	)
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Search: --search <term>  |  Query: --query <encoded_query>  |  Count: --count"))
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Operators: = != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR"))

	// Show filter link if query was used
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
func printMarkdownRecordsList(cmd *cobra.Command, table string, records []map[string]interface{}, fields []string, instanceURL, query string, totalCount int) error {
	fmt.Fprintf(cmd.OutOrStdout(), "**Records from %s**\n\n", table)

	countText := fmt.Sprintf("%d records", len(records))
	if totalCount > len(records) {
		countText = fmt.Sprintf("Showing %d of %d records", len(records), totalCount)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "*%s*\n\n", countText)

	// Header row
	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Number | Display |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|--------|---------|")

	for _, record := range records {
		sysID := getStringField(record, "sys_id")
		number := getStringField(record, "number")
		display := ""
		for _, field := range fields {
			if field != "sys_id" && field != "number" {
				display = getStringField(record, field)
				break
			}
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s |\n", sysID, number, display)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	if query != "" && instanceURL != "" {
		filterLink := buildFilterLink(instanceURL, table, query)
		if filterLink != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "**Filter:** %s\n\n", filterLink)
		}
	}

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s <sys_id>` — Show record details\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s create` — Create new record\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn tables schema %s` — View table schema\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- Search: `--search <term>` | Query: `--query <encoded_query>` | Count: `--count`\n")
	fmt.Fprintln(cmd.OutOrStdout(), "- Operators: `= != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR`")
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// runRecordsShow executes the records show command.
func runRecordsShow(cmd *cobra.Command, sysID string) error {
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

	// Resolve table from --table flag or picker
	table, err := getTableFromFlags(cmd, sdkClient, "Select a table:")
	if err != nil {
		return err
	}

	// If sysID doesn't look like a sys_id, treat it as a record number or name search
	if !looksLikeSysID(sysID) {
		// Try by number first
		record, err := sdkClient.GetRecordByNumber(cmd.Context(), table, sysID)
		if err == nil {
			sysID = getStringField(record, "sys_id")
		}
		// If not found by number, it stays as-is and GetRecord will fail with a clear error
	}

	// Get the record
	record, err := sdkClient.GetRecord(cmd.Context(), table, sysID)
	if err != nil {
		return fmt.Errorf("failed to get record: %w", err)
	}

	sysID = getStringField(record, "sys_id")

	// If sys_class_name differs from the requested table, re-fetch from the
	// actual table so we get class-specific fields and correct enrichment.
	// E.g. querying "task" for CHG0000021 returns sys_class_name=change_request.
	if actualClass := getRawField(record, "sys_class_name"); actualClass != "" && actualClass != table {
		realRecord, err := sdkClient.GetRecord(cmd.Context(), actualClass, sysID)
		if err == nil {
			record = realRecord
			table = actualClass
		}
		// If re-fetch fails, fall through with the original record
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		if err := printStyledRecord(cmd, table, record, instanceURL); err != nil {
			return err
		}
		// Enrichment: question_answer for ALL records
		_ = printQuestionAnswers(cmd, sdkClient, table, sysID)
		// Enrichment: sc_req_item gets catalog variables + MRVS
		if table == "sc_req_item" {
			_ = printCatalogVariables(cmd, sdkClient, sysID)
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
			Cmd:         fmt.Sprintf("jsn records --table %s", table),
			Description: "List all records",
		},
		{
			Action:      "update",
			Cmd:         fmt.Sprintf("jsn records --table %s update %s", table, sysID),
			Description: "Update this record",
		},
		{
			Action:      "delete",
			Cmd:         fmt.Sprintf("jsn records --table %s delete %s", table, sysID),
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
	// Use ordered slice of pairs to preserve category order
	type fieldCategory struct {
		name   string
		fields []string
	}
	categories := []fieldCategory{
		{"Core", []string{
			"number", "sys_id", "sys_class_name", "state", "stage", "active",
			"short_description", "description", "priority", "urgency", "impact",
		}},
		{"People", []string{
			"opened_by", "requested_for", "assigned_to", "assignment_group",
			"closed_by", "resolved_by", "caller_id", "u_requester",
		}},
		{"Request Info", []string{
			"cat_item", "sc_catalog", "request", "order_guide", "quantity",
			"price", "recurring_price", "recurring_frequency", "backordered",
			"billable", "configuration_item", "cmdb_ci", "business_service",
		}},
		{"Dates & Times", []string{
			"opened_at", "sys_created_on", "sys_updated_on", "closed_at",
			"resolved_at", "work_start", "work_end", "due_date", "expected_start",
			"estimated_delivery", "sla_due", "activity_due", "approval_set",
		}},
		{"Status & Approvals", []string{
			"approval", "approval_history", "approval_set", "upon_approval",
			"upon_reject", "escalation", "made_sla",
		}},
		{"System", []string{
			"sys_domain", "sys_domain_path", "sys_created_by", "sys_updated_by",
			"sys_mod_count", "sys_tags",
		}},
	}

	// Track which fields have been printed
	printed := make(map[string]bool)

	// Print fields by category
	for _, cat := range categories {
		categoryPrinted := false
		for _, field := range cat.fields {
			if value, exists := record[field]; exists && !printed[field] {
				if !categoryPrinted {
					fmt.Fprintln(cmd.OutOrStdout())
					fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ "+cat.name+" ─"))
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
	sysID := getStringField(record, "sys_id")
	if instanceURL != "" {
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
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s", table),
		labelStyle.Render("List all records"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s update %s", table, sysID),
		labelStyle.Render("Update this record"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s delete %s", table, sysID),
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
	sysID := getStringField(record, "sys_id")
	fmt.Fprintf(cmd.OutOrStdout(), "**%s (%s)**\n\n", number, table)

	fmt.Fprintln(cmd.OutOrStdout(), "#### Fields")
	fmt.Fprintln(cmd.OutOrStdout())

	for key, value := range record {
		valStr := formatValue(value)
		fmt.Fprintf(cmd.OutOrStdout(), "- **%s:** %s\n", key, valStr)
	}

	if instanceURL != "" {
		link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s` — List all records\n", table)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s update %s` — Update this record\n", table, sysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s delete %s` — Delete this record\n", table, sysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn records --table %s --query \"active=true\"` — Query with filter\n", table)
	fmt.Fprintln(cmd.OutOrStdout(), "- Query operators: `= != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR`")

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// runRecordsCount executes count-only mode.
func runRecordsCount(cmd *cobra.Command, flags recordsFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	table, err := getTableFromFlags(cmd, sdkClient, "Select a table to count records from:")
	if err != nil {
		return err
	}

	// Get the display column for search
	displayColumn := "name"
	if flags.search != "" {
		dc, dcErr := sdkClient.GetTableDisplayColumn(cmd.Context(), table)
		if dcErr == nil {
			displayColumn = dc
		}
	}

	// Build query
	var queryParts []string
	if flags.search != "" {
		queryParts = append(queryParts, fmt.Sprintf("%sLIKE%s", displayColumn, flags.search))
	}
	if flags.query != "" {
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, table))
	}
	combinedQuery := strings.Join(queryParts, "^")

	opts := &sdk.CountRecordsOptions{
		Query: combinedQuery,
	}

	count, err := sdkClient.CountRecords(cmd.Context(), table, opts)
	if err != nil {
		return fmt.Errorf("failed to count records: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledCount(cmd, table, count, combinedQuery)
	}

	if format == output.FormatMarkdown {
		return printMarkdownCount(cmd, table, count, combinedQuery)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "list",
			Cmd:         fmt.Sprintf("jsn records --table %s", table),
			Description: "List records",
		},
	}

	return outputWriter.OK(map[string]interface{}{
		"table": table,
		"count": count,
		"query": combinedQuery,
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
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Record Count: %s", table)))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s\n",
		labelStyle.Render("Count:"),
		headerStyle.Render(fmt.Sprintf("%d", count)),
	)

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
	fmt.Fprintf(cmd.OutOrStdout(), "  %-55s  %s\n",
		fmt.Sprintf("jsn records --table %s", table),
		labelStyle.Render("List all records"),
	)
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Search: --search <term>  |  Query: --query <encoded_query>"))
	fmt.Fprintln(cmd.OutOrStdout(), labelStyle.Render("Operators: = != < > LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY IN ^(AND) ^OR"))

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

// --- Write operation subcommands ---

// newRecordsCreateCmd creates the records create command.
func newRecordsCreateCmd() *cobra.Command {
	var fields []string
	var jsonData string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new record",
		Long: `Create a new record in the table specified by --table.

Field Input:
  Use --field (or -f) to set field values: --field short_description="Server down"
  Use --data (or -d) to provide a JSON object: --data '{"short_description":"Server down"}'
  Use @file to read a value from a file: -f script=@/tmp/script.js

Examples:
  jsn records --table incident create -f short_description="Server down" -f priority=1
  jsn records --table incident create -f script=@/tmp/my_script.js
  jsn records --table incident create -d '{"short_description":"Server down","priority":"1"}'`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecordsCreate(cmd, fields, jsonData)
		},
	}

	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Set field value (name=value, use @file to read from file)")
	cmd.Flags().StringVarP(&jsonData, "data", "d", "", "JSON object with field values")

	return cmd
}

// runRecordsCreate executes the records create command.
func runRecordsCreate(cmd *cobra.Command, fields []string, jsonData string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	table, err := getTableFromFlags(cmd, sdkClient, "Select a table to create record in:")
	if err != nil {
		return err
	}

	// Build data from fields and/or JSON
	data := make(map[string]interface{})

	if jsonData != "" {
		if err := json.Unmarshal([]byte(jsonData), &data); err != nil {
			return output.ErrUsage(fmt.Sprintf("Invalid JSON: %v", err))
		}
	}

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

	record, err := sdkClient.CreateRecord(cmd.Context(), table, data)
	if err != nil {
		return fmt.Errorf("failed to create record: %w", err)
	}

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Created record in %s", table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn records --table %s %s", table, getStringField(record, "sys_id")),
				Description: "View record",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn records --table %s", table),
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
		Use:   "update <sys_id>",
		Short: "Update an existing record",
		Long: `Update an existing record by sys_id. Table is specified by --table.

Field Input:
  Use --field (or -f) to set field values: --field short_description="Updated description"
  Use --data (or -d) to provide a JSON object: --data '{"short_description":"Updated"}'
  Use @file to read a value from a file: -f script=@/tmp/script.js

Examples:
  jsn records --table incident update <sys_id> -f priority=2
  jsn records --table incident update <sys_id> -f state=6 -f close_code="Resolved"
  jsn records --table sys_script update <sys_id> -f script=@/tmp/fix.js`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecordsUpdate(cmd, args[0], fields, jsonData)
		},
	}

	cmd.Flags().StringArrayVarP(&fields, "field", "f", nil, "Set field value (name=value, use @file to read from file)")
	cmd.Flags().StringVarP(&jsonData, "data", "d", "", "JSON object with field values")

	return cmd
}

// runRecordsUpdate executes the records update command.
func runRecordsUpdate(cmd *cobra.Command, sysID string, fields []string, jsonData string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	table, err := getTableFromFlags(cmd, sdkClient, "Select a table:")
	if err != nil {
		return err
	}

	// Build data from fields and/or JSON
	data := make(map[string]interface{})

	if jsonData != "" {
		if err := json.Unmarshal([]byte(jsonData), &data); err != nil {
			return output.ErrUsage(fmt.Sprintf("Invalid JSON: %v", err))
		}
	}

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

	record, err := sdkClient.UpdateRecord(cmd.Context(), table, sysID, data)
	if err != nil {
		return fmt.Errorf("failed to update record: %w", err)
	}

	return outputWriter.OK(record,
		output.WithSummary(fmt.Sprintf("Updated record in %s", table)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         fmt.Sprintf("jsn records --table %s %s", table, sysID),
				Description: "View updated record",
			},
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn records --table %s", table),
				Description: "List all records",
			},
		),
	)
}

// newRecordsDeleteCmd creates the records delete command.
func newRecordsDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete <sys_id>",
		Short: "Delete a record",
		Long: `Delete a record by sys_id. Table is specified by --table.

Examples:
  jsn records --table incident delete <sys_id>
  jsn records --table incident delete <sys_id> --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecordsDelete(cmd, args[0], force)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

// runRecordsDelete executes the records delete command.
func runRecordsDelete(cmd *cobra.Command, sysID string, force bool) error {
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

	table, err := getTableFromFlags(cmd, sdkClient, "Select a table:")
	if err != nil {
		return err
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
		_, _ = fmt.Scanln(&response)
		if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
			return fmt.Errorf("deletion cancelled")
		}
	}

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

// --- Enrichment functions ---

// printQuestionAnswers displays record producer variable answers for any record.
// Queries the question_answer table where table_name=<table> and table_sys_id=<sys_id>.
func printQuestionAnswers(cmd *cobra.Command, sdkClient *sdk.Client, table, sysID string) error {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_query", fmt.Sprintf("table_name=%s^table_sys_id=%s", table, sysID))
	query.Set("sysparm_fields", "question,value")
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(cmd.Context(), "question_answer", query)
	if err != nil {
		return nil // Silently fail - optional enrichment
	}

	if len(resp.Result) == 0 {
		return nil
	}

	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	var answers []struct {
		question string
		value    string
	}

	for _, record := range resp.Result {
		question := ""
		if v, ok := record["question"]; ok && v != nil {
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
			answers = append(answers, struct {
				question string
				value    string
			}{question, value})
		}
	}

	if len(answers) == 0 {
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("─ Record Producer Variables ─"))
	for _, a := range answers {
		fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
			labelStyle.Render(a.question+":"),
			valueStyle.Render(a.value),
		)
	}

	return nil
}

// printCatalogVariables displays catalog variables for an sc_req_item.
// Uses sc_item_option_mtom to find variable definitions, then resolves display labels
// from item_option_new, and gets values from sc_item_option.
func printCatalogVariables(cmd *cobra.Command, sdkClient *sdk.Client, ritmSysID string) error {
	// Step 1: Get the catalog item sys_id from the RITM
	ritmQuery := url.Values{}
	ritmQuery.Set("sysparm_limit", "1")
	ritmQuery.Set("sysparm_query", fmt.Sprintf("sys_id=%s", ritmSysID))
	ritmQuery.Set("sysparm_fields", "cat_item")
	ritmQuery.Set("sysparm_display_value", "false")

	ritmResp, err := sdkClient.Get(cmd.Context(), "sc_req_item", ritmQuery)
	if err != nil || len(ritmResp.Result) == 0 {
		// Fall back to the simple approach
		return printCatalogVariablesSimple(cmd, sdkClient, ritmSysID)
	}

	catItemSysID := getStringField(ritmResp.Result[0], "cat_item")
	if catItemSysID == "" {
		return printCatalogVariablesSimple(cmd, sdkClient, ritmSysID)
	}

	// Step 2: Get variable definitions from sc_item_option_mtom
	mtomQuery := url.Values{}
	mtomQuery.Set("sysparm_limit", "100")
	mtomQuery.Set("sysparm_query", fmt.Sprintf("sc_cat_item=%s", catItemSysID))
	mtomQuery.Set("sysparm_fields", "sc_item_option")
	mtomQuery.Set("sysparm_display_value", "false")

	mtomResp, err := sdkClient.Get(cmd.Context(), "sc_item_option_mtom", mtomQuery)
	if err != nil || len(mtomResp.Result) == 0 {
		// Fall back to the simple approach
		return printCatalogVariablesSimple(cmd, sdkClient, ritmSysID)
	}

	// Collect variable definition sys_ids
	var varDefIDs []string
	for _, record := range mtomResp.Result {
		varID := getStringField(record, "sc_item_option")
		if varID != "" {
			varDefIDs = append(varDefIDs, varID)
		}
	}

	if len(varDefIDs) == 0 {
		return printCatalogVariablesSimple(cmd, sdkClient, ritmSysID)
	}

	// Step 3: Get variable definitions (display labels) from item_option_new
	varDefQuery := url.Values{}
	varDefQuery.Set("sysparm_limit", "100")
	varDefQuery.Set("sysparm_query", fmt.Sprintf("sys_idIN%s", strings.Join(varDefIDs, ",")))
	varDefQuery.Set("sysparm_fields", "sys_id,question_text,name,order")
	varDefQuery.Set("sysparm_display_value", "true")

	varDefResp, err := sdkClient.Get(cmd.Context(), "item_option_new", varDefQuery)
	if err != nil {
		return printCatalogVariablesSimple(cmd, sdkClient, ritmSysID)
	}

	// Build lookup: sys_id → display label
	varLabels := make(map[string]string)
	for _, record := range varDefResp.Result {
		defID := getStringField(record, "sys_id")
		label := getStringField(record, "question_text")
		if label == "" {
			label = getStringField(record, "name")
		}
		if defID != "" && label != "" {
			varLabels[defID] = label
		}
	}

	// Step 4: Get actual variable values from sc_item_option
	optQuery := url.Values{}
	optQuery.Set("sysparm_limit", "100")
	optQuery.Set("sysparm_query", fmt.Sprintf("request_item=%s", ritmSysID))
	optQuery.Set("sysparm_fields", "item_option_new,value")
	optQuery.Set("sysparm_display_value", "true")

	optResp, err := sdkClient.Get(cmd.Context(), "sc_item_option", optQuery)
	if err != nil {
		return nil
	}

	if len(optResp.Result) == 0 {
		return nil
	}

	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	var variables []struct {
		question string
		value    string
	}

	for _, record := range optResp.Result {
		// Get the variable definition reference
		varRef := ""
		displayName := ""
		if v, ok := record["item_option_new"]; ok && v != nil {
			switch val := v.(type) {
			case string:
				varRef = val
			case map[string]interface{}:
				if dv, ok := val["display_value"].(string); ok {
					displayName = dv
				}
				if vv, ok := val["value"].(string); ok {
					varRef = vv
				}
			}
		}

		// Use the resolved label from item_option_new definitions if we have it
		question := displayName
		if varRef != "" {
			if label, ok := varLabels[varRef]; ok {
				question = label
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

// printCatalogVariablesSimple is the fallback that uses sc_item_option display_value directly.
func printCatalogVariablesSimple(cmd *cobra.Command, sdkClient *sdk.Client, ritmSysID string) error {
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

// printMRVS displays multi-row variable set answers for a request item
func printMRVS(cmd *cobra.Command, sdkClient *sdk.Client, ritmSysID string, instanceURL string) error {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_query", fmt.Sprintf("parent_id=%s", ritmSysID))
	query.Set("sysparm_fields", "row_index,item_option_new,value")
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(cmd.Context(), "sc_multi_row_question_answer", query)
	if err != nil {
		return nil // Silently fail - MRVS is optional
	}

	if len(resp.Result) == 0 {
		return nil
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
	for col := range colWidths {
		if colWidths[col] < 12 {
			colWidths[col] = 12
		}
		if colWidths[col] > 40 {
			colWidths[col] = 40
		}
	}

	// Print header
	fmt.Fprintf(cmd.OutOrStdout(), "│ Row │")
	for _, col := range allColumns {
		fmt.Fprintf(cmd.OutOrStdout(), " %-*s │", colWidths[col], col)
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Print separator
	fmt.Fprintf(cmd.OutOrStdout(), "│-----│")
	for _, col := range allColumns {
		fmt.Fprintf(cmd.OutOrStdout(), " %s │", strings.Repeat("-", colWidths[col]))
	}
	fmt.Fprintln(cmd.OutOrStdout())

	// Print rows
	for i, rowID := range rowOrder {
		row := rows[rowID]
		fmt.Fprintf(cmd.OutOrStdout(), "│ %3d │", i+1)
		for _, col := range allColumns {
			val := row[col]
			if len(val) > colWidths[col] {
				val = val[:colWidths[col]-3] + "..."
			}
			fmt.Fprintf(cmd.OutOrStdout(), " %-*s │", colWidths[col], val)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", mutedStyle.Render(fmt.Sprintf("%d rows", len(rows))))

	return nil
}

// --- Helper functions ---

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

// pickRecordPaginated shows a paginated interactive picker for records.
// Fetches pages on demand so the user can scroll through all records.
func pickRecordPaginated(cmd *cobra.Command, sdkClient *sdk.Client, table, displayColumn, query, orderBy string, orderDesc bool) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListRecordsOptions{
			Limit:     limit,
			Offset:    offset,
			Query:     query,
			Fields:    []string{"sys_id", "number", displayColumn},
			OrderBy:   orderBy,
			OrderDesc: orderDesc,
		}
		records, err := sdkClient.ListRecords(ctx, table, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, r := range records {
			sysID := getStringField(r, "sys_id")
			number := getStringField(r, "number")
			display := getStringField(r, displayColumn)

			title := number
			if title == "" {
				title = display
			}
			if title == "" && len(sysID) > 8 {
				title = sysID[:8] + "..."
			}

			desc := display
			if desc == title {
				desc = "" // avoid repeating
			}

			items = append(items, tui.PickerItem{
				ID:          sysID,
				Title:       title,
				Description: desc,
			})
		}

		return &tui.PageResult{
			Items:   items,
			HasMore: len(records) >= limit,
		}, nil
	}

	selected, err := tui.PickWithPagination(
		fmt.Sprintf("Select a record from %s:", table),
		fetcher,
		tui.WithMaxVisible(15),
	)
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", fmt.Errorf("selection cancelled")
	}

	return selected.ID, nil
}

// looksLikeSysID returns true if the string looks like a ServiceNow sys_id (32 hex chars).
func looksLikeSysID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// getFieldValue safely extracts a value from a record map.
func getFieldValue(record map[string]interface{}, field string) interface{} {
	if v, ok := record[field]; ok && v != nil {
		return v
	}
	return ""
}

// getStringField safely extracts a string value from a record map.
// Prefers display_value for human-readable output.
func getStringField(record map[string]interface{}, field string) string {
	v := getFieldValue(record, field)
	if v == nil {
		return ""
	}

	switch val := v.(type) {
	case string:
		return val
	case map[string]interface{}:
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

// getRawField extracts the raw/internal value from a record map.
// Prefers value over display_value — use for sys_class_name, sys_id, etc.
func getRawField(record map[string]interface{}, field string) string {
	v := getFieldValue(record, field)
	if v == nil {
		return ""
	}

	switch val := v.(type) {
	case string:
		return val
	case map[string]interface{}:
		if value, ok := val["value"].(string); ok {
			return value
		}
		if display, ok := val["display_value"].(string); ok {
			return display
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
		if display, ok := val["display_value"].(string); ok {
			return display
		}
		if value, ok := val["value"].(string); ok {
			return value
		}
		return fmt.Sprintf("%v", val)
	case []interface{}:
		var parts []string
		for _, item := range val {
			parts = append(parts, formatValue(item))
		}
		return strings.Join(parts, ", ")
	default:
		return fmt.Sprintf("%v", val)
	}
}

// stringsTitle is a simple title case replacement for Go 1.18+
func stringsTitle(s string) string {
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
