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
	Hint        string   `json:"hint,omitempty"`
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
				{Name: "tables", Category: "explore", Description: "List and inspect tables (sys_db_object, sys_dictionary)", Actions: []string{"list", "show", "schema", "columns", "relationships", "dependencies", "diagram"}, Hint: "Use 'tables list' to discover table names, 'tables columns <table>' for field definitions"},
				{Name: "rules", Category: "explore", Description: "Business rules (sys_script) — server-side scripts on table operations", Actions: []string{"script"}, Hint: "jsn rules <name_or_sys_id> | --search <term> | --table <name> | --active"},
				{Name: "flows", Category: "explore", Description: "Flow Designer flows (sys_hub_flow)", Actions: []string{"executions", "execute", "debug", "variables", "activate", "deactivate"}, Hint: "jsn flows <name_or_sys_id> | --search <term> | --active"},
				{Name: "jobs", Category: "explore", Description: "Scheduled jobs (sysauto_script, sys_trigger)", Actions: []string{"executions", "logs", "run", "script"}, Hint: "jsn jobs <name_or_sys_id> | --search <term> | --type scheduled|script"},
				{Name: "script-includes", Category: "explore", Description: "Script includes (sys_script_include) — reusable server-side classes/functions", Actions: []string{"script"}, Hint: "jsn script-includes <name_or_sys_id> | --search <term> | --scope <name>"},
				{Name: "ui-policies", Category: "explore", Description: "UI policies (sys_ui_policy) — form field visibility/mandatory/readonly rules", Actions: []string{"script"}, Hint: "jsn ui-policies <name_or_sys_id> | --search <term> | --table <name>"},
				{Name: "client-scripts", Category: "explore", Description: "Client scripts (sys_script_client) — browser-side form scripts", Actions: []string{"script"}, Hint: "jsn client-scripts <name_or_sys_id> | --search <term> | --table <name> | --type onLoad|onChange|onSubmit"},
				{Name: "acls", Category: "explore", Description: "Access control lists (sys_security_acl) — row/field-level security", Actions: []string{"script", "check"}, Hint: "jsn acls <name_or_sys_id> | --search <term> | --table <name> | --operation read|write|create|delete"},
				{Name: "sp", Category: "explore", Description: "Service Portals (sp_portal)", Hint: "jsn sp <id_or_sys_id> | --search <term>"},
				{Name: "sp-widgets", Category: "explore", Description: "Service Portal widgets (sp_widget)", Actions: []string{"show"}, Hint: "jsn sp-widgets <id_or_sys_id> | --search <term>. Use 'show' for code (--html, --css, --client, --server)"},
				{Name: "sp-pages", Category: "explore", Description: "Service Portal pages (sp_page) with widget instances", Hint: "jsn sp-pages <id_or_sys_id> | --search <term>"},
				{Name: "forms", Category: "explore", Description: "UI form layouts (sys_ui_section, sys_ui_element)", Hint: "jsn forms <table> [--view <name>] | --table <name> to list views"},
				{Name: "lists", Category: "explore", Description: "UI list column layouts (sys_ui_list, sys_ui_list_element)", Hint: "jsn lists <table> [--view <name>] | --table <name> to list views"},
				{Name: "ui-scripts", Category: "explore", Description: "UI scripts (sys_ui_script) — global client-side includes", Actions: []string{"script"}, Hint: "jsn ui-scripts <name_or_sys_id> | --search <term>"},
			},
		},
		{
			Name: "Data",
			Commands: []CommandInfo{
				{Name: "records", Category: "data", Description: "CRUD on any table via Table API — the generic workhorse", Actions: []string{"create", "update", "delete"}, Hint: "--table <name> required. jsn records --table <t> [sys_id] | --search <term> | --query <encoded> | --count. Shows enriched variables for sc_req_item."},
				{Name: "choices", Category: "data", Description: "Choice values (sys_choice) — dropdown options for table fields", Actions: []string{"list", "create", "update", "delete", "reorder"}, Hint: "jsn choices list <table> <column>. For catalog variable dropdowns, use 'jsn variable choices' instead (question_choice table)"},
			},
		},
		{
			Name: "Service Catalog",
			Commands: []CommandInfo{
				{Name: "catalog-item", Category: "catalog", Description: "Service Catalog items (sc_cat_item) with variables", Actions: []string{"create", "create-variable", "variables"}, Hint: "jsn catalog-item <sys_id_or_name> | --active | --query <encoded>"},
				{Name: "variable", Category: "catalog", Description: "Catalog item variables (item_option_new) and their dropdown choices (question_choice)", Actions: []string{"show", "choices", "add-choice", "remove-choice"}, Hint: "jsn variable show <name>. Use 'choices' for dropdown options (question_choice table, NOT sys_choice)"},
				{Name: "variable-types", Category: "catalog", Description: "Reference list of all catalog variable types (static data)"},
			},
		},
		{
			Name: "Development",
			Commands: []CommandInfo{
				{Name: "updateset", Category: "dev", Description: "Update sets (sys_update_set) — track and transport changes", Actions: []string{"list", "show", "use", "create", "parent"}, Hint: "jsn updateset use <name> to set current. 'parent' sets hierarchy."},
				{Name: "scope", Category: "dev", Description: "Application scopes (sys_scope) — namespace isolation for apps", Actions: []string{"show", "list", "use"}, Hint: "jsn scope use <name> to switch. 'show' displays current scope."},
				{Name: "rest", Category: "dev", Description: "Raw REST API calls — escape hatch for any endpoint", Actions: []string{"get", "post", "patch", "delete"}, Hint: "jsn rest get /api/now/table/incident?sysparm_limit=5. Path appended to instance URL."},
				{Name: "eval", Category: "dev", Description: "Run background scripts (Scripts - Background) — server-side JS execution", Hint: "jsn eval '<script>' | --file <path> | pipe via stdin. Uses gs.print() for output. Full GlideRecord/gs API."},
			},
		},
		{
			Name: "Debugging",
			Commands: []CommandInfo{
				{Name: "logs", Category: "debug", Description: "System logs (syslog) — recent errors, warnings, debug output", Hint: "jsn logs [--level error|warn|info] [--source <name>] [--minutes 60]"},
				{Name: "instance", Category: "debug", Description: "Instance connection and version info", Actions: []string{"info"}},
				{Name: "docs", Category: "debug", Description: "Offline documentation and reference", Actions: []string{"list", "search", "update"}, Hint: "jsn docs search <term> for quick lookups"},
			},
		},
		{
			Name: "Configuration",
			Commands: []CommandInfo{
				{Name: "config", Category: "config", Description: "Manage instance profiles", Actions: []string{"add", "switch", "list", "get"}, Hint: "jsn config switch <name> to change active instance"},
				{Name: "auth", Category: "config", Description: "Authentication — login, logout, status check", Actions: []string{"login", "logout", "status"}, Hint: "Always run 'jsn auth status' first. NEVER run 'jsn auth logout' without explicit user permission."},
				{Name: "setup", Category: "config", Description: "Interactive first-time setup wizard"},
			},
		},
		{
			Name: "System",
			Commands: []CommandInfo{
				{Name: "commands", Category: "system", Description: "List all commands with descriptions and hints", Hint: "Use --md for markdown, --json for structured data"},
				{Name: "version", Category: "system", Description: "Show version information"},
				{Name: "help", Category: "system", Description: "Show help for any command"},
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
			fmt.Fprintf(w, "- **%s** — %s", cmd.Name, cmd.Description)
			if len(cmd.Actions) > 0 {
				fmt.Fprintf(w, " [%s]", strings.Join(cmd.Actions, ", "))
			}
			fmt.Fprintln(w)
			if cmd.Hint != "" {
				fmt.Fprintf(w, "  %s\n", cmd.Hint)
			}
		}
		fmt.Fprintln(w)
	}
}
