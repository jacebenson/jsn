package commands

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// logsListFlags holds the flags for the logs list command.
type logsListFlags struct {
	table   string
	sysID   string
	source  string
	minutes int
	script  string
	level   string
	limit   int
	query   string
}

// NewLogsCmd creates the logs command group.
func NewLogsCmd() *cobra.Command {
	var flags logsListFlags

	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Query system logs",
		Long: `Query ServiceNow system logs (syslog, syslog_transaction).

Running "jsn logs" without a subcommand lists recent logs.

Examples:
  jsn logs
  jsn logs list --source "Business Rule" --minutes 60
  jsn logs show <sys_id>`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Default to list behavior when no subcommand specified
			return runLogsList(cmd, flags)
		},
	}

	// Add flags to root command for default list behavior
	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().StringVar(&flags.sysID, "sys-id", "", "Filter by record sys_id")
	cmd.Flags().StringVar(&flags.source, "source", "", "Filter by source")
	cmd.Flags().IntVarP(&flags.minutes, "minutes", "m", 60, "Show logs from last N minutes")
	cmd.Flags().StringVar(&flags.script, "script", "", "Filter by script name")
	cmd.Flags().StringVarP(&flags.level, "level", "l", "", "Filter by level (error, warn, info, debug)")
	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of log entries")
	cmd.Flags().StringVar(&flags.query, "query", "", "Additional encoded query")

	cmd.AddCommand(
		newLogsListCmd(),
		newLogsShowCmd(),
	)

	return cmd
}

