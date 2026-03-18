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
				{Name: "tables", Category: "explore", Description: "List and inspect tables", Actions: []string{"list", "show", "schema", "columns", "relationships", "dependencies", "diagram"}},
				{Name: "rules", Category: "explore", Description: "List and view business rules", Actions: []string{"list", "show", "script"}},
				{Name: "flows", Category: "explore", Description: "List and view flows", Actions: []string{"list", "show", "executions", "debug", "variables", "activate", "deactivate"}},
				{Name: "jobs", Category: "explore", Description: "List scheduled jobs", Actions: []string{"list", "show", "executions", "logs", "run", "script"}},
				{Name: "script-includes", Category: "explore", Description: "List and view script includes", Actions: []string{"list", "show", "code"}},
				{Name: "ui-policies", Category: "explore", Description: "List UI policies", Actions: []string{"list", "show", "script"}},
				{Name: "client-scripts", Category: "explore", Description: "List client scripts", Actions: []string{"list", "show", "script"}},
				{Name: "acls", Category: "explore", Description: "List ACLs", Actions: []string{"list", "show", "script", "check"}},
				{Name: "sp", Category: "explore", Description: "List and view Service Portals", Actions: []string{"list", "show"}},
				{Name: "sp-widget", Category: "explore", Description: "List and view Service Portal widgets", Actions: []string{"list", "show"}},
				{Name: "sp-page", Category: "explore", Description: "List and view Service Portal pages", Actions: []string{"list", "show"}},
				{Name: "forms", Category: "explore", Description: "List and view UI form layouts", Actions: []string{"list", "show"}},
				{Name: "ui-scripts", Category: "explore", Description: "List and view UI scripts", Actions: []string{"list", "show"}},
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
				{Name: "generate", Category: "dev", Description: "Generate code templates", Actions: []string{"gliderecord", "script-include", "rest", "test", "acl"}},
				{Name: "compare", Category: "dev", Description: "Compare across instances", Actions: []string{"tables", "script-includes", "choices", "flows"}},
				{Name: "export", Category: "dev", Description: "Export resources", Actions: []string{"script-includes", "tables", "update-set"}},
				{Name: "import", Category: "dev", Description: "Import resources"},
			},
		},
		{
			Name: "Debugging",
			Commands: []CommandInfo{
				{Name: "logs", Category: "debug", Description: "Query system logs"},
				{Name: "instance", Category: "debug", Description: "Instance information", Actions: []string{"info"}},
				{Name: "docs", Category: "debug", Description: "Documentation", Actions: []string{"list", "search", "update"}},
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
			format := outputWriter.GetFormat()
			isTTY := output.IsTTY(cmd.OutOrStdout())

			// Determine effective format
			effectiveFormat := format
			if format == output.FormatAuto {
				if isTTY {
					effectiveFormat = output.FormatStyled
				} else {
					effectiveFormat = output.FormatJSON
				}
			}

			// For styled terminal output, render grouped columns
			if effectiveFormat == output.FormatStyled {
				renderCommandsStyled(cmd.OutOrStdout(), categories)
				return nil
			}

			// For JSON output, provide clean structure
			if effectiveFormat == output.FormatJSON {
				return outputWriter.OK(categories,
					output.WithSummary("All available jsn commands"),
				)
			}

			// For markdown, render simple list
			if effectiveFormat == output.FormatMarkdown {
				renderCommandsMarkdown(cmd.OutOrStdout(), categories)
				return nil
			}

			// Quiet format - just command names
			for _, cat := range categories {
				for _, c := range cat.Commands {
					fmt.Fprintln(cmd.OutOrStdout(), c.Name)
				}
			}
			return nil
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

// renderCommandsMarkdown writes a markdown formatted command listing.
func renderCommandsMarkdown(w io.Writer, categories []CommandCategory) {
	fmt.Fprintln(w, "# Available Commands")
	fmt.Fprintln(w)

	for _, cat := range categories {
		fmt.Fprintf(w, "## %s\n\n", cat.Name)
		for _, cmd := range cat.Commands {
			fmt.Fprintf(w, "- **%s** - %s", cmd.Name, cmd.Description)
			if len(cmd.Actions) > 0 {
				fmt.Fprintf(w, " (%s)", strings.Join(cmd.Actions, ", "))
			}
			fmt.Fprintln(w)
		}
		fmt.Fprintln(w)
	}
}
