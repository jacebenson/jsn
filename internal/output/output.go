// Package output provides JSON/Markdown output formatting and error handling.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/itchyny/gojq"
)

// Format specifies the output format.
type Format int

const (
	FormatAuto Format = iota // Auto-detect: TTY → Styled, non-TTY → JSON
	FormatJSON
	FormatMarkdown // Literal Markdown syntax (portable, pipeable)
	FormatStyled   // ANSI styled output (forced, even when piped)
	FormatQuiet    // Data only, no envelope
)

// Options controls output behavior.
type Options struct {
	Format   Format
	Writer   io.Writer
	JQFilter string // jq expression to apply to JSON output
}

// DefaultOptions returns options for standard output.
func DefaultOptions() Options {
	return Options{
		Format: FormatAuto,
		Writer: os.Stdout,
	}
}

// Writer handles all output formatting.
type Writer struct {
	opts Options
	jq   *gojq.Code // compiled jq filter, nil when JQFilter is empty
}

// GetFormat returns the current output format.
func (w *Writer) GetFormat() Format {
	return w.opts.Format
}

// New creates a new output writer.
func New(opts Options) *Writer {
	if opts.Writer == nil {
		opts.Writer = os.Stdout
	}

	w := &Writer{opts: opts}

	// Compile jq filter if provided
	if opts.JQFilter != "" {
		query, err := gojq.Parse(opts.JQFilter)
		if err == nil {
			w.jq, _ = gojq.Compile(query)
		}
	}

	return w
}

// Breadcrumb is a suggested follow-up action.
type Breadcrumb struct {
	Action      string `json:"action"`
	Cmd         string `json:"cmd"`
	Description string `json:"description"`
}

// Response is the success envelope for JSON output.
type Response struct {
	OK          bool           `json:"ok"`
	Data        any            `json:"data,omitempty"`
	Summary     string         `json:"summary,omitempty"`
	Notice      string         `json:"notice,omitempty"`
	Breadcrumbs []Breadcrumb   `json:"breadcrumbs,omitempty"`
	Meta        map[string]any `json:"meta,omitempty"`
}

// ErrorResponse is the error envelope for JSON output.
type ErrorResponse struct {
	OK    bool           `json:"ok"`
	Error string         `json:"error"`
	Code  string         `json:"code"`
	Hint  string         `json:"hint,omitempty"`
	Meta  map[string]any `json:"meta,omitempty"`
}

// ResponseOption modifies a Response.
type ResponseOption func(*Response)

// WithSummary sets the summary text.
func WithSummary(summary string) ResponseOption {
	return func(r *Response) { r.Summary = summary }
}

// WithNotice sets a notice message.
func WithNotice(notice string) ResponseOption {
	return func(r *Response) { r.Notice = notice }
}

// WithBreadcrumbs adds breadcrumbs to the response.
func WithBreadcrumbs(b ...Breadcrumb) ResponseOption {
	return func(r *Response) { r.Breadcrumbs = append(r.Breadcrumbs, b...) }
}

// OK outputs a successful response.
func (w *Writer) OK(data any, opts ...ResponseOption) error {
	resp := &Response{
		OK:   true,
		Data: data,
	}
	for _, opt := range opts {
		opt(resp)
	}

	switch w.opts.Format {
	case FormatJSON:
		return w.writeJSON(resp)
	case FormatMarkdown:
		return w.writeMarkdown(resp)
	case FormatQuiet:
		return w.writeQuiet(data)
	case FormatStyled:
		return w.writeStyled(resp)
	default:
		// Auto-detect: TTY → Styled, non-TTY → JSON
		if IsTTY(w.opts.Writer) {
			return w.writeStyled(resp)
		}
		return w.writeJSON(resp)
	}
}

// Err outputs an error response.
func (w *Writer) Err(code string, err error, hint string) error {
	resp := &ErrorResponse{
		OK:    false,
		Error: err.Error(),
		Code:  code,
		Hint:  hint,
	}

	switch w.opts.Format {
	case FormatJSON, FormatQuiet:
		return w.writeJSONError(resp)
	case FormatMarkdown:
		return w.writeMarkdownError(resp)
	default:
		if IsTTY(w.opts.Writer) {
			return w.writeStyledError(resp)
		}
		return w.writeJSONError(resp)
	}
}

// writeJSON outputs JSON envelope.
func (w *Writer) writeJSON(resp *Response) error {
	// Apply jq filter if provided
	if w.jq != nil {
		return w.writeJQ(resp)
	}

	enc := json.NewEncoder(w.opts.Writer)
	enc.SetIndent("", "  ")
	return enc.Encode(resp)
}

