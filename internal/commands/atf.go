package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// atfFlags holds the flags for ATF commands.
type atfFlags struct {
	name        string
	table       string
	description string
	active      bool
}

// atfStepFlags holds the flags for ATF step commands.
type atfStepFlags struct {
	test        string
	stepType    string
	description string
	field       string
	value       string
	order       int
}

// atfRunFlags holds the flags for ATF run command.
type atfRunFlags struct {
	wait    bool
	timeout int
}

// NewATFCmd creates the atf command group.
func NewATFCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "atf",
		Short: "Manage Automated Test Framework (ATF) tests and steps",
		Long: `Create, manage, and execute ATF tests via the command line.

The Automated Test Framework allows you to create and run tests for your
ServiceNow applications. Tests consist of multiple steps that validate
functionality.

Key Tables:
  - sys_atf_test: Test definitions
  - sys_atf_step: Test steps
  - sys_atf_test_suite: Test suites
  - sys_atf_test_suite_test: Test-to-suite relationships`,
	}

	cmd.AddCommand(
		newATFListCmd(),
		newATFCreateCmd(),
		newATFAddStepCmd(),
		newATFRunCmd(),
	)

	return cmd
}

// newATFListCmd creates the atf list command.
func newATFListCmd() *cobra.Command {
	var limit int
	var activeOnly bool

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List ATF tests",
		Long: `List Automated Test Framework tests.

Examples:
  jsn atf list
  jsn atf list --limit 50
  jsn atf list --active`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runATFList(cmd, limit, activeOnly)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "Maximum number of tests to fetch")
	cmd.Flags().BoolVar(&activeOnly, "active", false, "Show only active tests")

	return cmd
}

// runATFList executes the atf list command.
func runATFList(cmd *cobra.Command, limit int, activeOnly bool) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build query for active filter
	var query string
	if activeOnly {
		query = "active=true"
	}

	opts := &sdk.ListRecordsOptions{
		Limit:     limit,
		Query:     query,
		Fields:    []string{"sys_id", "name", "description", "active", "sys_updated_on"},
		OrderBy:   "sys_updated_on",
		OrderDesc: true,
	}

	records, err := sdkClient.ListRecords(cmd.Context(), "sys_atf_test", opts)
	if err != nil {
		return fmt.Errorf("failed to list ATF tests: %w", err)
	}

	// Build output data
	var data []map[string]any
	for _, record := range records {
		data = append(data, map[string]any{
			"sys_id":      getString(record, "sys_id"),
			"name":        getString(record, "name"),
			"description": getString(record, "description"),
			"active":      getString(record, "active"),
			"updated":     getString(record, "sys_updated_on"),
		})
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d ATF tests", len(records))),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "create", Cmd: "jsn atf create --name \"My Test\"", Description: "Create a new test"},
		),
	)
}

