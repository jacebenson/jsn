package commands

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// evalFlags holds the flags for the eval command.
type evalFlags struct {
	scope             string
	file              string
	noRollback        bool
	noQuotaManagement bool
}

// NewEvalCmd creates the eval command.
func NewEvalCmd() *cobra.Command {
	var flags evalFlags

	cmd := &cobra.Command{
		Use:   "eval [<script>]",
		Short: "Run a background script on the instance",
		Long: `Execute arbitrary server-side JavaScript on the ServiceNow instance.

This is the equivalent of "Scripts - Background" in the ServiceNow UI.
The script runs in the specified scope with full access to the server-side API
(GlideRecord, gs, GlideAjax, etc.).

Use gs.print() or gs.info() in your script to produce output.

Script Input:
  Pass the script as an argument:    jsn eval "gs.print(gs.getProperty('instance_name'))"
  Read from a file with --file:      jsn eval --file /tmp/my_script.js
  Read from stdin (pipe):            echo "gs.print('hello')" | jsn eval

Examples:
  jsn eval "gs.print(gs.getProperty('instance_name'))"
  jsn eval "var gr = new GlideRecord('incident'); gr.setLimit(1); gr.query(); gr.next(); gs.print(gr.number);"
  jsn eval --file /tmp/check_records.js
  jsn eval --scope x_myapp_scope "gs.print(gs.getCurrentScopeName())"
  cat script.js | jsn eval
  jsn eval "gs.print(JSON.stringify({time: gs.nowDateTime(), user: gs.getUserName()}))" --json`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var script string
			if len(args) > 0 {
				script = args[0]
			}
			return runEval(cmd, script, flags)
		},
	}

	cmd.Flags().StringVar(&flags.scope, "scope", "global", "Application scope to run in")
	cmd.Flags().StringVar(&flags.file, "file", "", "Read script from file")
	cmd.Flags().BoolVar(&flags.noRollback, "no-rollback", false, "Disable rollback recording")
	cmd.Flags().BoolVar(&flags.noQuotaManagement, "no-quota", false, "Disable 4-hour timeout")

	return cmd
}

// runEval executes the eval command.
func runEval(cmd *cobra.Command, script string, flags evalFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Resolve script from argument, --file, or stdin
	var err error
	script, err = resolveScript(cmd, script, flags.file)
	if err != nil {
		return err
	}

	if strings.TrimSpace(script) == "" {
		return output.ErrUsage("No script provided. Pass as argument, use --file, or pipe via stdin.")
	}

	// Build options
	opts := sdk.DefaultEvalOptions()
	opts.Scope = flags.scope
	opts.RecordForRollback = !flags.noRollback
	opts.QuotaManaged = !flags.noQuotaManagement

	// Execute
	result, err := sdkClient.Eval(cmd.Context(), script, opts)
	if err != nil {
		return fmt.Errorf("script execution failed: %w", err)
	}

	// Check for script errors
	if result.Error != "" {
		return outputEvalError(cmd, outputWriter, result)
	}

	// Output the result
	return outputEvalResult(cmd, outputWriter, result)
}

// resolveScript determines the script to run from args, --file, or stdin.
func resolveScript(cmd *cobra.Command, argScript, filePath string) (string, error) {
	// Priority: --file > argument > stdin
	if filePath != "" {
		content, err := os.ReadFile(filePath)
		if err != nil {
			return "", output.ErrUsage(fmt.Sprintf("Failed to read script file: %v", err))
		}
		return string(content), nil
	}

	if argScript != "" {
		return argScript, nil
	}

	// Check if stdin has data (piped input)
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		content, err := os.ReadFile("/dev/stdin")
		if err != nil {
			return "", fmt.Errorf("reading stdin: %w", err)
		}
		return string(content), nil
	}

	return "", nil
}