// writeJSONError outputs error as JSON envelope.
func (w *Writer) writeJSONError(resp *ErrorResponse) error {
	enc := json.NewEncoder(w.opts.Writer)
	enc.SetIndent("", "  ")
	return enc.Encode(resp)
}

// writeQuiet outputs data only (no envelope).
func (w *Writer) writeQuiet(data any) error {
	// Apply jq filter if provided
	if w.jq != nil {
		return w.writeJQDataOnly(data)
	}

	enc := json.NewEncoder(w.opts.Writer)
	enc.SetIndent("", "  ")
	return enc.Encode(data)
}

// writeMarkdown outputs Markdown tables.
func (w *Writer) writeMarkdown(resp *Response) error {
	if resp.Summary != "" {
		fmt.Fprintln(w.opts.Writer, resp.Summary)
		fmt.Fprintln(w.opts.Writer)
	}

	// Handle data as table or list
	switch data := resp.Data.(type) {
	case []map[string]any:
		if err := w.writeMarkdownTable(data); err != nil {
			return err
		}
	case []any:
		if err := w.writeMarkdownList(data); err != nil {
			return err
		}
	default:
		fmt.Fprintf(w.opts.Writer, "%v\n", data)
	}

	// Add breadcrumbs as hints
	if len(resp.Breadcrumbs) > 0 {
		fmt.Fprintln(w.opts.Writer)
		fmt.Fprintln(w.opts.Writer, "### Hints")
		for _, bc := range resp.Breadcrumbs {
			fmt.Fprintf(w.opts.Writer, "- **%s**: `%s` — %s\n", bc.Action, bc.Cmd, bc.Description)
		}
	}

	return nil
}

// writeMarkdownTable outputs data as markdown table.
func (w *Writer) writeMarkdownTable(data []map[string]any) error {
	if len(data) == 0 {
		fmt.Fprintln(w.opts.Writer, "(no results)")
		return nil
	}

	// Detect columns from data
	columns := detectColumns(data)

	// Calculate widths
	widths := make(map[string]int)
	for _, col := range columns {
		widths[col] = len(col)
	}
	for _, row := range data {
		for _, col := range columns {
			if val, ok := row[col]; ok {
				s := fmt.Sprintf("%v", val)
				if len(s) > widths[col] && len(s) <= 50 {
					widths[col] = len(s)
				}
			}
		}
	}

	// Header
	fmt.Fprint(w.opts.Writer, "| ")
	for _, col := range columns {
		fmt.Fprintf(w.opts.Writer, "%-*s | ", widths[col], col)
	}
	fmt.Fprintln(w.opts.Writer)

	// Separator
	fmt.Fprint(w.opts.Writer, "| ")
	for _, col := range columns {
		for i := 0; i < widths[col]; i++ {
			fmt.Fprint(w.opts.Writer, "-")
		}
		fmt.Fprint(w.opts.Writer, " | ")
	}
	fmt.Fprintln(w.opts.Writer)

	// Rows
	for _, row := range data {
		fmt.Fprint(w.opts.Writer, "| ")
		for _, col := range columns {
			val := ""
			if v, ok := row[col]; ok && v != nil {
				val = fmt.Sprintf("%v", v)
			}
			if len(val) > 50 {
				val = val[:47] + "..."
			}
			fmt.Fprintf(w.opts.Writer, "%-*s | ", widths[col], val)
		}
		fmt.Fprintln(w.opts.Writer)
	}

	return nil
}

// writeMarkdownList outputs data as markdown list.
func (w *Writer) writeMarkdownList(data []any) error {
	for _, item := range data {
		fmt.Fprintf(w.opts.Writer, "- %v\n", item)
	}
	return nil
}

// writeMarkdownError outputs error as markdown.
func (w *Writer) writeMarkdownError(resp *ErrorResponse) error {
	fmt.Fprintf(w.opts.Writer, "**Error (%s)**: %s\n", resp.Code, resp.Error)
	if resp.Hint != "" {
		fmt.Fprintf(w.opts.Writer, "\n*Hint: %s*\n", resp.Hint)
	}
	return nil
}

