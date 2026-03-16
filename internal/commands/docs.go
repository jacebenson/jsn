package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/docs"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/spf13/cobra"
)

// knownTopics is a list of known documentation topics.
var knownTopics = []string{
	"gliderecord",
	"glidequery",
	"glideaggregate",
	"gliderecordsecure",
	"operators",
	"glideform",
	"glideuser",
	"glideajax",
	"glidesystem",
	"glideelement",
	"glidedatetime",
	"restmessagev2",
	"restapirequest",
	"restapiresponse",
}

// NewDocsCmd creates the docs command group.
func NewDocsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "docs [topic]",
		Short: "Access ServiceNow documentation from sn.jace.pro",
		Long: `Access ServiceNow API documentation from sn.jace.pro.

Documentation is cached locally for offline access and updated every 24 hours.

Available topics include:
  • API Reference: gliderecord, glidequery, glideaggregate
  • Client-side: glideform, glideuser, glideajax
  • Server-side: glidesystem, glideelement, glidedatetime
  • REST APIs: restmessagev2, restapirequest
  • Query operators: operators

Examples:
  jsn docs                 # List all topics
  jsn docs gliderecord     # Show GlideRecord documentation
  jsn docs operators       # Show query operators reference
  jsn docs search "query"  # Search documentation`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// If no args, list topics
			if len(args) == 0 {
				return runDocsList(cmd)
			}
			// Otherwise show the topic
			return runDocsShow(cmd, args[0])
		},
	}

	cmd.AddCommand(
		newDocsListSubCmd(),
		newDocsSearchCmd(),
		newDocsUpdateCmd(),
	)

	return cmd
}

// newDocsListSubCmd creates the docs list subcommand.
func newDocsListSubCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List available documentation topics",
		Long:  "List all available documentation topics from sn.jace.pro.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDocsList(cmd)
		},
	}
}

// runDocsList executes the docs list command.
func runDocsList(cmd *cobra.Command) error {
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if isTerminal {
		return printKnownTopics(cmd)
	}

	// Plain text output
	for _, topic := range knownTopics {
		fmt.Fprintln(cmd.OutOrStdout(), topic)
	}

	return nil
}

// printKnownTopics prints the list of known topics.
func printKnownTopics(cmd *cobra.Command) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Available Documentation Topics"))
	fmt.Fprintln(cmd.OutOrStdout())

	categories := map[string][]string{
		"API Reference": {"gliderecord", "glidequery", "glideaggregate", "gliderecordsecure"},
		"Query":         {"operators"},
		"Client-side":   {"glideform", "glideuser", "glideajax"},
		"Server-side":   {"glidesystem", "glideelement", "glidedatetime"},
		"REST APIs":     {"restmessagev2", "restapirequest", "restapiresponse"},
	}

	for category, topics := range categories {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render(category))
		for _, topic := range topics {
			fmt.Fprintf(cmd.OutOrStdout(), "    • %s\n", mutedStyle.Render(topic))
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}

	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Use 'jsn docs <topic>' to view documentation"))
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// runDocsShow executes the docs show command for a topic.
func runDocsShow(cmd *cobra.Command, topic string) error {
	fetcher := docs.NewFetcher("")
	parser := docs.NewParser()

	// Fetch the documentation
	content, err := fetcher.FetchDoc(topic, false)
	if err != nil {
		// Check if we have it cached (even if stale)
		if strings.Contains(err.Error(), "using stale cache") {
			// Already got stale cache content
		} else {
			return fmt.Errorf("failed to fetch documentation for '%s': %w", topic, err)
		}
	}

	// Parse the documentation
	doc, err := parser.Parse(string(content))
	if err != nil {
		// Just show raw content if parsing fails
		fmt.Fprintln(cmd.OutOrStdout(), string(content))
		return nil
	}

	// Determine output format
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if isTerminal {
		return printStyledDoc(cmd, doc)
	}

	// JSON output
	data := map[string]any{
		"title":       doc.Title,
		"description": doc.Description,
		"methods":     doc.Methods,
		"examples":    doc.Examples,
	}

	return output.New(output.Options{Format: output.FormatJSON, Writer: cmd.OutOrStdout()}).OK(data,
		output.WithSummary(fmt.Sprintf("Documentation: %s", doc.Title)),
	)
}

