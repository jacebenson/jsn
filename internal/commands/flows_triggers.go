package commands

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// flowsAddTriggerFlags holds the flags for the flows add-trigger command.
type flowsAddTriggerFlags struct {
	triggerType string
	table       string
	condition   string
	schedule    string // daily, weekly, monthly, once, repeat
	time        string // HH:MM:SS for daily/weekly/monthly
	day         string // day of week (1-7) or day of month (1-31)
	date        string // YYYY-MM-DD HH:MM:SS for once
	repeat      string // duration for repeat (e.g., "1970-01-02 06:00:00")
}

// newFlowsTriggersCmd creates the flows triggers subcommand group.
func newFlowsTriggersCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "triggers",
		Short: "Manage flow triggers",
		Long: `Add, list, and remove triggers from Flow Designer flows.

Triggers determine when a flow runs:
  - Record triggers: When records are created or updated
  - Scheduled triggers: Run on a schedule (daily, weekly, etc.)
  - Application triggers: Service Catalog, etc.

Examples:
  # List triggers on a flow
  jsn flows triggers list "My Flow"

  # Add a record trigger
  jsn flows triggers add "My Flow" --type created --table incident

  # Add with condition
  jsn flows triggers add "My Flow" --type created --table incident \
    --condition "priority=1"

  # Add scheduled trigger
  jsn flows triggers add "My Flow" --schedule daily --time "09:00:00"

  # Remove a trigger
  jsn flows triggers remove "My Flow" <trigger_id>`,
	}

	cmd.AddCommand(
		newFlowsTriggersListCmd(),
		newFlowsTriggersAddCmd(),
		newFlowsTriggersRemoveCmd(),
	)

	return cmd
}

// newFlowsTriggersListCmd creates the flows triggers list command.
func newFlowsTriggersListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <flow_name_or_sys_id>",
		Short: "List triggers on a flow",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsTriggersList(cmd, args[0])
		},
	}

	return cmd
}

// runFlowsTriggersList lists triggers on a flow.
func runFlowsTriggersList(cmd *cobra.Command, flowID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Inspect flow to get triggers
	inspection, err := sdkClient.InspectFlow(cmd.Context(), flowID)
	if err != nil {
		return fmt.Errorf("failed to inspect flow: %w", err)
	}

	// Display triggers
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ffffff"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s %s\n", headerStyle.Render("Triggers for:"), inspection.Flow.Name)
	fmt.Fprintln(cmd.OutOrStdout())

	// Check if we have trigger instances
	if len(inspection.TriggerInstances) > 0 {
		for i, trigger := range inspection.TriggerInstances {
			fmt.Fprintf(cmd.OutOrStdout(), "  %d. ", i+1)

			// Get trigger name
			if name, ok := trigger["name"].(string); ok && name != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render(name))
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "%s", valueStyle.Render("Trigger"))
			}
			fmt.Fprintln(cmd.OutOrStdout())

			// Display trigger details
			if sysID, ok := trigger["sys_id"].(string); ok {
				fmt.Fprintf(cmd.OutOrStdout(), "     ID: %s\n", mutedStyle.Render(sysID))
			}
			fmt.Fprintln(cmd.OutOrStdout())
		}
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No triggers configured"))
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  Add a trigger:"))
		fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render("jsn flows triggers add \""+inspection.Flow.Name+"\" --type created --table incident"))
		fmt.Fprintln(cmd.OutOrStdout())
	}

	return nil
}