// writeStyled outputs ANSI styled terminal output using lipgloss.
func (w *Writer) writeStyled(resp *Response) error {
	if resp.Summary != "" {
		fmt.Fprintln(w.opts.Writer, resp.Summary)
		fmt.Fprintln(w.opts.Writer)
	}

	// Handle data
	switch data := resp.Data.(type) {
	case []map[string]any:
		if err := w.writeStyledTable(data); err != nil {
			return err
		}
	case []any:
		for _, item := range data {
			fmt.Fprintf(w.opts.Writer, "%v\n", item)
		}
	default:
		fmt.Fprintf(w.opts.Writer, "%v\n", data)
	}

	// Add breadcrumbs
	if len(resp.Breadcrumbs) > 0 {
		fmt.Fprintln(w.opts.Writer)
		for _, bc := range resp.Breadcrumbs {
			fmt.Fprintf(w.opts.Writer, "  → %s: %s — %s\n", bc.Action, bc.Cmd, bc.Description)
		}
	}

	return nil
}

// detectColumns determines the column order from the data.
func detectColumns(data []map[string]any) []string {
	if len(data) == 0 {
		return nil
	}

	// Check for update set specific columns first
	hasUpdateSetFields := false
	for _, row := range data {
		if _, hasSysID := row["sys_id"]; hasSysID {
			if _, hasName := row["name"]; hasName {
				if _, hasScope := row["scope"]; hasScope {
					hasUpdateSetFields = true
					break
				}
			}
		}
	}

	// If we have update set fields, use specific order: sys_id, name, scope
	if hasUpdateSetFields {
		return []string{"sys_id", "name", "scope"}
	}

	// Define preferred column order for other tables
	preferred := []string{"name", "sys_id", "scope", "label", "state"}

	// Collect all unique columns from data
	allCols := make(map[string]bool)
	for _, row := range data {
		for col := range row {
			// Skip internal fields
			if col != "link" {
				allCols[col] = true
			}
		}
	}

	// Build ordered list based on preferred order
	var columns []string
	for _, col := range preferred {
		if allCols[col] {
			columns = append(columns, col)
			delete(allCols, col)
		}
	}

	// Add remaining columns alphabetically
	var remaining []string
	for col := range allCols {
		remaining = append(remaining, col)
	}
	for i := 0; i < len(remaining)-1; i++ {
		for j := i + 1; j < len(remaining); j++ {
			if remaining[i] > remaining[j] {
				remaining[i], remaining[j] = remaining[j], remaining[i]
			}
		}
	}
	columns = append(columns, remaining...)

	return columns
}

// writeStyledTable outputs data as styled table using lipgloss.
func (w *Writer) writeStyledTable(data []map[string]any) error {
	if len(data) == 0 {
		fmt.Fprintln(w.opts.Writer, "(no results)")
		return nil
	}

	// Detect columns from data
	columns := detectColumns(data)

	// Check if this is update set format (sys_id, name, scope)
	isUpdateSetFormat := len(columns) == 3 && columns[0] == "sys_id" && columns[1] == "name" && columns[2] == "scope"

	// Check if we have links
	hasLinks := false
	for _, row := range data {
		if link, ok := row["link"].(string); ok && link != "" {
			_ = link
			hasLinks = true
			break
		}
	}

	// Basecamp brand color (#e8a217)
	brandColor := lipgloss.Color("#e8a217")

	// Define styles
	nameStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(brandColor)

	mutedStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("#888888"))

	cellStyle := lipgloss.NewStyle()

	// Calculate column widths
	widths := make(map[string]int)
	for _, col := range columns {
		widths[col] = len(col)
	}
	for _, row := range data {
		for _, col := range columns {
			if val, ok := row[col]; ok {
				s := fmt.Sprintf("%v", val)
				if len(s) > widths[col] && len(s) <= 40 {
					widths[col] = len(s)
				}
			}
		}
	}
	// Cap name column width
	if widths["name"] > 35 {
		widths["name"] = 35
	}

	// Print rows
	for _, row := range data {
		var parts []string

		if isUpdateSetFormat {
			// Update set format: sys_id (muted), name (highlighted), scope (muted)

			// sys_id column (muted, truncated)
			sysID := fmt.Sprintf("%v", row["sys_id"])
			if len(sysID) > 8 {
				sysID = sysID[:8]
			}
			parts = append(parts, mutedStyle.Render(fmt.Sprintf("%-*s", widths["sys_id"], sysID)))

			// name column (highlighted) with hyperlink
			name := fmt.Sprintf("%v", row["name"])
			if len(name) > widths["name"] {
				name = name[:widths["name"]-3] + "..."
			}

			if hasLinks {
				if link, ok := row["link"].(string); ok && link != "" {
					// OSC 8 hyperlink with styled text
					name = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, nameStyle.Render(name))
					parts = append(parts, name)
				} else {
					parts = append(parts, nameStyle.Render(fmt.Sprintf("%-*s", widths["name"], name)))
				}
			} else {
				parts = append(parts, nameStyle.Render(fmt.Sprintf("%-*s", widths["name"], name)))
			}

			// scope column (muted)
			val := ""
			if v, ok := row["scope"]; ok && v != nil {
				val = fmt.Sprintf("%v", v)
			}
			if len(val) > 40 {
				val = val[:37] + "..."
			}
			parts = append(parts, mutedStyle.Render(fmt.Sprintf("%-*s", widths["scope"], val)))

		} else {
			// Standard format: name column first
			name := fmt.Sprintf("%v", row["name"])
			if len(name) > widths["name"] {
				name = name[:widths["name"]-3] + "..."
			}

			if hasLinks {
				if link, ok := row["link"].(string); ok && link != "" {
					// OSC 8 hyperlink with styled text
					name = fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, nameStyle.Render(name))
					parts = append(parts, name)
				} else {
					parts = append(parts, nameStyle.Render(name))
				}
			} else {
				parts = append(parts, nameStyle.Render(fmt.Sprintf("%-*s", widths["name"], name)))
			}

			// Other columns
			for _, col := range columns[1:] {
				val := ""
				if v, ok := row[col]; ok && v != nil {
					val = fmt.Sprintf("%v", v)
				}
				if len(val) > 40 {
					val = val[:37] + "..."
				}

				if col == "scope" {
					parts = append(parts, mutedStyle.Render(fmt.Sprintf("%-*s", widths[col], val)))
				} else {
					parts = append(parts, cellStyle.Render(fmt.Sprintf("%-*s", widths[col], val)))
				}
			}
		}

		fmt.Fprintln(w.opts.Writer, strings.Join(parts, "  "))
	}

	return nil
}