// newLogsListCmd creates the logs list command.
func newLogsListCmd() *cobra.Command {
	var flags logsListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List system log entries",
		Long: `List ServiceNow system logs (syslog, syslog_transaction).

Examples:
  jsn logs list
  jsn logs list --source "Business Rule" --minutes 60
  jsn logs list --level error --minutes 30
  jsn logs list --query "sourceLIKEscheduler" --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLogsList(cmd, flags)
		},
	}

	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Filter by table name")
	cmd.Flags().StringVar(&flags.sysID, "sys-id", "", "Filter by record sys_id")
	cmd.Flags().StringVar(&flags.source, "source", "", "Filter by source")
	cmd.Flags().IntVarP(&flags.minutes, "minutes", "m", 60, "Show logs from last N minutes")
	cmd.Flags().StringVar(&flags.script, "script", "", "Filter by script name")
	cmd.Flags().StringVarP(&flags.level, "level", "l", "", "Filter by level (error, warn, info, debug)")
	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of log entries")
	cmd.Flags().StringVar(&flags.query, "query", "", "Additional encoded query")

	return cmd
}

// runLogsList executes the logs list command.
func runLogsList(cmd *cobra.Command, flags logsListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build query parts
	var queryParts []string

	if flags.table != "" {
		queryParts = append(queryParts, fmt.Sprintf("sys_created_by=%s", flags.table))
	}

	if flags.source != "" {
		queryParts = append(queryParts, fmt.Sprintf("source=%s", flags.source))
	}

	if flags.level != "" {
		queryParts = append(queryParts, fmt.Sprintf("level=%s", flags.level))
	}

	if flags.script != "" {
		queryParts = append(queryParts, fmt.Sprintf("source=%s", flags.script))
	}

	// Add time filter
	if flags.minutes > 0 {
		queryParts = append(queryParts, fmt.Sprintf("sys_created_on>javascript:gs.minutesAgo(%d)", flags.minutes))
	}

	if flags.query != "" {
		queryParts = append(queryParts, flags.query)
	}

	sysparmQuery := strings.Join(queryParts, "^")

	opts := &sdk.ListLogsOptions{
		Limit: flags.limit,
		Query: sysparmQuery,
		// Default order: "sys_created_on" descending - newest logs first for debugging
		OrderBy:   "sys_created_on",
		OrderDesc: true,
	}

	logs, err := sdkClient.ListLogs(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list logs: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledLogs(cmd, logs, flags)
	}

	if format == output.FormatMarkdown {
		return printMarkdownLogs(cmd, logs, flags)
	}

	// Build data for JSON
	var data []map[string]any
	for _, log := range logs {
		data = append(data, map[string]any{
			"sys_id":         log.SysID,
			"level":          log.Level,
			"message":        log.Message,
			"source":         log.Source,
			"sys_created_on": log.CreatedOn,
			"sys_created_by": log.CreatedBy,
		})
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d log entries", len(logs))),
	)
}

// printStyledLogs outputs styled logs list.
func printStyledLogs(cmd *cobra.Command, logs []sdk.LogEntry, flags logsListFlags) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ff0000"))
	warnStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ffaa00"))
	infoStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00"))
	debugStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#8888ff"))

	fmt.Fprintln(cmd.OutOrStdout())

	// Build filter description
	filters := []string{}
	if flags.source != "" {
		filters = append(filters, fmt.Sprintf("source=%s", flags.source))
	}
	if flags.level != "" {
		filters = append(filters, fmt.Sprintf("level=%s", flags.level))
	}
	if flags.minutes > 0 {
		filters = append(filters, fmt.Sprintf("last %dm", flags.minutes))
	}

	title := "System Logs"
	if len(filters) > 0 {
		title = fmt.Sprintf("System Logs (%s)", strings.Join(filters, ", "))
	}
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(logs) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No log entries found."))
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	}

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-8s %-20s %-28s %s\n",
		headerStyle.Render("Sys ID"),
		headerStyle.Render("Level"),
		headerStyle.Render("Time"),
		headerStyle.Render("Source"),
		headerStyle.Render("Message"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Logs
	for _, log := range logs {
		levelStyle := mutedStyle
		switch strings.ToLower(log.Level) {
		case "error":
			levelStyle = errorStyle
		case "warn", "warning":
			levelStyle = warnStyle
		case "info":
			levelStyle = infoStyle
		case "debug":
			levelStyle = debugStyle
		}

		time := log.CreatedOn
		if len(time) > 16 {
			time = time[:16]
		}

		source := log.Source
		if source == "" {
			source = "-"
		}
		if len(source) > 26 {
			source = source[:23] + "..."
		}

		message := log.Message
		if message == "" {
			message = "-"
		}
		if len(message) > 40 {
			message = message[:37] + "..."
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-8s %-20s %-28s %s\n",
			mutedStyle.Render(log.SysID),
			levelStyle.Render(log.Level),
			mutedStyle.Render(time),
			mutedStyle.Render(source),
			mutedStyle.Render(message),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn logs list --source \"Business Rule\" --minutes 60",
		mutedStyle.Render("Recent business rule logs"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn logs list --level error --minutes 30",
		mutedStyle.Render("Recent errors"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn logs show <sys_id>",
		mutedStyle.Render("Show log details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownLogs outputs markdown logs list.
func printMarkdownLogs(cmd *cobra.Command, logs []sdk.LogEntry, flags logsListFlags) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**System Logs**")
	fmt.Fprintln(cmd.OutOrStdout())

	if len(logs) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No log entries found.")
		return nil
	}

	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Level | Time | Source | Message |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|-------|------|--------|---------|")

	for _, log := range logs {
		time := log.CreatedOn
		if len(time) > 16 {
			time = time[:16]
		}
		source := log.Source
		if source == "" {
			source = "-"
		}
		message := log.Message
		if message == "" {
			message = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s | %s |\n",
			log.SysID, log.Level, time, source, message)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newLogsShowCmd creates the logs show command.
func newLogsShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "show <sys_id>",
		Aliases: []string{"get"},
		Short:   "Show a log entry",
		Long: `Display detailed information about a specific log entry.

Examples:
  jsn logs show 0123456789abcdef0123456789abcdef`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLogsShow(cmd, args[0])
		},
	}
}

// runLogsShow executes the logs show command.
func runLogsShow(cmd *cobra.Command, sysID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get the log entry
	log, err := sdkClient.GetLog(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to get log entry: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledLogEntry(cmd, log)
	}

	if format == output.FormatMarkdown {
		return printMarkdownLogEntry(cmd, log)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         log.SysID,
		"level":          log.Level,
		"message":        log.Message,
		"source":         log.Source,
		"sys_created_on": log.CreatedOn,
		"sys_created_by": log.CreatedBy,
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Log Entry: %s", log.SysID)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn logs list",
				Description: "List all logs",
			},
		),
	)
}

// printStyledLogEntry outputs styled log entry details.
func printStyledLogEntry(cmd *cobra.Command, log *sdk.LogEntry) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Log Entry"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(log.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Level:"), valueStyle.Render(log.Level))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Source:"), valueStyle.Render(log.Source))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(log.CreatedOn))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Created By:"), valueStyle.Render(log.CreatedBy))

	if log.Message != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Message:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(log.Message))
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn logs list",
		mutedStyle.Render("List all logs"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownLogEntry outputs markdown log entry details.
func printMarkdownLogEntry(cmd *cobra.Command, log *sdk.LogEntry) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Log Entry**")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", log.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Level:** %s\n", log.Level)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Source:** %s\n", log.Source)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Created:** %s by %s\n", log.CreatedOn, log.CreatedBy)
	if log.Message != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Message:** %s\n", log.Message)
	}
	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// NewInstanceCmd creates the instance command group.
func NewInstanceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "instance",
		Short: "Instance information and diagnostics",
		Long: `Query ServiceNow instance information, version, plugins, and statistics.

Running "jsn instance" without a subcommand shows instance info.

Examples:
  jsn instance
  jsn instance info`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Default to showing instance info
			return runInstanceInfo(cmd)
		},
	}

	cmd.AddCommand(
		newInstanceInfoCmd(),
	)

	return cmd
}

// newInstanceInfoCmd creates the instance info command.
func newInstanceInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "info",
		Short: "Show instance information",
		Long: `Display ServiceNow instance version, patch level, and other system information.

Examples:
  jsn instance info
  jsn instance info --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInstanceInfo(cmd)
		},
	}
}

