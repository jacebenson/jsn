package commands

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// NewChoicesCommand creates the choices command group.
func NewChoicesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "choices",
		Short: "Manage choice values",
		Long: `List, create, update, and delete choice values from the sys_choice table.

This manages field-level dropdown choices (e.g., incident.state, task.priority).
For Service Catalog variable dropdown choices, use 'jsn variable choices' instead
(which manages the question_choice table).`,
	}

	cmd.AddCommand(
		newChoicesListCmd(),
		newChoicesCreateCmd(),
		newChoicesUpdateCmd(),
		newChoicesDeleteCmd(),
		newChoicesReorderCmd(),
	)

	return cmd
}

// newChoicesListCmd creates the choices list command.
func newChoicesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <table> <column>",
		Short: "List choice values",
		Long: `Display choice values for a specific column, ordered by sequence.
Active choices are highlighted, inactive are muted.

Arguments:
  <table>   The table name (e.g., incident, task, change_request)
  <column>  The column/field name (e.g., state, priority, category)

Examples:
  jsn choices list incident state
  jsn choices list task priority
  jsn choices list change_request type`,
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) < 1 {
				return fmt.Errorf("missing required arguments: <table> and <column>\n\nUsage: jsn choices list <table> <column>\n\nExample: jsn choices list incident state")
			}
			if len(args) < 2 {
				return fmt.Errorf("missing required argument: <column>\n\nUsage: jsn choices list %s <column>\n\nExample: jsn choices list %s state", args[0], args[0])
			}
			if len(args) > 2 {
				return fmt.Errorf("too many arguments\n\nUsage: jsn choices list <table> <column>")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChoicesList(cmd, args[0], args[1])
		},
	}
}

