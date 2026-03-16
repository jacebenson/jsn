package docs

import (
	"fmt"
	"regexp"
	"strings"
)

// Doc represents a parsed documentation page.
type Doc struct {
	Title       string
	Description string
	Methods     []Method
	Examples    []Example
	Sections    []Section
	Raw         string
}

// Method represents a documented method/function.
type Method struct {
	Name        string
	Signature   string
	Description string
	Parameters  []Parameter
	Returns     string
	Example     string
}

// Parameter represents a method parameter.
type Parameter struct {
	Name        string
	Type        string
	Description string
	Optional    bool
}

// Example represents a code example.
type Example struct {
	Title       string
	Code        string
	Description string
	Language    string
}

// Section represents a documentation section.
type Section struct {
	Title   string
	Content string
	Level   int
}

// Parser handles parsing markdown documentation.
type Parser struct{}

// NewParser creates a new documentation parser.
func NewParser() *Parser {
	return &Parser{}
}

// Parse parses markdown documentation content.
func (p *Parser) Parse(content string) (*Doc, error) {
	doc := &Doc{
		Raw:      content,
		Methods:  []Method{},
		Examples: []Example{},
		Sections: []Section{},
	}

	// Extract frontmatter if present
	content = p.extractFrontmatter(content, doc)

	// Parse sections
	p.parseSections(content, doc)

	// Extract methods from tables
	p.parseMethods(content, doc)

	// Extract examples
	p.parseExamples(content, doc)

	// Set title if not found in frontmatter
	if doc.Title == "" {
		doc.Title = p.extractTitle(content)
	}

	return doc, nil
}

// extractFrontmatter extracts YAML frontmatter from markdown.
func (p *Parser) extractFrontmatter(content string, doc *Doc) string {
	if !strings.HasPrefix(content, "---") {
		return content
	}

	parts := strings.SplitN(content, "---", 3)
	if len(parts) < 3 {
		return content
	}

	frontmatter := strings.TrimSpace(parts[1])

	// Parse frontmatter fields
	lines := strings.Split(frontmatter, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "title:") {
			doc.Title = strings.TrimSpace(strings.TrimPrefix(line, "title:"))
			doc.Title = strings.Trim(doc.Title, `"'`)
		} else if strings.HasPrefix(line, "description:") {
			doc.Description = strings.TrimSpace(strings.TrimPrefix(line, "description:"))
			doc.Description = strings.Trim(doc.Description, `"'`)
		}
	}

	return parts[2]
}

// extractTitle extracts the title from the first H1 heading.
func (p *Parser) extractTitle(content string) string {
	// Look for # Title
	re := regexp.MustCompile(`(?m)^#\s+(.+)$`)
	matches := re.FindStringSubmatch(content)
	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}
	return ""
}

// parseSections parses markdown sections.
func (p *Parser) parseSections(content string, doc *Doc) {
	// Split by headers
	re := regexp.MustCompile(`(?m)^(#{1,6})\s+(.+)$`)
	matches := re.FindAllStringSubmatchIndex(content, -1)

	if len(matches) == 0 {
		// No sections, treat entire content as one section
		doc.Sections = append(doc.Sections, Section{
			Title:   "",
			Content: strings.TrimSpace(content),
			Level:   0,
		})
		return
	}

	for i, match := range matches {
		level := len(content[match[2]:match[3]])
		title := strings.TrimSpace(content[match[4]:match[5]])

		// Get content until next header
		start := match[1]
		end := len(content)
		if i < len(matches)-1 {
			end = matches[i+1][0]
		}

		sectionContent := strings.TrimSpace(content[start:end])

		doc.Sections = append(doc.Sections, Section{
			Title:   title,
			Content: sectionContent,
			Level:   level,
		})
	}
}