// outputEvalResult renders a successful eval result.
func outputEvalResult(cmd *cobra.Command, outputWriter *output.Writer, result *sdk.EvalResult) error {
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	switch {
	case format == output.FormatStyled || (format == output.FormatAuto && isTerminal):
		return printStyledEval(cmd, result)
	case format == output.FormatMarkdown:
		return printMarkdownEval(cmd, result)
	default:
		// JSON output
		data := map[string]interface{}{
			"output":   result.Output,
			"scope":    result.Scope,
			"duration": result.Duration,
		}
		if result.HistoryURL != "" {
			data["history_url"] = result.HistoryURL
		}
		return outputWriter.OK(data,
			output.WithSummary(fmt.Sprintf("Script executed in %s", result.Duration)),
		)
	}
}

// outputEvalError renders a script error.
func outputEvalError(cmd *cobra.Command, outputWriter *output.Writer, result *sdk.EvalResult) error {
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	switch {
	case format == output.FormatStyled || (format == output.FormatAuto && isTerminal):
		return printStyledEvalError(cmd, result)
	case format == output.FormatMarkdown:
		return printMarkdownEvalError(cmd, result)
	default:
		return outputWriter.Err("SCRIPT_ERROR", fmt.Errorf("%s", result.Error), "Check your script syntax and try again")
	}
}

// ─── Styled Output ──────────────────────────────────────────────────────────

func printStyledEval(cmd *cobra.Command, result *sdk.EvalResult) error {
	w := cmd.OutOrStdout()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	successStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00cc66"))

	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  %s\n",
		successStyle.Render("✓"),
		headerStyle.Render("Script executed successfully"),
	)

	if result.Duration != "" {
		fmt.Fprintf(w, "  %s %s   %s %s\n",
			mutedStyle.Render("Duration:"),
			result.Duration,
			mutedStyle.Render("Scope:"),
			result.Scope,
		)
	}

	if result.Output != "" {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "  "+headerStyle.Render("Output"))
		fmt.Fprintln(w)
		for _, line := range strings.Split(result.Output, "\n") {
			fmt.Fprintf(w, "  %s\n", line)
		}
	} else {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "  %s\n", mutedStyle.Render("(no output — use gs.print() to produce output)"))
	}

	fmt.Fprintln(w)
	return nil
}

func printStyledEvalError(cmd *cobra.Command, result *sdk.EvalResult) error {
	w := cmd.OutOrStdout()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	errorStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ff4444"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s  %s\n",
		errorStyle.Render("✗"),
		headerStyle.Render("Script execution failed"),
	)

	if result.Duration != "" {
		fmt.Fprintf(w, "  %s %s   %s %s\n",
			mutedStyle.Render("Duration:"),
			result.Duration,
			mutedStyle.Render("Scope:"),
			result.Scope,
		)
	}

	fmt.Fprintln(w)
	fmt.Fprintln(w, "  "+errorStyle.Render("Error"))
	fmt.Fprintln(w)
	for _, line := range strings.Split(result.Error, "\n") {
		fmt.Fprintf(w, "  %s\n", line)
	}

	fmt.Fprintln(w)
	return nil
}

// ─── Markdown Output ────────────────────────────────────────────────────────

func printMarkdownEval(cmd *cobra.Command, result *sdk.EvalResult) error {
	w := cmd.OutOrStdout()

	fmt.Fprintln(w, "# Script Output")
	fmt.Fprintln(w)
	if result.Duration != "" {
		fmt.Fprintf(w, "- **Duration:** %s\n", result.Duration)
	}
	fmt.Fprintf(w, "- **Scope:** %s\n", result.Scope)
	fmt.Fprintln(w)

	if result.Output != "" {
		fmt.Fprintln(w, "```")
		fmt.Fprintln(w, result.Output)
		fmt.Fprintln(w, "```")
	} else {
		fmt.Fprintln(w, "_No output (use gs.print() to produce output)_")
	}

	return nil
}

func printMarkdownEvalError(cmd *cobra.Command, result *sdk.EvalResult) error {
	w := cmd.OutOrStdout()

	fmt.Fprintln(w, "# Script Error")
	fmt.Fprintln(w)
	if result.Duration != "" {
		fmt.Fprintf(w, "- **Duration:** %s\n", result.Duration)
	}
	fmt.Fprintf(w, "- **Scope:** %s\n", result.Scope)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "```")
	fmt.Fprintln(w, result.Error)
	fmt.Fprintln(w, "```")

	return nil
}