// runChoicesList executes the choices list command.
func runChoicesList(cmd *cobra.Command, tableName, columnName string) error {
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

	// Get all choices (including inactive)
	choices, err := sdkClient.GetAllColumnChoices(cmd.Context(), tableName, columnName)
	if err != nil {
		return fmt.Errorf("failed to get choices: %w", err)
	}

	if len(choices) == 0 {
		return outputWriter.OK([]map[string]string{},
			output.WithSummary(fmt.Sprintf("No choices found for %s.%s", tableName, columnName)),
		)
	}

	// Sort by sequence ascending
	sort.Slice(choices, func(i, j int) bool {
		return choices[i].Sequence < choices[j].Sequence
	})

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledChoicesList(cmd, tableName, columnName, choices, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownChoicesList(cmd, tableName, columnName, choices, instanceURL)
	}

	// Build result for JSON/quiet
	var data []map[string]interface{}
	for _, choice := range choices {
		item := map[string]interface{}{
			"sys_id":   choice.SysID,
			"value":    choice.Value,
			"label":    choice.Label,
			"sequence": choice.Sequence,
			"inactive": choice.Inactive,
		}
		if choice.Dependent != "" {
			item["dependent"] = choice.Dependent
		}
		data = append(data, item)
	}

	activeCount := 0
	for _, c := range choices {
		if !c.Inactive {
			activeCount++
		}
	}

	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "create",
			Cmd:         fmt.Sprintf("jsn choices create %s %s", tableName, columnName),
			Description: "Add new choice",
		},
		{
			Action:      "reorder",
			Cmd:         fmt.Sprintf("jsn choices reorder %s %s --mode hundreds", tableName, columnName),
			Description: "Reorder by hundreds",
		},
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d choices (%d active) for %s.%s", len(choices), activeCount, tableName, columnName)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledChoicesList outputs styled choice values.
func printStyledChoicesList(cmd *cobra.Command, tableName, columnName string, choices []sdk.ChoiceValue, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#666666"))
	valueStyle := lipgloss.NewStyle()
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	title := fmt.Sprintf("%s.%s Choices", tableName, columnName)
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(title))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s\n",
		headerStyle.Render("Sys ID"),
		headerStyle.Render("Value"),
		headerStyle.Render("Label"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Choices list
	for _, choice := range choices {
		// Build display based on active status
		var labelDisplay string
		if choice.Inactive {
			labelDisplay = inactiveStyle.Render(choice.Label)
		} else {
			// Active choice - make label a link
			if instanceURL != "" {
				choiceLink := fmt.Sprintf("%s/now/nav/ui/classic/params/target/sys_choice.do?sys_id=%s", instanceURL, choice.SysID)
				labelDisplay = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", choiceLink, choice.Label)
			} else {
				labelDisplay = choice.Label
			}
			labelDisplay = lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render(labelDisplay)
		}

		valueDisplay := choice.Value
		if choice.Inactive {
			valueDisplay = inactiveStyle.Render(valueDisplay)
		} else {
			valueDisplay = valueStyle.Render(valueDisplay)
		}

		// Build dependent info
		var extraInfo string
		if choice.Dependent != "" {
			extraInfo = fmt.Sprintf("[depends: %s]", choice.Dependent)
		}
		if choice.Inactive {
			extraInfo = "[inactive]"
		}

		if extraInfo != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s  %s\n",
				mutedStyle.Render(choice.SysID),
				valueDisplay,
				labelDisplay,
				labelStyle.Render(extraInfo),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-32s %-20s %s\n",
				mutedStyle.Render(choice.SysID),
				valueDisplay,
				labelDisplay,
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints section
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn choices create %s %s", tableName, columnName),
		labelStyle.Render("Add new choice"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn choices reorder %s %s --mode hundreds", tableName, columnName),
		labelStyle.Render("Reorder by hundreds"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn tables schema %s", tableName),
		labelStyle.Render("View table schema"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownChoicesList outputs markdown choice values.
func printMarkdownChoicesList(cmd *cobra.Command, tableName, columnName string, choices []sdk.ChoiceValue, instanceURL string) error {
	title := fmt.Sprintf("**%s.%s Choices**", tableName, columnName)
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n\n", title)

	fmt.Fprintln(cmd.OutOrStdout(), "| Sys ID | Sequence | Value | Label | Status | Dependent |")
	fmt.Fprintln(cmd.OutOrStdout(), "|--------|----------|-------|-------|--------|----------|")

	for _, choice := range choices {
		status := "Active"
		if choice.Inactive {
			status = "Inactive"
		}
		dep := choice.Dependent
		if dep == "" {
			dep = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %d | %s | %s | %s | %s |\n",
			choice.SysID, choice.Sequence, choice.Value, choice.Label, status, dep)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "#### Hints")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn choices create %s %s` — Add new choice\n", tableName, columnName)
	fmt.Fprintf(cmd.OutOrStdout(), "- `jsn choices reorder %s %s --mode hundreds` — Reorder by hundreds\n", tableName, columnName)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newChoicesCreateCmd creates the choices create command.
func newChoicesCreateCmd() *cobra.Command {
	var flags struct {
		value     string
		label     string
		sequence  int
		dependent string
	}

	cmd := &cobra.Command{
		Use:   "create <table> <column>",
		Short: "Create a new choice value",
		Long: `Create a new choice value for a column. If sequence is not provided, an interactive picker will help you position the choice.

Examples:
  jsn choices create incident priority --value 5 --label "Critical" --sequence 100
  jsn choices create incident priority --value 5 --label "Critical"  # Interactive placement`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChoicesCreate(cmd, args[0], args[1], flags)
		},
	}

	cmd.Flags().StringVar(&flags.value, "value", "", "Choice value (required)")
	cmd.Flags().StringVar(&flags.label, "label", "", "Choice label (required)")
	cmd.Flags().IntVar(&flags.sequence, "sequence", 0, "Sequence number (optional, interactive if not provided)")
	cmd.Flags().StringVar(&flags.dependent, "dependent", "", "Dependent value for cascading choices")

	if err := cmd.MarkFlagRequired("value"); err != nil {
		panic(err)
	}
	if err := cmd.MarkFlagRequired("label"); err != nil {
		panic(err)
	}

	return cmd
}

// runChoicesCreate executes the choices create command.
func runChoicesCreate(cmd *cobra.Command, tableName, columnName string, flags struct {
	value     string
	label     string
	sequence  int
	dependent string
}) error {
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

	sequence := flags.sequence

	// If no sequence provided and interactive, show picker
	if sequence == 0 && isTerminal && !cmd.Flags().Changed("sequence") {
		// Get existing choices to show where to insert
		existingChoices, err := sdkClient.GetAllColumnChoices(cmd.Context(), tableName, columnName)
		if err == nil && len(existingChoices) > 0 {
			// Sort by sequence
			sort.Slice(existingChoices, func(i, j int) bool {
				return existingChoices[i].Sequence < existingChoices[j].Sequence
			})

			// Build picker items
			var items []tui.PickerItem
			items = append(items, tui.PickerItem{
				ID:          "first",
				Title:       "[At the beginning]",
				Description: fmt.Sprintf("Sequence will be: %d", existingChoices[0].Sequence-100),
			})

			for i, choice := range existingChoices {
				desc := fmt.Sprintf("Sequence: %d", choice.Sequence)
				if choice.Inactive {
					desc = desc + " [inactive]"
				}
				items = append(items, tui.PickerItem{
					ID:          strconv.Itoa(i),
					Title:       fmt.Sprintf("After: %s (%s)", choice.Label, choice.Value),
					Description: desc,
				})
			}

			selected, err := tui.Pick("Insert new choice:", items)
			if err != nil {
				return err
			}
			if selected == nil {
				return fmt.Errorf("selection cancelled")
			}

			if selected.ID == "first" {
				// Insert at beginning
				sequence = existingChoices[0].Sequence - 100
				if sequence < 0 {
					sequence = 0
				}
			} else {
				// Insert after selected choice
				idx, _ := strconv.Atoi(selected.ID)
				if idx < len(existingChoices)-1 {
					// Between two choices
					sequence = (existingChoices[idx].Sequence + existingChoices[idx+1].Sequence) / 2
				} else {
					// After last choice
					sequence = existingChoices[idx].Sequence + 100
				}
			}
		} else {
			// No existing choices, start at 100
			sequence = 100
		}
	} else if sequence == 0 {
		// Non-interactive, default to 100
		sequence = 100
	}

	// Create the choice
	choice, err := sdkClient.CreateChoice(cmd.Context(), tableName, columnName, flags.value, flags.label, sequence, flags.dependent)
	if err != nil {
		return fmt.Errorf("failed to create choice: %w", err)
	}

	return outputWriter.OK(map[string]interface{}{
		"sys_id":   choice.SysID,
		"table":    tableName,
		"column":   columnName,
		"value":    choice.Value,
		"label":    choice.Label,
		"sequence": choice.Sequence,
	},
		output.WithSummary(fmt.Sprintf("Created choice '%s' (%s) at sequence %d", choice.Label, choice.Value, choice.Sequence)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn choices list %s %s", tableName, columnName),
				Description: "View all choices",
			},
		),
	)
}

// newChoicesUpdateCmd creates the choices update command.
func newChoicesUpdateCmd() *cobra.Command {
	var flags struct {
		label    string
		sequence int
		inactive bool
		active   bool
	}

	cmd := &cobra.Command{
		Use:   "update <sys_id>",
		Short: "Update a choice value",
		Long:  "Update label, sequence, or active status of a choice by sys_id.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChoicesUpdate(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVar(&flags.label, "label", "", "New label")
	cmd.Flags().IntVar(&flags.sequence, "sequence", 0, "New sequence")
	cmd.Flags().BoolVar(&flags.inactive, "inactive", false, "Mark as inactive")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Mark as active")

	return cmd
}

// runChoicesUpdate executes the choices update command.
func runChoicesUpdate(cmd *cobra.Command, sysID string, flags struct {
	label    string
	sequence int
	inactive bool
	active   bool
}) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Build updates map
	updates := make(map[string]interface{})
	if cmd.Flags().Changed("label") {
		updates["label"] = flags.label
	}
	if cmd.Flags().Changed("sequence") {
		updates["sequence"] = flags.sequence
	}
	if flags.inactive {
		updates["inactive"] = true
	}
	if flags.active {
		updates["inactive"] = false
	}

	if len(updates) == 0 {
		return output.ErrUsage("No updates specified. Use --label, --sequence, --inactive, or --active")
	}

	// Update the choice
	choice, err := sdkClient.UpdateChoice(cmd.Context(), sysID, updates)
	if err != nil {
		return fmt.Errorf("failed to update choice: %w", err)
	}

	return outputWriter.OK(map[string]interface{}{
		"sys_id":   choice.SysID,
		"value":    choice.Value,
		"label":    choice.Label,
		"sequence": choice.Sequence,
		"inactive": choice.Inactive,
	},
		output.WithSummary(fmt.Sprintf("Updated choice '%s' (%s)", choice.Label, choice.Value)),
	)
}

// newChoicesDeleteCmd creates the choices delete command.
func newChoicesDeleteCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "delete <sys_id>",
		Short: "Delete a choice value",
		Long:  "Permanently delete a choice value by sys_id.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChoicesDelete(cmd, args[0], force)
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")

	return cmd
}

// runChoicesDelete executes the choices delete command.
func runChoicesDelete(cmd *cobra.Command, sysID string, force bool) error {
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

	// Get choice details first for confirmation
	choice, err := sdkClient.GetChoice(cmd.Context(), sysID)
	if err != nil {
		return fmt.Errorf("failed to find choice: %w", err)
	}

	// Confirm deletion unless --force
	if !force && isTerminal {
		fmt.Fprintf(cmd.OutOrStdout(), "Delete choice '%s' (%s) from %s.%s? [y/N]: ",
			choice.Label, choice.Value, choice.Table, choice.Element)
		var response string
		_, _ = fmt.Scanln(&response) // Ignore error - user can just press enter
		if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
			return fmt.Errorf("deletion cancelled")
		}
	}

	// Delete the choice
	if err := sdkClient.DeleteChoice(cmd.Context(), sysID); err != nil {
		return fmt.Errorf("failed to delete choice: %w", err)
	}

	return outputWriter.OK(map[string]string{
		"sys_id": sysID,
		"status": "deleted",
	},
		output.WithSummary(fmt.Sprintf("Deleted choice '%s' (%s)", choice.Label, choice.Value)),
	)
}

