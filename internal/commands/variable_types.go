package commands

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

// VariableType represents a catalog variable type.
type VariableType struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	HasChoices  bool   `json:"has_choices"`
}

// variableTypes returns the list of known variable types.
func variableTypes() []VariableType {
	return []VariableType{
		{ID: "1", Name: "Yes/No", Description: "Boolean true/false selection", HasChoices: false},
		{ID: "2", Name: "Multi Line Text", Description: "Large text area for multiple lines", HasChoices: false},
		{ID: "3", Name: "Multiple Choice", Description: "Checkboxes for multiple selections", HasChoices: true},
		{ID: "4", Name: "Numeric Scale", Description: "Numeric rating scale", HasChoices: false},
		{ID: "5", Name: "Select Box", Description: "Dropdown with single selection", HasChoices: true},
		{ID: "6", Name: "Single Line Text", Description: "Standard text input", HasChoices: false},
		{ID: "7", Name: "CheckBox", Description: "Single checkbox", HasChoices: false},
		{ID: "8", Name: "Reference", Description: "Reference to another table", HasChoices: false},
		{ID: "9", Name: "Date", Description: "Date picker", HasChoices: false},
		{ID: "10", Name: "Date/Time", Description: "Date and time picker", HasChoices: false},
		{ID: "11", Name: "Label", Description: "Display-only label text", HasChoices: false},
		{ID: "12", Name: "Break", Description: "Visual line break", HasChoices: false},
		{ID: "14", Name: "Macro", Description: "UI Macro execution", HasChoices: false},
		{ID: "15", Name: "UI Page", Description: "Embedded UI Page", HasChoices: false},
		{ID: "16", Name: "Wide Single Line Text", Description: "Full-width text input", HasChoices: false},
		{ID: "17", Name: "Macro with Label", Description: "UI Macro with label", HasChoices: false},
		{ID: "18", Name: "Lookup Select Box", Description: "Dropdown with lookup", HasChoices: true},
		{ID: "19", Name: "Container Start", Description: "Start of container section", HasChoices: false},
		{ID: "20", Name: "Container End", Description: "End of container section", HasChoices: false},
		{ID: "21", Name: "List Collector", Description: "Multi-select list", HasChoices: false},
		{ID: "22", Name: "Lookup Multiple Choice", Description: "Multiple choice with lookup", HasChoices: true},
		{ID: "23", Name: "HTML", Description: "HTML content display", HasChoices: false},
		{ID: "24", Name: "Container Split", Description: "Container column split", HasChoices: false},
		{ID: "25", Name: "Masked", Description: "Password/masked input", HasChoices: false},
		{ID: "26", Name: "Email", Description: "Email address input", HasChoices: false},
		{ID: "27", Name: "URL", Description: "URL input", HasChoices: false},
		{ID: "28", Name: "IP Address", Description: "IP address input", HasChoices: false},
		{ID: "29", Name: "Duration", Description: "Time duration input", HasChoices: false},
		{ID: "30", Name: "Attachment", Description: "File attachment upload", HasChoices: false},
	}
}

// NewVariableTypesCmd creates the variable-types command.
func NewVariableTypesCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "variable-types",
		Aliases: []string{"var-types", "vartypes"},
		Short:   "List catalog variable types",
		Long: `Display reference information about catalog variable types.

This is a quick reference for the type numbers used in the item_option_new table.
Types with choices (5=Select Box, 3=Multiple Choice, etc.) store their options
in the question_choice table.

Examples:
  jsn variable-types
  jsn variable-types --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVariableTypes(cmd)
		},
	}
}

// runVariableTypes executes the variable-types command.
func runVariableTypes(cmd *cobra.Command) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	types := variableTypes()

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledVariableTypes(cmd, types)
	}

	if format == output.FormatMarkdown {
		return printMarkdownVariableTypes(cmd, types)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "catalog-items",
			Cmd:         "jsn catalog-item",
			Description: "List catalog items",
		},
		{
			Action:      "variables",
			Cmd:         "jsn catalog-item variables <sys_id>",
			Description: "List variables on a catalog item",
		},
	}

	return outputWriter.OK(types,
		output.WithSummary(fmt.Sprintf("%d variable types", len(types))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledVariableTypes outputs styled variable types list.
func printStyledVariableTypes(cmd *cobra.Command, types []VariableType) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle
	choiceStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#22c55e")) // green

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Catalog Variable Types"))
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Types marked with * support question_choice entries"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-4s %-25s %s\n",
		mutedStyle.Render("ID"),
		headerStyle.Render("Name"),
		headerStyle.Render("Description"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	for _, t := range types {
		nameStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
		name := t.Name
		if t.HasChoices {
			nameStyle = choiceStyle
			name = t.Name + " *"
		}

		fmt.Fprintf(cmd.OutOrStdout(), "  %-4s %-25s %s\n",
			mutedStyle.Render(t.ID),
			nameStyle.Render(name),
			mutedStyle.Render(t.Description),
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable choices <var_name>",
		labelStyle.Render("List choices for a dropdown variable"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn variable add-choice <var_name> \"value\"",
		labelStyle.Render("Add choice to a dropdown variable"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownVariableTypes outputs markdown variable types list.
func printMarkdownVariableTypes(cmd *cobra.Command, types []VariableType) error {
	fmt.Fprintln(cmd.OutOrStdout(), "## Catalog Variable Types")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "| ID | Name | Description | Has Choices |")
	fmt.Fprintln(cmd.OutOrStdout(), "|----|------|-------------|-------------|")

	for _, t := range types {
		hasChoices := "No"
		if t.HasChoices {
			hasChoices = "Yes"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
			t.ID, t.Name, t.Description, hasChoices)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}