// runInstanceInfo executes the instance info command.
func runInstanceInfo(cmd *cobra.Command) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	info, err := sdkClient.GetInstanceInfo(cmd.Context())
	if err != nil {
		return fmt.Errorf("failed to get instance info: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledInstanceInfo(cmd, info)
	}

	if format == output.FormatMarkdown {
		return printMarkdownInstanceInfo(cmd, info)
	}

	// Build data for JSON
	data := map[string]any{
		"version":          info.Version,
		"build":            info.Build,
		"build_date":       info.BuildDate,
		"patch":            info.Patch,
		"instance_name":    info.InstanceName,
		"time_zone":        info.TimeZone,
		"user_name":        info.UserName,
		"user_sys_id":      info.UserSysID,
		"glide_properties": info.GlideProperties,
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Instance: %s", info.InstanceName)),
	)
}

// printStyledInstanceInfo outputs styled instance info.
func printStyledInstanceInfo(cmd *cobra.Command, info *sdk.InstanceInfo) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Instance Information"))
	fmt.Fprintln(cmd.OutOrStdout())

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Instance:"), valueStyle.Render(info.InstanceName))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Version:"), valueStyle.Render(info.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Build:"), valueStyle.Render(info.Build))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Build Date:"), valueStyle.Render(info.BuildDate))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Patch:"), valueStyle.Render(info.Patch))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Time Zone:"), valueStyle.Render(info.TimeZone))
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("User:"), valueStyle.Render(info.UserName))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("User Sys ID:"), valueStyle.Render(info.UserSysID))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn logs list --level error --minutes 60",
		mutedStyle.Render("View recent errors"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownInstanceInfo outputs markdown instance info.
func printMarkdownInstanceInfo(cmd *cobra.Command, info *sdk.InstanceInfo) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Instance Information**")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- **Instance:** %s\n", info.InstanceName)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Version:** %s\n", info.Version)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Build:** %s\n", info.Build)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Build Date:** %s\n", info.BuildDate)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Patch:** %s\n", info.Patch)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Time Zone:** %s\n", info.TimeZone)
	fmt.Fprintf(cmd.OutOrStdout(), "- **User:** %s\n", info.UserName)
	fmt.Fprintf(cmd.OutOrStdout(), "- **User Sys ID:** %s\n", info.UserSysID)
	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}