// newChoicesReorderCmd creates the choices reorder command.
func newChoicesReorderCmd() *cobra.Command {
	var mode string

	cmd := &cobra.Command{
		Use:   "reorder <table> <column>",
		Short: "Reorder choice values",
		Long: `Reorder all choice values for a column. Mode options:
  hundreds - Normalize sequences to 100, 200, 300, etc.
  alpha    - Sort by label alphabetically and assign sequences 100, 200, 300, etc.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runChoicesReorder(cmd, args[0], args[1], mode)
		},
	}

	cmd.Flags().StringVar(&mode, "mode", "hundreds", "Reorder mode: hundreds or alpha")
	_ = cmd.RegisterFlagCompletionFunc("mode", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		return []string{"hundreds", "alpha"}, cobra.ShellCompDirectiveDefault
	})

	return cmd
}

// runChoicesReorder executes the choices reorder command.
func runChoicesReorder(cmd *cobra.Command, tableName, columnName, mode string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Get all choices
	choices, err := sdkClient.GetAllColumnChoices(cmd.Context(), tableName, columnName)
	if err != nil {
		return fmt.Errorf("failed to get choices: %w", err)
	}

	if len(choices) == 0 {
		return outputWriter.OK([]map[string]string{},
			output.WithSummary(fmt.Sprintf("No choices to reorder for %s.%s", tableName, columnName)),
		)
	}

	// Sort based on mode
	switch mode {
	case "alpha":
		// Sort by label alphabetically
		sort.Slice(choices, func(i, j int) bool {
			return strings.ToLower(choices[i].Label) < strings.ToLower(choices[j].Label)
		})
	case "hundreds", "":
		// Sort by current sequence
		sort.Slice(choices, func(i, j int) bool {
			return choices[i].Sequence < choices[j].Sequence
		})
	default:
		return output.ErrUsage(fmt.Sprintf("Invalid mode: %s. Use 'hundreds' or 'alpha'", mode))
	}

	// Reassign sequences in hundreds
	updates := make(map[string]int)
	for i, choice := range choices {
		newSeq := (i + 1) * 100
		if choice.Sequence != newSeq {
			updates[choice.SysID] = newSeq
		}
	}

	// Apply updates
	updatedCount := 0
	for sysID, newSeq := range updates {
		_, err := sdkClient.UpdateChoice(cmd.Context(), sysID, map[string]interface{}{
			"sequence": newSeq,
		})
		if err != nil {
			return fmt.Errorf("failed to update choice %s: %w", sysID, err)
		}
		updatedCount++
	}

	return outputWriter.OK(map[string]interface{}{
		"table":         tableName,
		"column":        columnName,
		"mode":          mode,
		"total_choices": len(choices),
		"updated":       updatedCount,
	},
		output.WithSummary(fmt.Sprintf("Reordered %d choices for %s.%s", updatedCount, tableName, columnName)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         fmt.Sprintf("jsn choices list %s %s", tableName, columnName),
				Description: "View reordered choices",
			},
		),
	)
}