// newFlowsTriggersAddCmd creates the flows triggers add command.
func newFlowsTriggersAddCmd() *cobra.Command {
	var flags flowsAddTriggerFlags

	cmd := &cobra.Command{
		Use:   "add <flow_name_or_sys_id>",
		Short: "Add a trigger to a flow",
		Long: `Add a trigger to an existing flow.

Record Trigger Types:
  created               When a new record is created
  updated               When a record is updated  
  created_or_updated    When a record is created or updated

Scheduled Trigger Types:
  daily                 Run daily at specified time
  weekly                Run weekly on specified day
  monthly               Run monthly on specified day
  once                  Run once at specified datetime
  repeat                Run on a repeating interval

Examples:
  # Record trigger - interactive
  jsn flows triggers add "My Flow"

  # Record trigger - non-interactive
  jsn flows triggers add "My Flow" --type created --table incident
  jsn flows triggers add "My Flow" --type updated --table change_request \
    --condition "priority=1"

  # Scheduled triggers
  jsn flows triggers add "My Flow" --schedule daily --time "08:00:00"
  jsn flows triggers add "My Flow" --schedule weekly --day 1 --time "09:00:00"
  jsn flows triggers add "My Flow" --schedule monthly --day 15 --time "10:00:00"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsTriggersAdd(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.triggerType, "type", "", "Trigger type: created, updated, created_or_updated")
	cmd.Flags().StringVar(&flags.table, "table", "", "Table name (e.g., incident, change_request)")
	cmd.Flags().StringVar(&flags.condition, "condition", "", "Condition/filter (e.g., priority=1)")
	cmd.Flags().StringVar(&flags.schedule, "schedule", "", "Schedule type: daily, weekly, monthly, once, repeat")
	cmd.Flags().StringVar(&flags.time, "time", "", "Time to run (HH:MM:SS)")
	cmd.Flags().StringVar(&flags.day, "day", "", "Day of week (1-7) or day of month (1-31)")
	cmd.Flags().StringVar(&flags.date, "date", "", "Date/time for once schedule (YYYY-MM-DD HH:MM:SS)")
	cmd.Flags().StringVar(&flags.repeat, "repeat", "", "Repeat interval duration")

	return cmd
}

// runFlowsTriggersAdd adds a trigger to a flow.
func runFlowsTriggersAdd(cmd *cobra.Command, flowID string, flags flowsAddTriggerFlags) error {
	// Just delegate to the existing add-trigger logic
	return runFlowsAddTrigger(cmd, flowID, flags)
}

// newFlowsTriggersRemoveCmd creates the flows triggers remove command.
func newFlowsTriggersRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <flow_name_or_sys_id> <trigger_id>",
		Short: "Remove a trigger from a flow",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsTriggersRemove(cmd, args[0], args[1])
		},
	}

	return cmd
}

// runFlowsTriggersRemove removes a trigger from a flow.
func runFlowsTriggersRemove(cmd *cobra.Command, flowID, triggerID string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	// TODO: Implement trigger removal via SDK
	return fmt.Errorf("trigger removal not yet implemented")
}

// newFlowsAddTriggerCmd creates the flows add-trigger command.
func newFlowsAddTriggerCmd() *cobra.Command {
	var flags flowsAddTriggerFlags

	cmd := &cobra.Command{
		Use:   "add-trigger <flow_name_or_sys_id>",
		Short: "Add a trigger to an existing flow",
		Long: `Add a trigger to an existing flow.

Examples:
  # Interactive mode (in TTY)
  jsn flows add-trigger "My Flow"

  # Record triggers (non-interactive)
  jsn flows add-trigger "My Flow" --type record_create --table incident
  jsn flows add-trigger "My Flow" --type record_update --table ticket --condition "priority=1"

  # Scheduled triggers (non-interactive)
  jsn flows add-trigger "My Flow" --schedule daily --time 08:00:00
  jsn flows add-trigger "My Flow" --schedule weekly --day 3 --time 09:30:00
  jsn flows add-trigger "My Flow" --schedule monthly --day 15 --time 14:00:00
  jsn flows add-trigger "My Flow" --schedule once --date "2026-06-15 10:00:00"
  jsn flows add-trigger "My Flow" --schedule repeat --repeat "1970-01-02 06:00:00"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runFlowsAddTrigger(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.triggerType, "type", "", "Trigger type: record_create, record_update, record_create_or_update")
	cmd.Flags().StringVar(&flags.table, "table", "", "Table name (e.g., incident, change_request)")
	cmd.Flags().StringVar(&flags.condition, "condition", "", "Condition filter (optional, e.g., priority=1)")
	cmd.Flags().StringVar(&flags.schedule, "schedule", "", "Schedule type: daily, weekly, monthly, once, repeat")
	cmd.Flags().StringVar(&flags.time, "time", "", "Time to run (HH:MM:SS, default 08:00:00)")
	cmd.Flags().StringVar(&flags.day, "day", "", "Day of week (1-7, 1=Mon) or day of month (1-31)")
	cmd.Flags().StringVar(&flags.date, "date", "", "Date/time for run-once (YYYY-MM-DD HH:MM:SS)")
	cmd.Flags().StringVar(&flags.repeat, "repeat", "", "Repeat interval as duration (e.g., 1970-01-02 06:00:00 = 1 day)")

	return cmd
}

// runFlowsAddTrigger executes the flows add-trigger command.
func runFlowsAddTrigger(cmd *cobra.Command, flowID string, flags flowsAddTriggerFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Scheduled trigger path
	if flags.schedule != "" {
		opts := sdk.CreateScheduledTriggerOptions{
			FlowID:   flowID,
			Schedule: flags.schedule,
			Time:     flags.time,
			Day:      flags.day,
			Date:     flags.date,
			Repeat:   flags.repeat,
		}

		if err := sdkClient.CreateScheduledTrigger(cmd.Context(), opts); err != nil {
			return fmt.Errorf("failed to create scheduled trigger: %w", err)
		}

		outputWriter := appCtx.Output.(*output.Writer)
		return outputWriter.OK(map[string]interface{}{
			"flow":     flowID,
			"schedule": flags.schedule,
		}, output.WithSummary(fmt.Sprintf("Added %s trigger to flow", flags.schedule)))
	}

	// Record trigger path: if not all flags provided and in TTY, use interactive mode
	if isTerminal && (flags.triggerType == "" || flags.table == "") {
		return interactiveAddRecordTriggerToFlow(cmd, sdkClient, flowID)
	}

	// Validate required flags
	if flags.triggerType == "" {
		return output.ErrUsage("trigger type is required (use --type or --schedule, or run interactively)")
	}
	if flags.table == "" {
		return output.ErrUsage("table name is required (use --table or run interactively)")
	}

	// Map trigger type
	triggerType := flags.triggerType
	if triggerType == "create" {
		triggerType = "record_create"
	} else if triggerType == "update" {
		triggerType = "record_update"
	} else if triggerType == "create_or_update" {
		triggerType = "record_create_or_update"
	}

	// Create the trigger
	opts := sdk.CreateRecordTriggerOptions{
		FlowID:    flowID,
		Table:     flags.table,
		Operation: triggerType,
		Condition: flags.condition,
	}

	if err := sdkClient.CreateRecordTrigger(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to create trigger: %w", err)
	}

	// Success output
	outputWriter := appCtx.Output.(*output.Writer)
	return outputWriter.OK(map[string]interface{}{
		"flow":      flowID,
		"trigger":   triggerType,
		"table":     flags.table,
		"condition": flags.condition,
	}, output.WithSummary(fmt.Sprintf("Added %s trigger on %s", triggerType, flags.table)))
}

// interactiveAddTrigger interactively configures a trigger for the flow
func interactiveAddTrigger(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	// Trigger category selection
	categoryItems := []tui.PickerItem{
		{ID: "record", Title: "Record", Description: "Trigger when records change"},
		{ID: "scheduled", Title: "Scheduled", Description: "Run on a schedule"},
		{ID: "application", Title: "Application", Description: "Trigger from apps like Service Catalog"},
	}

	category, err := tui.Pick("Select trigger category:", categoryItems)
	if err != nil || category == nil {
		return nil
	}

	switch category.ID {
	case "record":
		return interactiveAddRecordTrigger(cmd, sdkClient, flowID)
	case "scheduled":
		return interactiveAddScheduledTrigger(cmd, sdkClient, flowID)
	case "application":
		return interactiveAddApplicationTrigger(cmd, sdkClient, flowID)
	}

	return nil
}

// interactiveAddRecordTrigger configures a record-based trigger
func interactiveAddRecordTrigger(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	reader := bufio.NewReader(os.Stdin)

	// Trigger type
	typeItems := []tui.PickerItem{
		{ID: "create", Title: "Created", Description: "When a new record is created"},
		{ID: "update", Title: "Updated", Description: "When a record is updated"},
		{ID: "create_or_update", Title: "Created or Updated", Description: "When a record is created or updated"},
	}

	triggerType, err := tui.Pick("When should this trigger?", typeItems)
	if err != nil || triggerType == nil {
		return nil
	}

	// Table name
	fmt.Print("Table name (e.g., incident, change_request): ")
	table, _ := reader.ReadString('\n')
	table = strings.TrimSpace(table)
	if table == "" {
		return fmt.Errorf("table name is required")
	}

	// Condition (optional)
	fmt.Print("Condition - when should it run? (optional, e.g., priority=1): ")
	condition, _ := reader.ReadString('\n')
	condition = strings.TrimSpace(condition)

	// Show what we're about to do
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Creating trigger..."))

	// Create the trigger via SDK
	opts := sdk.CreateRecordTriggerOptions{
		FlowID:    flowID,
		Table:     table,
		Operation: triggerType.ID,
		Condition: condition,
	}

	if err := sdkClient.CreateRecordTrigger(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to create trigger: %w", err)
	}

	// Success message
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00"))
	fmt.Fprintf(cmd.OutOrStdout(), successStyle.Render("✓ Trigger created: %s on %s"), triggerType.Title, table)
	if condition != "" {
		fmt.Fprintf(cmd.OutOrStdout(), " when %s", condition)
	}
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// interactiveAddScheduledTrigger configures a scheduled trigger
func interactiveAddScheduledTrigger(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	// Schedule type
	typeItems := []tui.PickerItem{
		{ID: "daily", Title: "Daily", Description: "Run every day"},
		{ID: "weekly", Title: "Weekly", Description: "Run on specific days of the week"},
		{ID: "monthly", Title: "Monthly", Description: "Run monthly"},
		{ID: "once", Title: "Run Once", Description: "Run one time at a specific date/time"},
		{ID: "repeat", Title: "Repeat", Description: "Repeat at intervals"},
	}

	scheduleType, err := tui.Pick("Schedule type:", typeItems)
	if err != nil || scheduleType == nil {
		return nil
	}

	reader := bufio.NewReader(os.Stdin)
	opts := sdk.CreateScheduledTriggerOptions{
		FlowID:   flowID,
		Schedule: scheduleType.ID,
	}

	// Time input (only daily, weekly, monthly need it)
	switch scheduleType.ID {
	case "daily", "weekly", "monthly":
		fmt.Fprint(cmd.OutOrStdout(), "  Time (HH:MM:SS, default 08:00:00): ")
		timeStr, _ := reader.ReadString('\n')
		timeStr = strings.TrimSpace(timeStr)
		if timeStr != "" {
			opts.Time = timeStr
		}
	}

	// Type-specific inputs
	switch scheduleType.ID {
	case "weekly":
		dayItems := []tui.PickerItem{
			{ID: "1", Title: "Monday"},
			{ID: "2", Title: "Tuesday"},
			{ID: "3", Title: "Wednesday"},
			{ID: "4", Title: "Thursday"},
			{ID: "5", Title: "Friday"},
			{ID: "6", Title: "Saturday"},
			{ID: "7", Title: "Sunday"},
		}
		day, err := tui.Pick("Day of week:", dayItems)
		if err != nil || day == nil {
			return nil
		}
		opts.Day = day.ID

	case "monthly":
		fmt.Fprint(cmd.OutOrStdout(), "  Day of month (1-31): ")
		dayStr, _ := reader.ReadString('\n')
		dayStr = strings.TrimSpace(dayStr)
		if dayStr == "" {
			dayStr = "1"
		}
		opts.Day = dayStr

	case "once":
		fmt.Fprint(cmd.OutOrStdout(), "  Date/time (YYYY-MM-DD HH:MM:SS): ")
		dateStr, _ := reader.ReadString('\n')
		dateStr = strings.TrimSpace(dateStr)
		if dateStr == "" {
			return fmt.Errorf("date/time is required for run-once triggers")
		}
		opts.Date = dateStr

	case "repeat":
		fmt.Fprintln(cmd.OutOrStdout(), "  Repeat interval:")
		fmt.Fprint(cmd.OutOrStdout(), "    Days (0-365, default 0): ")
		daysStr, _ := reader.ReadString('\n')
		daysStr = strings.TrimSpace(daysStr)
		days := 0
		if daysStr != "" {
			if d, err := strconv.Atoi(daysStr); err == nil {
				days = d
			}
		}

		fmt.Fprint(cmd.OutOrStdout(), "    Hours (0-23, default 0): ")
		hoursStr, _ := reader.ReadString('\n')
		hoursStr = strings.TrimSpace(hoursStr)
		hours := 0
		if hoursStr != "" {
			if h, err := strconv.Atoi(hoursStr); err == nil {
				hours = h
			}
		}

		fmt.Fprint(cmd.OutOrStdout(), "    Minutes (0-59, default 0): ")
		minsStr, _ := reader.ReadString('\n')
		minsStr = strings.TrimSpace(minsStr)
		mins := 0
		if minsStr != "" {
			if m, err := strconv.Atoi(minsStr); err == nil {
				mins = m
			}
		}

		fmt.Fprint(cmd.OutOrStdout(), "    Seconds (0-59, default 0): ")
		secsStr, _ := reader.ReadString('\n')
		secsStr = strings.TrimSpace(secsStr)
		secs := 0
		if secsStr != "" {
			if s, err := strconv.Atoi(secsStr); err == nil {
				secs = s
			}
		}

		if days == 0 && hours == 0 && mins == 0 && secs == 0 {
			return fmt.Errorf("repeat interval must be greater than zero")
		}

		// ServiceNow encodes repeat interval as duration-since-epoch datetime:
		// 1970-01-01 00:00:00 = 0, so add days to day 1, etc.
		opts.Repeat = fmt.Sprintf("1970-01-%02d %02d:%02d:%02d", days+1, hours, mins, secs)
	}

	err = sdkClient.CreateScheduledTrigger(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to create scheduled trigger: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  ✓ %s trigger added to flow\n", scheduleType.Title)

	return nil
}

// interactiveAddApplicationTrigger configures an application trigger
func interactiveAddApplicationTrigger(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	// Application type
	typeItems := []tui.PickerItem{
		{ID: "service_catalog", Title: "Service Catalog", Description: "Trigger from catalog item"},
	}

	appType, err := tui.Pick("Application:", typeItems)
	if err != nil || appType == nil {
		return nil
	}

	err = sdkClient.CreateApplicationTrigger(cmd.Context(), sdk.CreateApplicationTriggerOptions{
		FlowID:      flowID,
		Application: appType.ID,
	})
	if err != nil {
		return fmt.Errorf("failed to create application trigger: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  ✓ %s trigger added to flow\n", appType.Title)

	return nil
}

// interactiveAddRecordTriggerToFlow interactively adds a trigger to an existing flow
func interactiveAddRecordTriggerToFlow(cmd *cobra.Command, sdkClient *sdk.Client, flowID string) error {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Add Trigger to Flow"))
	fmt.Println()

	// Trigger type
	typeItems := []tui.PickerItem{
		{ID: "record_create", Title: "Created", Description: "When a new record is created"},
		{ID: "record_update", Title: "Updated", Description: "When a record is updated"},
		{ID: "record_create_or_update", Title: "Created or Updated", Description: "When a record is created or updated"},
	}

	triggerType, err := tui.Pick("When should this trigger?", typeItems)
	if err != nil || triggerType == nil {
		return nil
	}

	// Table name
	fmt.Print("Table name (e.g., incident, change_request): ")
	table, _ := reader.ReadString('\n')
	table = strings.TrimSpace(table)
	if table == "" {
		return fmt.Errorf("table name is required")
	}

	// Condition (optional)
	fmt.Print("Condition - when should it run? (optional, e.g., priority=1): ")
	condition, _ := reader.ReadString('\n')
	condition = strings.TrimSpace(condition)

	// Show what we're about to do
	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("Creating trigger..."))

	// Create the trigger via SDK
	opts := sdk.CreateRecordTriggerOptions{
		FlowID:    flowID,
		Table:     table,
		Operation: triggerType.ID,
		Condition: condition,
	}

	if err := sdkClient.CreateRecordTrigger(cmd.Context(), opts); err != nil {
		return fmt.Errorf("failed to create trigger: %w", err)
	}

	// Success message
	fmt.Println()
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00aa00"))
	fmt.Printf(successStyle.Render("✓ Trigger created: %s on %s"), triggerType.Title, table)
	if condition != "" {
		fmt.Printf(" when %s", condition)
	}
	fmt.Println()
	fmt.Println()

	return nil
}
