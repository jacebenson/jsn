package commands

import (
	"context"
	"fmt"
	"net/url"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// NewVariableCmd creates the variable command group.
func NewVariableCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "variable",
		Aliases: []string{"var"},
		Short:   "Manage catalog item variables",
		Long:    "Manage variables (questions) on Service Catalog items, including dropdown choices.",
	}

	cmd.AddCommand(
		newVariableShowCmd(),
		newVariableChoicesCmd(),
		newVariableAddChoiceCmd(),
		newVariableRemoveChoiceCmd(),
	)

	return cmd
}

// newVariableShowCmd creates the variable show command.
func newVariableShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <sys_id_or_name>",
		Short: "Show variable details",
		Long: `Display detailed information about a catalog variable.

Examples:
  jsn variable show 1234567890abcdef1234567890abcdef
  jsn variable show phone_model`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVariableShow(cmd, args[0])
		},
	}
}

// runVariableShow executes the variable show command.
func runVariableShow(cmd *cobra.Command, identifier string) error {
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

	// Find the variable
	variable, err := findVariable(cmd.Context(), sdkClient, identifier)
	if err != nil {
		return err
	}

	sysID := getStringField(variable, "sys_id")

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledVariable(cmd, variable, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownVariable(cmd, variable, instanceURL)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "choices",
			Cmd:         fmt.Sprintf("jsn variable choices %s", sysID),
			Description: "List choices for this variable",
		},
		{
			Action:      "add-choice",
			Cmd:         fmt.Sprintf("jsn variable add-choice %s \"value\"", sysID),
			Description: "Add a choice to this variable",
		},
	}

	return outputWriter.OK(variable,
		output.WithSummary(fmt.Sprintf("Variable: %s", getStringField(variable, "name"))),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledVariable outputs styled variable details.
func printStyledVariable(cmd *cobra.Command, variable map[string]interface{}, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	sectionStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#666666"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())

	// Title
	name := getStringField(variable, "name")
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Core fields
	coreFields := []string{"sys_id", "name", "question_text", "type", "mandatory", "order", "active", "cat_item"}
	fmt.Fprintln(cmd.OutOrStdout(), sectionStyle.Render("- Core -"))
	for _, field := range coreFields {
		if val, exists := variable[field]; exists {
			valStr := formatValue(val)
			if valStr != "" {
				// For type, show human-readable name
				if field == "type" {
					valStr = fmt.Sprintf("%s (%s)", variableTypeName(valStr), valStr)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "  %-25s  %s\n",
					labelStyle.Render(field+":"),
					valueStyle.Render(valStr),
				)
			}
		}
	}

	// Link
	sysID := getStringField(variable, "sys_id")
	if instanceURL != "" {
		link := fmt.Sprintf("%s/item_option_new.do?sys_id=%s", instanceURL, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			labelStyle.Render("Link:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn variable choices %s", sysID),
		labelStyle.Render("List choices for this variable"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn variable add-choice %s \"value\"", sysID),
		labelStyle.Render("Add a choice to this variable"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownVariable outputs markdown variable details.
func printMarkdownVariable(cmd *cobra.Command, variable map[string]interface{}, instanceURL string) error {
	name := getStringField(variable, "name")
	fmt.Fprintf(cmd.OutOrStdout(), "## %s\n\n", name)

	for key, val := range variable {
		valStr := formatValue(val)
		if valStr != "" {
			if key == "type" {
				valStr = fmt.Sprintf("%s (%s)", variableTypeName(valStr), valStr)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "- **%s:** %s\n", key, valStr)
		}
	}

	sysID := getStringField(variable, "sys_id")
	if instanceURL != "" {
		link := fmt.Sprintf("%s/item_option_new.do?sys_id=%s", instanceURL, sysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newVariableChoicesCmd creates the variable choices command.
func newVariableChoicesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "choices <variable_sys_id_or_name>",
		Short: "List choices for a dropdown variable",
		Long: `List all choices in the question_choice table for a Select Box variable.

Examples:
  jsn variable choices 1234567890abcdef1234567890abcdef
  jsn variable choices phone_model`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVariableChoices(cmd, args[0])
		},
	}
}

// runVariableChoices executes the variable choices command.
func runVariableChoices(cmd *cobra.Command, identifier string) error {
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

	// Find the variable first
	variable, err := findVariable(cmd.Context(), sdkClient, identifier)
	if err != nil {
		return err
	}

	varSysID := getStringField(variable, "sys_id")
	varName := getStringField(variable, "name")

	// Query question_choice table
	query := url.Values{}
	query.Set("sysparm_limit", "200")
	query.Set("sysparm_query", fmt.Sprintf("question=%s^ORDERBYorder", varSysID))
	query.Set("sysparm_fields", "sys_id,text,value,order,inactive")
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(cmd.Context(), "question_choice", query)
	if err != nil {
		return fmt.Errorf("failed to get variable choices: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledVariableChoices(cmd, resp.Result, varName, varSysID, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownVariableChoices(cmd, resp.Result, varName)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "add-choice",
			Cmd:         fmt.Sprintf("jsn variable add-choice %s \"value\"", varSysID),
			Description: "Add a choice",
		},
		{
			Action:      "remove-choice",
			Cmd:         fmt.Sprintf("jsn variable remove-choice %s \"value\"", varSysID),
			Description: "Remove a choice",
		},
		{
			Action:      "show",
			Cmd:         fmt.Sprintf("jsn variable show %s", varSysID),
			Description: "Show variable details",
		},
	}

	return outputWriter.OK(resp.Result,
		output.WithSummary(fmt.Sprintf("%d choices for variable '%s'", len(resp.Result), varName)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// printStyledVariableChoices outputs styled variable choices list.
func printStyledVariableChoices(cmd *cobra.Command, choices []map[string]interface{}, varName, varSysID, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	labelStyle := mutedStyle

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(fmt.Sprintf("Choices for '%s'", varName)))
	fmt.Fprintln(cmd.OutOrStdout())

	if len(choices) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No choices found"))
	} else {
		// Column headers
		fmt.Fprintf(cmd.OutOrStdout(), "  %-5s %-30s %-30s %s\n",
			mutedStyle.Render("Order"),
			headerStyle.Render("Text"),
			headerStyle.Render("Value"),
			headerStyle.Render("Active"),
		)
		fmt.Fprintln(cmd.OutOrStdout())

		for _, choice := range choices {
			order := getStringField(choice, "order")
			text := getStringField(choice, "text")
			value := getStringField(choice, "value")
			inactive := getStringField(choice, "inactive")

			// Truncate if too long
			if len(text) > 28 {
				text = text[:25] + "..."
			}
			if len(value) > 28 {
				value = value[:25] + "..."
			}

			active := "true"
			if inactive == "true" {
				active = "false"
			}

			// Style based on active status
			textStyle := lipgloss.NewStyle().Foreground(output.BrandColor)
			if inactive == "true" {
				textStyle = mutedStyle
			}

			fmt.Fprintf(cmd.OutOrStdout(), "  %-5s %-30s %-30s %s\n",
				mutedStyle.Render(order),
				textStyle.Render(text),
				mutedStyle.Render(value),
				mutedStyle.Render(active),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())

	// Hints
	fmt.Fprintln(cmd.OutOrStdout(), "-----")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn variable add-choice %s \"value\"", varSysID),
		labelStyle.Render("Add a choice"),
	)
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		fmt.Sprintf("jsn variable remove-choice %s \"value\"", varSysID),
		labelStyle.Render("Remove a choice"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// printMarkdownVariableChoices outputs markdown variable choices list.
func printMarkdownVariableChoices(cmd *cobra.Command, choices []map[string]interface{}, varName string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "## Choices for '%s'\n\n", varName)

	if len(choices) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No choices found.")
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "| Order | Text | Value | Active |")
		fmt.Fprintln(cmd.OutOrStdout(), "|-------|------|-------|--------|")

		for _, choice := range choices {
			order := getStringField(choice, "order")
			text := getStringField(choice, "text")
			value := getStringField(choice, "value")
			inactive := getStringField(choice, "inactive")

			active := "true"
			if inactive == "true" {
				active = "false"
			}

			fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n",
				order, text, value, active)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// addChoiceFlags holds the flags for the add-choice command.
type addChoiceFlags struct {
	order int
}

// newVariableAddChoiceCmd creates the variable add-choice command.
func newVariableAddChoiceCmd() *cobra.Command {
	var flags addChoiceFlags

	cmd := &cobra.Command{
		Use:   "add-choice <variable_sys_id_or_name> <value> [text]",
		Short: "Add a choice to a dropdown variable",
		Long: `Add a new choice to a Select Box variable in the question_choice table.

If text is not provided, it defaults to the value.

Examples:
  jsn variable add-choice phone_model "iPhone 15"
  jsn variable add-choice phone_model "iphone15" "iPhone 15 Pro"
  jsn variable add-choice phone_model "Galaxy S24" --order 200`,
		Args: cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			identifier := args[0]
			value := args[1]
			text := value
			if len(args) > 2 {
				text = args[2]
			}
			return runVariableAddChoice(cmd, identifier, value, text, flags)
		},
	}

	cmd.Flags().IntVar(&flags.order, "order", 100, "Sort order for the choice")

	return cmd
}

// runVariableAddChoice executes the variable add-choice command.
func runVariableAddChoice(cmd *cobra.Command, identifier, value, text string, flags addChoiceFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Find the variable first
	variable, err := findVariable(cmd.Context(), sdkClient, identifier)
	if err != nil {
		return err
	}

	varSysID := getStringField(variable, "sys_id")
	varName := getStringField(variable, "name")

	// Create the choice in question_choice table
	choiceData := map[string]interface{}{
		"question": varSysID,
		"text":     text,
		"value":    value,
		"order":    flags.order,
		"inactive": false,
	}

	result, err := sdkClient.CreateRecord(cmd.Context(), "question_choice", choiceData)
	if err != nil {
		return fmt.Errorf("failed to add choice: %w", err)
	}

	newSysID := getStringField(result, "sys_id")

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "choices",
			Cmd:         fmt.Sprintf("jsn variable choices %s", varSysID),
			Description: "List all choices",
		},
		{
			Action:      "remove-choice",
			Cmd:         fmt.Sprintf("jsn variable remove-choice %s \"%s\"", varSysID, value),
			Description: "Remove this choice",
		},
	}

	return outputWriter.OK(result,
		output.WithSummary(fmt.Sprintf("Added choice '%s' to variable '%s' (sys_id: %s)", text, varName, newSysID)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// newVariableRemoveChoiceCmd creates the variable remove-choice command.
func newVariableRemoveChoiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove-choice <variable_sys_id_or_name> <value>",
		Short: "Remove a choice from a dropdown variable",
		Long: `Remove a choice from a Select Box variable by its value.

Examples:
  jsn variable remove-choice phone_model "iPhone 15"
  jsn variable remove-choice 1234567890abcdef1234567890abcdef "iphone15"`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVariableRemoveChoice(cmd, args[0], args[1])
		},
	}
}

// runVariableRemoveChoice executes the variable remove-choice command.
func runVariableRemoveChoice(cmd *cobra.Command, identifier, value string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	sdkClient := appCtx.SDK.(*sdk.Client)

	// Find the variable first
	variable, err := findVariable(cmd.Context(), sdkClient, identifier)
	if err != nil {
		return err
	}

	varSysID := getStringField(variable, "sys_id")
	varName := getStringField(variable, "name")

	// Find the choice by value
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("question=%s^value=%s", varSysID, value))
	query.Set("sysparm_fields", "sys_id,text,value")

	resp, err := sdkClient.Get(cmd.Context(), "question_choice", query)
	if err != nil {
		return fmt.Errorf("failed to find choice: %w", err)
	}

	if len(resp.Result) == 0 {
		return output.ErrNotFound(fmt.Sprintf("choice with value '%s' not found on variable '%s'", value, varName))
	}

	choice := resp.Result[0]
	choiceSysID := getStringField(choice, "sys_id")
	choiceText := getStringField(choice, "text")

	// Delete the choice
	err = sdkClient.Delete(cmd.Context(), "question_choice", choiceSysID)
	if err != nil {
		return fmt.Errorf("failed to remove choice: %w", err)
	}

	// Build breadcrumbs
	breadcrumbs := []output.Breadcrumb{
		{
			Action:      "choices",
			Cmd:         fmt.Sprintf("jsn variable choices %s", varSysID),
			Description: "List remaining choices",
		},
		{
			Action:      "add-choice",
			Cmd:         fmt.Sprintf("jsn variable add-choice %s \"%s\"", varSysID, value),
			Description: "Re-add this choice",
		},
	}

	return outputWriter.OK(map[string]interface{}{
		"deleted":  true,
		"sys_id":   choiceSysID,
		"text":     choiceText,
		"value":    value,
		"variable": varName,
	},
		output.WithSummary(fmt.Sprintf("Removed choice '%s' from variable '%s'", choiceText, varName)),
		output.WithBreadcrumbs(breadcrumbs...),
	)
}

// findVariable finds a variable by sys_id or name.
func findVariable(ctx context.Context, sdkClient *sdk.Client, identifier string) (map[string]interface{}, error) {
	// Check if it looks like a sys_id (32 hex chars)
	if len(identifier) == 32 {
		record, err := sdkClient.GetRecord(ctx, "item_option_new", identifier)
		if err == nil {
			return record, nil
		}
	}

	// Search by name
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	query.Set("sysparm_display_value", "true")

	resp, err := sdkClient.Get(ctx, "item_option_new", query)
	if err != nil {
		return nil, fmt.Errorf("failed to find variable: %w", err)
	}

	if len(resp.Result) == 0 {
		return nil, output.ErrNotFound(fmt.Sprintf("variable '%s' not found", identifier))
	}

	return resp.Result[0], nil
}
