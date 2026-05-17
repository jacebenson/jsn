// Package output provides response formatting and error handling.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/itchyny/gojq"
)

// Hyperlink creates an OSC 8 terminal hyperlink.
// Returns text unchanged if url is empty.
func Hyperlink(text, url string) string {
	if url == "" {
		return text
	}
	// OSC 8 hyperlink format: \e]8;;URLe\\text\e]8;;\e\\
	// Using BEL (\x07) instead of ST (\x1b\\) for compatibility
	return "\x1b]8;;" + url + "\x07" + text + "\x1b]8;;\x07"
}

// stripAnsi removes ANSI escape sequences from a string.
func stripAnsi(s string) string {
	var result []rune
	inEscape := false
	inOsc := false
	for _, r := range s {
		if inEscape {
			if r == '[' {
				// CSI sequence, continue until letter
				inEscape = true
			} else if r == ']' {
				// OSC sequence, end with BEL or ST
				inOsc = true
			} else if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				inEscape = false
			}
			continue
		}
		if inOsc {
			if r == '\x07' {
				// BEL terminates OSC
				inOsc = false
			} else if r == '\x1b' {
				// ESC might start ST sequence (ESC \
				inOsc = false
				inEscape = true
			}
			continue
		}
		if r == '\x1b' {
			inEscape = true
			continue
		}
		result = append(result, r)
	}
	return string(result)
}

// visibleWidth returns the display width of a string (excluding ANSI escapes).
func visibleWidth(s string) int {
	return len(stripAnsi(s))
}

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

// GetFormat returns the current output format.
func (w *Writer) GetFormat() Format {
	return w.opts.Format
}

// Response is the success envelope for JSON output.
type Response struct {
	OK          bool           `json:"ok"`
	Data        any            `json:"data,omitempty"`
	Summary     string         `json:"summary,omitempty"`
	Notice      string         `json:"notice,omitempty"`
	Breadcrumbs []Breadcrumb   `json:"breadcrumbs,omitempty"`
	Context     map[string]any `json:"context,omitempty"`
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

// Breadcrumb is a suggested follow-up action.
type Breadcrumb struct {
	Action      string `json:"action"`
	Cmd         string `json:"cmd"`
	Description string `json:"description"`
}

// ResponseOption modifies a Response.
type ResponseOption func(*Response)

// WithSummary adds a summary to the response.
func WithSummary(s string) ResponseOption {
	return func(r *Response) { r.Summary = s }
}

// WithNotice adds a notice to the response.
func WithNotice(s string) ResponseOption {
	return func(r *Response) { r.Notice = s }
}

// WithBreadcrumbs adds breadcrumbs to the response.
func WithBreadcrumbs(b ...Breadcrumb) ResponseOption {
	return func(r *Response) { r.Breadcrumbs = append(r.Breadcrumbs, b...) }
}

// WithoutBreadcrumbs removes all breadcrumbs.
func WithoutBreadcrumbs() ResponseOption {
	return func(r *Response) { r.Breadcrumbs = nil }
}

// WithContext adds context to the response.
func WithContext(key string, value any) ResponseOption {
	return func(r *Response) {
		if r.Context == nil {
			r.Context = make(map[string]any)
		}
		r.Context[key] = value
	}
}

// WithMeta adds metadata to the response.
func WithMeta(key string, value any) ResponseOption {
	return func(r *Response) {
		if r.Meta == nil {
			r.Meta = make(map[string]any)
		}
		r.Meta[key] = value
	}
}

// OK outputs a success response.
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
		if isTTY(w.opts.Writer) {
			return w.writeStyled(resp)
		}
		return w.writeJSON(resp)
	}
}

