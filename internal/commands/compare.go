package commands

import (
	"fmt"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

// compareFlags holds the flags for compare commands.
type compareFlags struct {
	source string
	target string
	table  string
	field  string
	scope  string
}

// NewCompareCmd creates the compare command group.
func NewCompareCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "compare",
		Short: "Compare resources across instances",
		Long:  "Compare tables, scripts, choices, and flows between ServiceNow instances.",
	}

	cmd.AddCommand(
		newCompareTablesCmd(),
		newCompareScriptIncludesCmd(),
		newCompareChoicesCmd(),
		newCompareFlowsCmd(),
	)

	return cmd
}

// newCompareTablesCmd creates the compare tables command.
func newCompareTablesCmd() *cobra.Command {
	var flags compareFlags

	cmd := &cobra.Command{
		Use:   "tables",
		Short: "Compare table schemas between instances",
		Long: `Compare table definitions between two ServiceNow instances.

Examples:
  jsn compare tables --source dev --target prod
  jsn compare tables --source dev --target prod --scope myapp`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompareTables(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.source, "source", "", "Source profile (required)")
	cmd.Flags().StringVar(&flags.target, "target", "", "Target profile (required)")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Filter by scope/application")
	_ = cmd.MarkFlagRequired("source")
	_ = cmd.MarkFlagRequired("target")

	return cmd
}

// runCompareTables executes the compare tables command.
func runCompareTables(cmd *cobra.Command, flags compareFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	outputWriter := appCtx.Output.(*output.Writer)

	// This is a placeholder implementation
	// In a full implementation, this would:
	// 1. Create SDK clients for both source and target
	// 2. Fetch table schemas from both
	// 3. Compare and show differences

	result := map[string]any{
		"source":                  flags.source,
		"target":                  flags.target,
		"scope":                   flags.scope,
		"tables_only_in_source":   []string{},
		"tables_only_in_target":   []string{},
		"tables_with_differences": []string{},
	}

	return outputWriter.OK(result,
		output.WithSummary("Table comparison (placeholder - full implementation coming soon)"),
	)
}

// newCompareScriptIncludesCmd creates the compare script-includes command.
func newCompareScriptIncludesCmd() *cobra.Command {
	var flags compareFlags

	cmd := &cobra.Command{
		Use:   "script-includes",
		Short: "Compare script includes between instances",
		Long: `Compare script includes between two ServiceNow instances.

Examples:
  jsn compare script-includes --source dev --target prod
  jsn compare script-includes --source dev --target prod --scope myapp`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompareScriptIncludes(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.source, "source", "", "Source profile (required)")
	cmd.Flags().StringVar(&flags.target, "target", "", "Target profile (required)")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Filter by scope")
	_ = cmd.MarkFlagRequired("source")
	_ = cmd.MarkFlagRequired("target")

	return cmd
}

// runCompareScriptIncludes executes the compare script-includes command.
func runCompareScriptIncludes(cmd *cobra.Command, flags compareFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	outputWriter := appCtx.Output.(*output.Writer)

	// Placeholder implementation
	result := map[string]any{
		"source": flags.source,
		"target": flags.target,
		"scope":  flags.scope,
	}

	return outputWriter.OK(result,
		output.WithSummary("Script includes comparison (placeholder - full implementation coming soon)"),
	)
}

// newCompareChoicesCmd creates the compare choices command.
func newCompareChoicesCmd() *cobra.Command {
	var flags compareFlags

	cmd := &cobra.Command{
		Use:   "choices",
		Short: "Compare choice values between instances",
		Long: `Compare choice values for a specific table and field between two instances.

Examples:
  jsn compare choices --table incident --field state --source dev --target prod
  jsn compare choices --table task --field priority --source dev --target prod`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompareChoices(cmd, flags)
		},
	}

	cmd.Flags().StringVarP(&flags.table, "table", "t", "", "Table name (required)")
	cmd.Flags().StringVarP(&flags.field, "field", "f", "", "Field name (required)")
	cmd.Flags().StringVar(&flags.source, "source", "", "Source profile (required)")
	cmd.Flags().StringVar(&flags.target, "target", "", "Target profile (required)")
	_ = cmd.MarkFlagRequired("table")
	_ = cmd.MarkFlagRequired("field")
	_ = cmd.MarkFlagRequired("source")
	_ = cmd.MarkFlagRequired("target")

	return cmd
}

// runCompareChoices executes the compare choices command.
func runCompareChoices(cmd *cobra.Command, flags compareFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	outputWriter := appCtx.Output.(*output.Writer)

	// Placeholder implementation
	result := map[string]any{
		"table":  flags.table,
		"field":  flags.field,
		"source": flags.source,
		"target": flags.target,
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Choices comparison for %s.%s (placeholder)", flags.table, flags.field)),
	)
}

// newCompareFlowsCmd creates the compare flows command.
func newCompareFlowsCmd() *cobra.Command {
	var flags compareFlags

	cmd := &cobra.Command{
		Use:   "flows",
		Short: "Compare flows between instances",
		Long: `Compare Flow Designer flows between two ServiceNow instances.

Examples:
  jsn compare flows --source dev --target prod
  jsn compare flows --source dev --target prod --scope myapp`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompareFlows(cmd, flags)
		},
	}

	cmd.Flags().StringVar(&flags.source, "source", "", "Source profile (required)")
	cmd.Flags().StringVar(&flags.target, "target", "", "Target profile (required)")
	cmd.Flags().StringVar(&flags.scope, "scope", "", "Filter by scope")
	_ = cmd.MarkFlagRequired("source")
	_ = cmd.MarkFlagRequired("target")

	return cmd
}

// runCompareFlows executes the compare flows command.
func runCompareFlows(cmd *cobra.Command, flags compareFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	outputWriter := appCtx.Output.(*output.Writer)

	// Placeholder implementation
	result := map[string]any{
		"source": flags.source,
		"target": flags.target,
		"scope":  flags.scope,
	}

	return outputWriter.OK(result,
		output.WithSummary("Flows comparison (placeholder - full implementation coming soon)"),
	)
}