// parseMethods extracts methods from markdown tables.
func (p *Parser) parseMethods(content string, doc *Doc) {
	// Look for method tables with common patterns
	// Pattern: Method tables often have Method, Description, Parameters columns

	// Simple table parsing - look for | Method | Description | patterns
	re := regexp.MustCompile(`(?m)^\|\s*Method\s*\|\s*Description\s*\|`)
	if !re.MatchString(content) {
		return
	}

	// Extract table rows
	tableRe := regexp.MustCompile(`(?m)^\|\s*([^|]+)\|\s*([^|]+)\|`)
	matches := tableRe.FindAllStringSubmatch(content, -1)

	for i, match := range matches {
		if i == 0 {
			continue // Skip header row
		}

		methodName := strings.TrimSpace(match[1])
		description := strings.TrimSpace(match[2])

		// Skip separator rows
		if strings.Contains(methodName, "---") {
			continue
		}

		// Clean up markdown formatting
		methodName = p.cleanMarkdown(methodName)
		description = p.cleanMarkdown(description)

		doc.Methods = append(doc.Methods, Method{
			Name:        methodName,
			Description: description,
		})
	}
}

// parseExamples extracts code examples from markdown.
func (p *Parser) parseExamples(content string, doc *Doc) {
	// Look for code blocks
	re := regexp.MustCompile("(?s)```(\\w+)?\\n(.*?)```")
	matches := re.FindAllStringSubmatch(content, -1)

	for _, match := range matches {
		language := "javascript"
		if len(match) > 1 && match[1] != "" {
			language = match[1]
		}

		code := strings.TrimSpace(match[2])

		// Look for preceding text as description
		doc.Examples = append(doc.Examples, Example{
			Code:     code,
			Language: language,
		})
	}
}

// cleanMarkdown removes markdown formatting from text.
func (p *Parser) cleanMarkdown(text string) string {
	// Remove inline code markers
	text = regexp.MustCompile("`([^`]+)`").ReplaceAllString(text, "$1")

	// Remove bold/italic markers
	text = regexp.MustCompile(`\*\*([^*]+)\*\*`).ReplaceAllString(text, "$1")
	text = regexp.MustCompile(`\*([^*]+)\*`).ReplaceAllString(text, "$1")

	// Remove links, keep text
	text = regexp.MustCompile(`\[([^\]]+)\]\([^\)]+\)`).ReplaceAllString(text, "$1")

	return strings.TrimSpace(text)
}

// GetSummary returns a summary of the document.
func (d *Doc) GetSummary() string {
	if d.Description != "" {
		return d.Description
	}

	// Use first section content as summary
	for _, section := range d.Sections {
		if section.Level <= 2 && section.Content != "" {
			content := strings.TrimSpace(section.Content)
			lines := strings.Split(content, "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") {
					return line
				}
			}
		}
	}

	return ""
}

// FindMethod finds a method by name.
func (d *Doc) FindMethod(name string) *Method {
	for i := range d.Methods {
		if strings.EqualFold(d.Methods[i].Name, name) {
			return &d.Methods[i]
		}
	}
	return nil
}

// FindSection finds a section by title.
func (d *Doc) FindSection(title string) *Section {
	for i := range d.Sections {
		if strings.EqualFold(d.Sections[i].Title, title) {
			return &d.Sections[i]
		}
	}
	return nil
}

// FormatForTerminal formats the documentation for terminal display.
func (d *Doc) FormatForTerminal(width int) string {
	var out strings.Builder

	// Title
	if d.Title != "" {
		out.WriteString(fmt.Sprintf("\n%s\n\n", d.Title))
	}

	// Description
	if d.Description != "" {
		out.WriteString(fmt.Sprintf("%s\n\n", d.Description))
	}

	// Methods section
	if len(d.Methods) > 0 {
		out.WriteString("Methods:\n")
		for _, method := range d.Methods {
			out.WriteString(fmt.Sprintf("  • %s\n", method.Name))
			if method.Description != "" {
				out.WriteString(fmt.Sprintf("    %s\n", method.Description))
			}
		}
		out.WriteString("\n")
	}

	return out.String()
}