// Err outputs an error response.
func (w *Writer) Err(err error) error {
	e := AsError(err)
	resp := &ErrorResponse{
		OK:    false,
		Error: e.Message,
		Code:  e.Code,
		Hint:  e.Hint,
	}

	switch w.opts.Format {
	case FormatJSON, FormatQuiet:
		return w.writeJSONError(resp)
	case FormatMarkdown:
		return w.writeMarkdownError(resp)
	default:
		if isTTY(w.opts.Writer) {
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

	// Handle data
	switch data := resp.Data.(type) {
	case []map[string]any:
		if err := w.writeMarkdownTable(data); err != nil {
			return err
		}
	case map[string]any:
		// Check for "records" key (common wrapper format for list commands)
		if records, ok := data["records"].([]map[string]string); ok && len(records) > 0 {
			// Convert []map[string]string to []map[string]any for the table writer
			converted := make([]map[string]any, len(records))
			for i, r := range records {
				converted[i] = make(map[string]any)
				for k, v := range r {
					converted[i][k] = v
				}
			}
			if err := w.writeMarkdownTable(converted); err != nil {
				return err
			}
		} else if records, ok := data["records"].([]any); ok && len(records) > 0 {
			// Handle []any format
			converted := make([]map[string]any, 0, len(records))
			for _, r := range records {
				if m, ok := r.(map[string]any); ok {
					converted = append(converted, m)
				}
			}
			if len(converted) > 0 {
				if err := w.writeMarkdownTable(converted); err != nil {
					return err
				}
			} else {
				fmt.Fprintln(w.opts.Writer, "(no results)")
			}
		} else {
			// For single records or other data, print as code block
			enc := json.NewEncoder(w.opts.Writer)
			enc.SetIndent("", "  ")
			fmt.Fprintln(w.opts.Writer, "```json")
			_ = enc.Encode(data)
			fmt.Fprintln(w.opts.Writer, "```")
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

	// Detect columns from first row
	var columns []string
	if len(data) > 0 {
		for k := range data[0] {
			columns = append(columns, k)
		}
	}

	// Header
	fmt.Fprint(w.opts.Writer, "| ")
	for _, col := range columns {
		fmt.Fprintf(w.opts.Writer, "%s | ", col)
	}
	fmt.Fprintln(w.opts.Writer)

	// Separator
	fmt.Fprint(w.opts.Writer, "| ")
	for _, col := range columns {
		for i := 0; i < len(col); i++ {
			fmt.Fprint(w.opts.Writer, "-")
		}
		fmt.Fprint(w.opts.Writer, " | ")
	}
	fmt.Fprintln(w.opts.Writer)

	// Rows
	for _, row := range data {
		fmt.Fprint(w.opts.Writer, "| ")
		for _, col := range columns {
			val := formatMarkdownValue(row[col])
			fmt.Fprintf(w.opts.Writer, "%s | ", val)
		}
		fmt.Fprintln(w.opts.Writer)
	}

	return nil
}

// formatMarkdownValue formats a value for markdown display.
// Handles reference fields (maps with display_value/value) and other types.
func formatMarkdownValue(v any) string {
	if v == nil {
		return ""
	}

	switch val := v.(type) {
	case string:
		return val
	case map[string]any:
		// Reference field - prefer display_value, fall back to value
		if display, ok := val["display_value"].(string); ok && display != "" {
			return display
		}
		if value, ok := val["value"].(string); ok {
			return value
		}
		return fmt.Sprintf("%v", v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// writeMarkdownError outputs error as markdown.
func (w *Writer) writeMarkdownError(resp *ErrorResponse) error {
	fmt.Fprintf(w.opts.Writer, "**Error (%s)**: %s\n", resp.Code, resp.Error)
	if resp.Hint != "" {
		fmt.Fprintf(w.opts.Writer, "\n*Hint: %s*\n", resp.Hint)
	}
	return nil
}

// writeStyled outputs ANSI styled terminal output.
func (w *Writer) writeStyled(resp *Response) error {
	// Check for pre-formatted output - if present, don't print summary
	// as the formatted output is self-contained
	hasFormatted := false
	if data, ok := resp.Data.(map[string]any); ok {
		if formatted, ok := data["_formatted"].(string); ok && formatted != "" {
			hasFormatted = true
		}
	}

	if resp.Summary != "" && !hasFormatted {
		fmt.Fprintln(w.opts.Writer, resp.Summary)
		fmt.Fprintln(w.opts.Writer)
	}

	// Handle data
	switch data := resp.Data.(type) {
	case []map[string]any:
		for _, row := range data {
			// Print first value as primary
			for _, v := range row {
				fmt.Fprintf(w.opts.Writer, "%v\n", v)
				break
			}
		}
	case map[string]any:
		// Check for pre-formatted output from commands
		if formatted, ok := data["_formatted"].(string); ok && formatted != "" {
			fmt.Fprint(w.opts.Writer, formatted)
			// Still fall through to process breadcrumbs
		} else if resp.Summary == "" {
			// For map data with a summary, don't print the raw map
			// The summary already conveys the message to the user
			fmt.Fprintf(w.opts.Writer, "%v\n", data)
		}

		// Special case: single record display - show in a nice formatted view
		if isRecord, table := detectRecord(data); isRecord {
			// Prefer table from _context if available (it's explicitly set by commands)
			if ctx, ok := data["_context"].(map[string]any); ok {
				if t, ok := ctx["table"].(string); ok && t != "" {
					table = t
				}
			}
			w.writeFormattedRecord(data, table)
		}

		// Special case: profiles list - show the profiles
		if profiles, ok := data["profiles"].([]map[string]any); ok && len(profiles) > 0 {
			fmt.Fprintln(w.opts.Writer)
			for _, p := range profiles {
				instance := p["instance"].(string)
				isDefault := p["default"].(bool)
				isAuth := p["authenticated"].(bool)
				username := ""
				if u, ok := p["username"].(string); ok {
					username = u
				}

				prefix := "  "
				if isDefault {
					prefix = "* "
				}

				status := "✗"
				if isAuth {
					status = "✓"
				}

				if username != "" {
					fmt.Fprintf(w.opts.Writer, "%s%s %s (as %s)\n", prefix, status, instance, username)
				} else {
					fmt.Fprintf(w.opts.Writer, "%s%s %s\n", prefix, status, instance)
				}
			}
		}

		// Special case: records list - show the records in a table format
		if records, ok := data["records"].([]map[string]string); ok && len(records) > 0 {
			w.writeRecordsTable(data, records)
		} else if recordsAny, ok := data["records"].([]map[string]any); ok && len(recordsAny) > 0 {
			// Convert []map[string]any to []map[string]string
			records := make([]map[string]string, len(recordsAny))
			for i, r := range recordsAny {
				records[i] = make(map[string]string)
				for k, v := range r {
					records[i][k] = fmt.Sprintf("%v", v)
				}
			}
			w.writeRecordsTable(data, records)
		}
	default:
		// Only print data if no summary (avoid duplication)
		if resp.Summary == "" {
			fmt.Fprintf(w.opts.Writer, "%v\n", data)
		}
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

// writeRecordsTable outputs records in a simple table format.
func (w *Writer) writeRecordsTable(data map[string]any, records []map[string]string) {
	columns, _ := data["columns"].([]string)
	if len(columns) == 0 && len(records) > 0 {
		// Try to get columns from first record
		for k := range records[0] {
			columns = append(columns, k)
		}
	}

	// Get table name for building URLs
	table := ""
	if t, ok := data["table"].(string); ok {
		table = t
	}

	// Get instance URL from context if available
	instanceURL := ""
	if ctx, ok := data["context"].(map[string]any); ok {
		if u, ok := ctx["instance_url"].(string); ok {
			instanceURL = u
		}
	}

	// Fixed column widths for simplicity
	colWidths := map[string]int{
		"number":            14,
		"short_description": 48,
		"priority":          14,
		"state":             10,
		"assigned_to":       15,
		"risk":              10,
		"name":              30,
		"user_name":         15,
		"email":             30,
		"sys_id":            32,
		"sys_updated_on":    22,
		"sys_created_on":    22,
		"opened_at":         22,
		"closed_at":         22,
		"sys_updated_by":    20,
		"sys_created_by":    20,
		"opened_by":         20,
		"u_category":        20,
		"u_subcategory":     20,
	}

	fmt.Fprintln(w.opts.Writer)

	// Print header with manual padding
	for _, col := range columns {
		width := colWidths[col]
		if width == 0 {
			width = 20
		}
		fmt.Fprint(w.opts.Writer, col)
		padding := width - len(col)
		for i := 0; i < padding; i++ {
			fmt.Fprint(w.opts.Writer, " ")
		}
		fmt.Fprint(w.opts.Writer, "  ")
	}
	fmt.Fprintln(w.opts.Writer)

	// Print separator
	for _, col := range columns {
		width := colWidths[col]
		if width == 0 {
			width = 20
		}
		for i := 0; i < width; i++ {
			fmt.Fprint(w.opts.Writer, "-")
		}
		fmt.Fprint(w.opts.Writer, "  ")
	}
	fmt.Fprintln(w.opts.Writer)

	// Print rows (limit to 20 for display)
	displayLimit := 20
	if len(records) < displayLimit {
		displayLimit = len(records)
	}
	for i := 0; i < displayLimit; i++ {
		record := records[i]
		for j, col := range columns {
			val := record[col]
			width := colWidths[col]
			if width == 0 {
				width = 20
			}

			// Make first column a hyperlink if we have instance URL
			if j == 0 && instanceURL != "" && table != "" {
				url := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, record["sys_id"])
				val = Hyperlink(val, url)
			}

			// Truncate if needed (account for ANSI sequences)
			visibleVal := stripAnsi(val)
			if len(visibleVal) > width {
				// Find the byte position to truncate at (respecting multibyte chars)
				truncated := visibleVal[:width-3] + "..."
				// Re-add hyperlink if present
				if val != visibleVal {
					if j == 0 && instanceURL != "" && table != "" {
						url := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, record["sys_id"])
						val = Hyperlink(truncated, url)
					} else {
						val = truncated
					}
				} else {
					val = truncated
				}
				visibleVal = truncated
			}

			// Pad manually to handle ANSI sequences correctly
			fmt.Fprint(w.opts.Writer, val)
			padding := width - len(visibleVal)
			for k := 0; k < padding; k++ {
				fmt.Fprint(w.opts.Writer, " ")
			}
			fmt.Fprint(w.opts.Writer, "  ")
		}
		fmt.Fprintln(w.opts.Writer)
	}
	if len(records) > displayLimit {
		fmt.Fprintf(w.opts.Writer, "\n... and %d more\n", len(records)-displayLimit)
	}
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
	return isTTY(w)
}

// isTTY returns true if the writer is a terminal.
func isTTY(w io.Writer) bool {
	if f, ok := w.(*os.File); ok {
		info, err := f.Stat()
		if err != nil {
			return false
		}
		return info.Mode()&os.ModeCharDevice != 0
	}
	return false
}

// EffectiveFormat returns the current format (resolving auto).
func (w *Writer) EffectiveFormat() Format {
	if w.opts.Format == FormatAuto {
		if isTTY(w.opts.Writer) {
			return FormatStyled
		}
		return FormatJSON
	}
	return w.opts.Format
}

// detectRecord checks if data is a ServiceNow record and returns the table name.
func detectRecord(data map[string]any) (bool, string) {
	// Check for common ServiceNow record fields
	hasSysID := false
	hasSysClass := false
	tableName := ""

	if _, ok := data["sys_id"]; ok {
		hasSysID = true
	}
	if sc, ok := data["sys_class_name"]; ok {
		hasSysClass = true
		if scMap, ok := sc.(map[string]any); ok {
			if dv, ok := scMap["display_value"].(string); ok {
				tableName = dv
			}
		} else if scStr, ok := sc.(string); ok {
			tableName = scStr
		}
	}

	// If no sys_class_name, try to infer from number field
	if tableName == "" {
		if num, ok := data["number"]; ok {
			if numMap, ok := num.(map[string]any); ok {
				if numStr, ok := numMap["display_value"].(string); ok && len(numStr) > 3 {
					prefix := numStr[:3]
					switch prefix {
					case "INC":
						tableName = "incident"
					case "CHG":
						tableName = "change_request"
					case "RIT":
						tableName = "sc_req_item"
					case "SCT":
						tableName = "sc_task"
					case "PRB":
						tableName = "problem"
					}
				}
			}
		}
	}

	// If we detected the table from number prefix, consider it a valid record
	isRecord := hasSysID && (hasSysClass || tableName != "")

	return isRecord, tableName
}

// writeFormattedRecord outputs a single record in a nicely formatted view.
func (w *Writer) writeFormattedRecord(data map[string]any, table string) {
	// Get instance URL from context if available
	instanceURL := ""
	if ctx, ok := data["_context"].(map[string]any); ok {
		if url, ok := ctx["instance_url"].(string); ok {
			instanceURL = url
		}
		delete(data, "_context")
	}

	// Get number/title for header
	title := ""
	if num, ok := data["number"]; ok {
		title = getDisplayValue(num)
	}
	if title == "" && table != "" {
		title = table
	}

	fmt.Fprintf(w.opts.Writer, "\n%s (%s)\n\n", title, table)

	// Define field groupings similar to original jsn
	groups := map[string][]string{
		"Core": {"number", "sys_id", "sys_class_name", "state", "active",
			"short_description", "description", "priority", "urgency", "impact", "risk", "type"},
		"People": {"opened_by", "assigned_to", "assignment_group", "closed_by",
			"requested_by", "additional_assignee_list", "watch_list"},
		"Status": {"approval", "approval_set", "approval_history", "escalation",
			"made_sla", "on_hold", "on_hold_reason"},
		"Dates & Times": {"opened_at", "sys_created_on", "sys_updated_on", "closed_at",
			"work_start", "work_end", "due_date", "expected_start", "sla_due", "activity_due"},
		"System": {"sys_domain", "sys_domain_path", "sys_created_by", "sys_updated_by",
			"sys_mod_count", "sys_tags"},
	}

	// Track which fields we've displayed
	displayed := make(map[string]bool)

	// Display grouped fields
	for groupName, fields := range groups {
		hasFields := false
		groupContent := ""

		for _, field := range fields {
			if val, ok := data[field]; ok {
				displayed[field] = true
				if !hasFields {
					hasFields = true
					groupContent = fmt.Sprintf("─ %s ─\n", groupName)
				}
				displayVal := getDisplayValue(val)
				if displayVal != "" || field == "description" || field == "short_description" {
					// Format multi-line values
					if strings.Contains(displayVal, "\n") {
						lines := strings.Split(displayVal, "\n")
						groupContent += fmt.Sprintf("  %s:\n", field)
						for _, line := range lines {
							groupContent += fmt.Sprintf("    %s\n", line)
						}
					} else {
						groupContent += fmt.Sprintf("  %s:  %s\n", field, displayVal)
					}
				}
			}
		}

		if hasFields {
			fmt.Fprint(w.opts.Writer, groupContent)
			fmt.Fprintln(w.opts.Writer)
		}
	}

	// Display remaining fields in "Other" group
	otherFields := []string{}
	for field := range data {
		if !displayed[field] && !strings.HasPrefix(field, "_") {
			otherFields = append(otherFields, field)
		}
	}
	sort.Strings(otherFields)

	if len(otherFields) > 0 {
		fmt.Fprintln(w.opts.Writer, "─ Other ─")
		for _, field := range otherFields {
			displayVal := getDisplayValue(data[field])
			if strings.Contains(displayVal, "\n") {
				lines := strings.Split(displayVal, "\n")
				fmt.Fprintf(w.opts.Writer, "  %s:\n", field)
				for _, line := range lines {
					fmt.Fprintf(w.opts.Writer, "    %s\n", line)
				}
			} else {
				fmt.Fprintf(w.opts.Writer, "  %s:  %s\n", field, displayVal)
			}
		}
		fmt.Fprintln(w.opts.Writer)
	}

	// Add link to record
	if instanceURL != "" && table != "" {
		if sysID := getDisplayValue(data["sys_id"]); sysID != "" {
			// Convert table name to URL format (lowercase with underscores)
			urlTable := strings.ToLower(strings.ReplaceAll(table, " ", "_"))
			recordURL := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, urlTable, sysID)
			fmt.Fprintf(w.opts.Writer, "Link:  %s\n\n", recordURL)
		}
	}

	// Display related ACL roles if present
	if relatedRoles, ok := data["_related_roles"].([]map[string]any); ok && len(relatedRoles) > 0 {
		fmt.Fprintln(w.opts.Writer, "─ Related Roles ─")
		for _, role := range relatedRoles {
			// ACL role references sys_user_role via sys_user_role field (not "role")
			roleName := ""
			// Try sys_user_role field first (this is the reference to the actual role)
			if roleField, ok := role["sys_user_role"].(map[string]any); ok {
				if dv, ok := roleField["display_value"].(string); ok && dv != "" {
					roleName = dv
				} else if v, ok := roleField["value"].(string); ok && v != "" {
					roleName = v
				}
			}
			// Fallback to old "role" field name if sys_user_role not found
			if roleName == "" {
				if roleField, ok := role["role"].(map[string]any); ok {
					if dv, ok := roleField["display_value"].(string); ok && dv != "" {
						roleName = dv
					} else if v, ok := roleField["value"].(string); ok && v != "" {
						roleName = v
					}
				}
			}
			if roleName == "" {
				roleName = getDisplayValue(role["sys_user_role"])
			}
			if roleName == "" {
				roleName = getDisplayValue(role["role"])
			}
			if roleName == "" {
				if n, ok := role["name"].(string); ok && n != "" {
					roleName = n
				}
			}
			if roleName == "" {
				roleName = "(unnamed)"
			}
			active := getDisplayValue(role["active"])
			if active == "false" {
				fmt.Fprintf(w.opts.Writer, "  • %s [inactive]\n", roleName)
			} else {
				fmt.Fprintf(w.opts.Writer, "  • %s\n", roleName)
			}
		}
		fmt.Fprintln(w.opts.Writer)
	}
}

// getDisplayValue extracts the display value from a ServiceNow field.
func getDisplayValue(val any) string {
	switch v := val.(type) {
	case string:
		return v
	case map[string]any:
		// ServiceNow display value object
		if dv, ok := v["display_value"].(string); ok && dv != "" {
			return dv
		}
		if val, ok := v["value"].(string); ok {
			return val
		}
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
	return ""
}