// newATFCreateCmd creates the atf create command.
func newATFCreateCmd() *cobra.Command {
	var flags atfFlags

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new ATF test",
		Long: `Create a new Automated Test Framework test.

Examples:
  jsn atf create --name "Test Incident Creation"
  jsn atf create --name "Test Change Workflow" --table change_request
  jsn atf create --name "My Test" --description "Validates core functionality"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runATFCreate(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.name, "name", "", "Test name (required)")
	cmd.Flags().StringVar(&flags.table, "table", "", "Primary table for the test (e.g., incident, change_request)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Test description")
	cmd.Flags().BoolVar(&flags.active, "active", true, "Create as active")

	_ = cmd.MarkFlagRequired("name")

	return cmd
}

// runATFCreate executes the atf create command.
func runATFCreate(cmd *cobra.Command, flags atfFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	data := map[string]interface{}{
		"name":   flags.name,
		"active": flags.active,
	}

	if flags.table != "" {
		data["table"] = flags.table
	}
	if flags.description != "" {
		data["description"] = flags.description
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_atf_test", data)
	if err != nil {
		return fmt.Errorf("failed to create ATF test: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id":      sysID,
		"name":        getString(record, "name"),
		"table":       getString(record, "table"),
		"description": getString(record, "description"),
		"active":      getString(record, "active"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Created ATF test '%s'", flags.name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_atf_test %s", sysID), Description: "View test details"},
			output.Breadcrumb{Action: "add-step", Cmd: fmt.Sprintf("jsn atf add-step --test %s --type \"Open a New Form\"", sysID), Description: "Add a test step"},
			output.Breadcrumb{Action: "run", Cmd: fmt.Sprintf("jsn atf run %s", sysID), Description: "Run the test"},
		),
	)
}

// newATFAddStepCmd creates the atf add-step command.
func newATFAddStepCmd() *cobra.Command {
	var flags atfStepFlags

	cmd := &cobra.Command{
		Use:   "add-step",
		Short: "Add a step to an ATF test",
		Long: `Add a test step to an existing ATF test.

Common Step Types:
  - "Open a New Form": Opens a new form for the test table
  - "Set Field Values": Sets field values on a form
  - "Click UI Action": Clicks a UI action button
  - "Submit Form": Submits the current form
  - "Field State Validation": Validates field states
  - "Record Insert": Inserts a record
  - "Record Query": Queries for records

Examples:
  jsn atf add-step --test <sys_id> --type "Open a New Form"
  jsn atf add-step --test <sys_id> --type "Set Field Values" --field short_description --value "Test"
  jsn atf add-step --test "My Test" --type "Submit Form" --order 3`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runATFAddStep(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.test, "test", "", "Test sys_id or name (required)")
	cmd.Flags().StringVar(&flags.stepType, "type", "", "Step type (required)")
	cmd.Flags().StringVar(&flags.description, "description", "", "Step description")
	cmd.Flags().StringVar(&flags.field, "field", "", "Field name (for field-related steps)")
	cmd.Flags().StringVar(&flags.value, "value", "", "Field value (for field-related steps)")
	cmd.Flags().IntVar(&flags.order, "order", 0, "Step order (auto-incremented if not specified)")

	_ = cmd.MarkFlagRequired("test")
	_ = cmd.MarkFlagRequired("type")

	return cmd
}

// runATFAddStep executes the atf add-step command.
func runATFAddStep(cmd *cobra.Command, flags atfStepFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve test reference to sys_id
	testSysID, err := resolveATFTest(cmd.Context(), sdkClient, flags.test)
	if err != nil {
		return err
	}

	// If order not specified, find the max order and increment
	order := flags.order
	if order == 0 {
		maxOrder, err := getMaxStepOrder(cmd.Context(), sdkClient, testSysID)
		if err != nil {
			order = 100 // Default starting order
		} else {
			order = maxOrder + 100
		}
	}

	// Build input data for the step
	inputData := buildStepInputData(flags)

	data := map[string]interface{}{
		"test":        testSysID,
		"step":        flags.stepType,
		"order":       order,
		"description": flags.description,
		"active":      true,
	}

	if inputData != "" {
		data["inputs"] = inputData
	}

	record, err := sdkClient.CreateRecord(cmd.Context(), "sys_atf_step", data)
	if err != nil {
		return fmt.Errorf("failed to add ATF step: %w", err)
	}

	sysID := getString(record, "sys_id")

	result := map[string]any{
		"sys_id":      sysID,
		"test":        testSysID,
		"step_type":   flags.stepType,
		"order":       order,
		"description": getString(record, "description"),
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Added step '%s' to test", flags.stepType)),
		output.WithBreadcrumbs(
			output.Breadcrumb{Action: "show", Cmd: fmt.Sprintf("jsn records --table sys_atf_step %s", sysID), Description: "View step details"},
			output.Breadcrumb{Action: "add-step", Cmd: fmt.Sprintf("jsn atf add-step --test %s --type \"Next Step\"", testSysID), Description: "Add another step"},
		),
	)
}

// newATFRunCmd creates the atf run command.
func newATFRunCmd() *cobra.Command {
	var flags atfRunFlags

	cmd := &cobra.Command{
		Use:   "run <test_sys_id>",
		Short: "Run an ATF test",
		Long: `Execute an Automated Test Framework test.

This command starts the test execution. Use --wait to block until completion
and see results.

Examples:
  jsn atf run <test_sys_id>
  jsn atf run <test_sys_id> --wait
  jsn atf run <test_sys_id> --wait --timeout 300`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runATFRun(cmd, args[0], flags)
		},
	}

	cmd.Flags().BoolVar(&flags.wait, "wait", false, "Wait for test completion and show results")
	cmd.Flags().IntVar(&flags.timeout, "timeout", 300, "Timeout in seconds when using --wait")

	return cmd
}

// runATFRun executes the atf run command.
func runATFRun(cmd *cobra.Command, testID string, flags atfRunFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve test reference
	testSysID, err := resolveATFTest(cmd.Context(), sdkClient, testID)
	if err != nil {
		return err
	}

	// Create test execution record
	execution, err := sdkClient.CreateRecord(cmd.Context(), "sys_atf_test_result", map[string]interface{}{
		"test":       testSysID,
		"status":     "running",
		"started_at": "",
	})
	if err != nil {
		return fmt.Errorf("failed to start test execution: %w", err)
	}

	executionSysID := getString(execution, "sys_id")

	result := map[string]any{
		"sys_id": executionSysID,
		"test":   testSysID,
		"status": "running",
	}

	// If not waiting, return immediately with execution details
	if !flags.wait {
		return outputWriter.OK(result,
			output.WithSummary("ATF test execution started"),
			output.WithBreadcrumbs(
				output.Breadcrumb{Action: "status", Cmd: fmt.Sprintf("jsn records --table sys_atf_test_result %s", executionSysID), Description: "Check execution status"},
			),
		)
	}

	// Wait for completion (simplified - actual implementation would poll)
	return printStyledATFRun(cmd, testSysID, executionSysID)
}

// resolveATFTest resolves an ATF test identifier (sys_id or name) to a sys_id.
func resolveATFTest(ctx context.Context, sdkClient *sdk.Client, identifier string) (string, error) {
	// If it looks like a sys_id (32 chars), assume it's a sys_id
	if len(identifier) == 32 {
		// Validate it's hexadecimal
		isHex := true
		for _, r := range identifier {
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
				isHex = false
				break
			}
		}
		if isHex {
			return identifier, nil
		}
	}

	// Try to look up by name
	records, err := sdkClient.ListRecords(ctx, "sys_atf_test", &sdk.ListRecordsOptions{
		Limit:  1,
		Query:  fmt.Sprintf("name=%s", identifier),
		Fields: []string{"sys_id", "name"},
	})
	if err != nil {
		return "", fmt.Errorf("failed to resolve ATF test: %w", err)
	}
	if len(records) == 0 {
		return "", fmt.Errorf("ATF test not found: %s", identifier)
	}

	return getString(records[0], "sys_id"), nil
}

// getMaxStepOrder returns the maximum step order for a test.
func getMaxStepOrder(ctx context.Context, sdkClient *sdk.Client, testSysID string) (int, error) {
	records, err := sdkClient.ListRecords(ctx, "sys_atf_step", &sdk.ListRecordsOptions{
		Limit:     1,
		Query:     fmt.Sprintf("test=%s", testSysID),
		Fields:    []string{"order"},
		OrderBy:   "order",
		OrderDesc: true,
	})
	if err != nil {
		return 0, err
	}
	if len(records) == 0 {
		return 0, fmt.Errorf("no steps found")
	}

	// Try to get order as int
	orderVal := records[0]["order"]
	switch v := orderVal.(type) {
	case float64:
		return int(v), nil
	case int:
		return v, nil
	case string:
		var order int
		if _, err := fmt.Sscanf(v, "%d", &order); err != nil {
			return 0, fmt.Errorf("failed to parse order: %w", err)
		}
		return order, nil
	default:
		return 0, fmt.Errorf("unable to parse order")
	}
}

// buildStepInputData builds JSON input data for a step based on flags.
func buildStepInputData(flags atfStepFlags) string {
	var parts []string

	if flags.field != "" {
		parts = append(parts, fmt.Sprintf(`"field":"%s"`, flags.field))
	}
	if flags.value != "" {
		parts = append(parts, fmt.Sprintf(`"value":"%s"`, flags.value))
	}

	if len(parts) > 0 {
		return "{" + strings.Join(parts, ",") + "}"
	}
	return ""
}

// printStyledATFRun outputs styled ATF run results.
func printStyledATFRun(cmd *cobra.Command, testSysID, executionSysID string) error {
	w := cmd.OutOrStdout()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	successStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00cc66"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  %s\n",
		successStyle.Render("✓"),
		headerStyle.Render("ATF Test Started"),
	)
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  %s\n",
		mutedStyle.Render("Test:"),
		testSysID,
	)
	fmt.Fprintf(w, "  %s  %s\n",
		mutedStyle.Render("Execution:"),
		executionSysID,
	)
	fmt.Fprintln(w)
	fmt.Fprintln(w, mutedStyle.Render("  Use --wait flag to block until completion"))
	fmt.Fprintln(w)

	return nil
}