// printStyledDoc prints styled documentation.
func printStyledDoc(cmd *cobra.Command, doc *docs.Doc) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	subheaderStyle := lipgloss.NewStyle().Bold(true)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	codeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00"))

	fmt.Fprintln(cmd.OutOrStdout())

	if doc.Title != "" {
		fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(doc.Title))
		fmt.Fprintln(cmd.OutOrStdout())
	}

	if doc.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout(), doc.Description)
		fmt.Fprintln(cmd.OutOrStdout())
	}

	// Print sections
	for _, section := range doc.Sections {
		if section.Title != "" {
			fmt.Fprintln(cmd.OutOrStdout(), subheaderStyle.Render(section.Title))
			fmt.Fprintln(cmd.OutOrStdout())
		}

		if section.Content != "" {
			lines := strings.Split(section.Content, "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				if strings.HasPrefix(line, "```") {
					continue
				}
				if strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
					fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", codeStyle.Render(strings.TrimSpace(line)))
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", line)
				}
			}
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}

	// Print examples
	if len(doc.Examples) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), subheaderStyle.Render("Examples"))
		fmt.Fprintln(cmd.OutOrStdout())

		for i, example := range doc.Examples {
			if example.Title != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render(example.Title))
			}

			if example.Code != "" {
				lines := strings.Split(example.Code, "\n")
				for _, line := range lines {
					fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", codeStyle.Render(line))
				}
			}

			if i < len(doc.Examples)-1 {
				fmt.Fprintln(cmd.OutOrStdout())
			}
		}

		fmt.Fprintln(cmd.OutOrStdout())
	}

	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("-----"))
	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Source: sn.jace.pro"))
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// newDocsSearchCmd creates the docs search command.
func newDocsSearchCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "search <term>",
		Short: "Search documentation",
		Long: `Search across all documentation topics.

Examples:
  jsn docs search "query"
  jsn docs search "gliderecord"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDocsSearch(cmd, args[0])
		},
	}
}

// runDocsSearch executes the docs search command.
func runDocsSearch(cmd *cobra.Command, term string) error {
	fetcher := docs.NewFetcher("")

	// Fetch search index
	entries, err := fetcher.FetchSearchIndex(false)
	if err != nil {
		return fmt.Errorf("failed to fetch search index: %w", err)
	}

	// Search in entries
	termLower := strings.ToLower(term)
	var results []docs.SearchIndexEntry

	for _, entry := range entries {
		if strings.Contains(strings.ToLower(entry.Title), termLower) ||
			strings.Contains(strings.ToLower(entry.Description), termLower) ||
			strings.Contains(strings.ToLower(entry.Content), termLower) {
			results = append(results, entry)
		}
	}

	// Determine output format
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if isTerminal {
		return printStyledSearchResults(cmd, term, results)
	}

	// JSON output
	var data []map[string]string
	for _, entry := range results {
		data = append(data, map[string]string{
			"title":       entry.Title,
			"description": entry.Description,
			"url":         entry.URL,
		})
	}

	return output.New(output.Options{Format: output.FormatJSON, Writer: cmd.OutOrStdout()}).OK(data,
		output.WithSummary(fmt.Sprintf("%d results for '%s'", len(results), term)),
	)
}

// printStyledSearchResults prints styled search results.
func printStyledSearchResults(cmd *cobra.Command, term string, results []docs.SearchIndexEntry) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintf(cmd.OutOrStdout(), "%s %s\n\n", headerStyle.Render("Search results for:"), term)

	if len(results) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  No results found."))
		return nil
	}

	for _, entry := range results {
		if entry.Title != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render(entry.Title))
		}
		if entry.Description != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(entry.Description))
		}

		topic := extractTopicFromURL(entry.URL)
		if topic != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s %s\n", mutedStyle.Render("View:"), fmt.Sprintf("jsn docs %s", topic))
		}

		fmt.Fprintln(cmd.OutOrStdout())
	}

	fmt.Fprintf(cmd.OutOrStdout(), "%s\n", mutedStyle.Render(fmt.Sprintf("Found %d results", len(results))))
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// newDocsUpdateCmd creates the docs update command.
func newDocsUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update",
		Short: "Update documentation cache",
		Long: `Force refresh the documentation cache from sn.jace.pro.

This downloads the latest search index and clears the local cache.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDocsUpdate(cmd)
		},
	}
}

// runDocsUpdate executes the docs update command.
func runDocsUpdate(cmd *cobra.Command) error {
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "Updating documentation cache...")

	// Clear existing cache
	homeDir, _ := os.UserHomeDir()
	cacheDir := filepath.Join(homeDir, ".config", "servicenow", "docs")

	fetcher := docs.NewFetcher(cacheDir)

	// Clear cache
	if err := fetcher.ClearCache(); err != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Note: No existing cache to clear"))
	}

	// Fetch fresh search index
	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("  Fetching search index..."))
	_, err := fetcher.FetchSearchIndex(true)
	if err != nil {
		return fmt.Errorf("failed to update cache: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", successStyle.Render("OK Documentation cache updated"))
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), mutedStyle.Render("Run 'jsn docs list' to see available topics"))
	fmt.Fprintln(cmd.OutOrStdout())

	return nil
}

// extractTopicFromURL extracts the topic name from a URL.
func extractTopicFromURL(url string) string {
	url = strings.TrimPrefix(url, docs.BaseURL)
	url = strings.TrimPrefix(url, "/")

	if strings.HasPrefix(url, "docs/") {
		topic := strings.TrimPrefix(url, "docs/")
		topic = strings.TrimSuffix(topic, ".md")
		return topic
	}

	return ""
}
