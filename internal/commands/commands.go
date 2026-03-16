package commands

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

// CommandInfo describes a CLI command.
type CommandInfo struct {
	Name        string   `json:"name"`
	Category    string   `json:"category"`
	Description string   `json:"description"`
	Actions     []string `json:"actions,omitempty"`
}

// CommandCategory groups commands by category.
type CommandCategory struct {
	Name     string        `json:"name"`
	Commands []CommandInfo `json:"commands"`
}

// CommandCategories returns all command categories for the catalog.
func CommandCategories() []CommandCategory {
	return []CommandCategory{
		{
			Name: "Explore",
			Commands: []CommandInfo{
				{Name: "tables", Category: "explore", Description: "List and inspect tables", Actions: []string{"list", "show", "schema", "columns"}},
				{Name: "rules", Category: "explore", Description: "List and view business rules", Actions: []string{"list", "show", "script"}},
				{Name: "flows", Category: "explore", Description: "List and view flows", Actions: []string{"list", "show"}},
				{Name: "jobs", Category: "explore", Description: "List scheduled jobs", Actions: []string{"list", "show"}},
				{Name: "script-includes", Category: "explore", Description: "List and view script includes", Actions: []string{"list", "show", "code"}},
			},
		},
		{
			Name: "Data",
			Commands: []CommandInfo{
				{Name: "records", Category: "data", Description: "Query and manage records", Actions: []string{"list", "show", "query", "create", "update", "delete"}},
				{Name: "choices", Category: "data", Description: "Manage choice values", Actions: []string{"list", "create", "update", "delete", "reorder"}},
			},
		},
		{
			Name: "Development",
			Commands: []CommandInfo{
				{Name: "updateset", Category: "dev", Description: "Manage update sets", Actions: []string{"list", "show", "use", "create", "parent"}},
			},
		},
		{
			Name: "Configuration",
			Commands: []CommandInfo{
				{Name: "config", Category: "config", Description: "Manage profiles", Actions: []string{"add", "switch", "list", "get"}},
				{Name: "auth", Category: "config", Description: "Manage authentication", Actions: []string{"login", "logout", "status"}},
				{Name: "setup", Category: "config", Description: "Interactive first-time setup"},
			},
		},
		{
			Name: "System",
			Commands: []CommandInfo{
				{Name: "commands", Category: "system", Description: "List all commands"},
				{Name: "version", Category: "system", Description: "Show version information"},
				{Name: "help", Category: "system", Description: "Show help"},
			},
		},
	}
}

// NewCommandsCmd creates the commands listing command.
func NewCommandsCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "commands",
		Aliases: []string{"cmds"},
		Short:   "List all available commands",
		Long:    "List all available jsn commands organized by category.",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())
			categories := CommandCategories()

			outputWriter := app.Output.(*output.Writer)

			// For styled terminal output, render grouped columns directly
			if outputWriter.GetFormat() == output.FormatStyled {
				renderCommandsStyled(cmd.OutOrStdout(), categories)
				return nil
			}

			return outputWriter.OK(categories,
				output.WithSummary("All available jsn commands"),
			)
		},
	}
}

// renderCommandsStyled writes a grouped command listing with aligned columns.
func renderCommandsStyled(w io.Writer, categories []CommandCategory) {
	bold := lipgloss.NewStyle().Bold(true)
	muted := lipgloss.NewStyle().Foreground(lipgloss.Color("#888"))

	// Find max widths across all categories for alignment
	maxName := 0
	maxDesc := 0
	for _, cat := range categories {
		for _, cmd := range cat.Commands {
			if len(cmd.Name) > maxName {
				maxName = len(cmd.Name)
			}
			if len(cmd.Description) > maxDesc {
				maxDesc = len(cmd.Description)
			}
		}
	}

	for i, cat := range categories {
		if i > 0 {
			fmt.Fprintln(w)
		}
		fmt.Fprintln(w, bold.Render(cat.Name))
		for _, cmd := range cat.Commands {
			actions := ""
			if len(cmd.Actions) > 0 {
				actions = strings.Join(cmd.Actions, ", ")
			}
			line := fmt.Sprintf("  %-*s  %-*s", maxName, cmd.Name, maxDesc, cmd.Description)
			if actions != "" {
				line += "  " + muted.Render(actions)
			}
			fmt.Fprintln(w, line)
		}
	}
}