// writeStyledError outputs error with styling.
func (w *Writer) writeStyledError(resp *ErrorResponse) error {
	fmt.Fprintf(w.opts.Writer, "Error (%s): %s\n", resp.Code, resp.Error)
	if resp.Hint != "" {
		fmt.Fprintf(w.opts.Writer, "Hint: %s\n", resp.Hint)
	}
	return nil
}

// writeJQ applies jq filter to response and outputs result.
func (w *Writer) writeJQ(resp *Response) error {
	data, err := toMap(resp)
	if err != nil {
		return w.writeJSON(resp)
	}

	iter := w.jq.Run(data)
	for {
		v, ok := iter.Next()
		if !ok {
			break
		}
		enc := json.NewEncoder(w.opts.Writer)
		enc.SetIndent("", "  ")
		if err := enc.Encode(v); err != nil {
			return err
		}
	}
	return nil
}

// writeJQDataOnly applies jq filter to data only.
func (w *Writer) writeJQDataOnly(data any) error {
	iter := w.jq.Run(data)
	for {
		v, ok := iter.Next()
		if !ok {
			break
		}
		enc := json.NewEncoder(w.opts.Writer)
		enc.SetIndent("", "  ")
		if err := enc.Encode(v); err != nil {
			return err
		}
	}
	return nil
}

// toMap converts a struct to map[string]any using JSON marshaling.
func toMap(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// IsTTY returns true if the writer is a terminal.
func IsTTY(w io.Writer) bool {
	if f, ok := w.(*os.File); ok {
		info, err := f.Stat()
		if err != nil {
			return false
		}
		return info.Mode()&os.ModeCharDevice != 0
	}
	return false
}

// BrandColor is the basecamp brand yellow/gold color.
var BrandColor = lipgloss.Color("#e8a217")

// FormatFromString converts string format name to Format.
func FormatFromString(s string) Format {
	switch s {
	case "json":
		return FormatJSON
	case "markdown", "md":
		return FormatMarkdown
	case "styled":
		return FormatStyled
	case "quiet":
		return FormatQuiet
	default:
		return FormatAuto
	}
}

// Error functions remain for backward compatibility
func ErrUsage(message string) error {
	return fmt.Errorf("usage: %s", message)
}

func ErrAuth(message string) error {
	return fmt.Errorf("auth: %s", message)
}

func ErrNotFound(message string) error {
	return fmt.Errorf("not found: %s", message)
}

func ErrAPI(statusCode int, message string) error {
	return fmt.Errorf("api error %d: %s", statusCode, message)
}

func ErrNetwork(err error) error {
	return fmt.Errorf("network: %w", err)
}
