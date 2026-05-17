// Package tui provides terminal UI components for interactive selection.
package tui

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// PickerItem represents a selectable item in the picker
type PickerItem struct {
	ID          string
	Title       string
	Description string
}

func (i PickerItem) String() string {
	return i.Title
}

// PageResult represents a page of items from a paginated API
type PageResult struct {
	Items      []PickerItem
	HasMore    bool
	TotalCount int // Total count if known, -1 if unknown
}

// PageFetcher fetches a page of items. offset is the starting index, limit is page size.
type PageFetcher func(ctx context.Context, offset, limit int) (*PageResult, error)

// QueryablePageFetcher is a fetcher that supports dynamic queries (for search-as-you-type)
// The query parameter is passed through and can modify the API call
type QueryablePageFetcher func(ctx context.Context, offset, limit int, query string) (*PageResult, error)

// PickerOption configures a picker
type PickerOption func(*pickerModel)

// WithPickerTitle sets the picker title
func WithPickerTitle(title string) PickerOption {
	return func(m *pickerModel) {
		m.title = title
	}
}

// WithEmptyMessage sets a custom message when no items
func WithEmptyMessage(msg string) PickerOption {
	return func(m *pickerModel) {
		m.emptyMessage = msg
	}
}

// WithAutoSelectSingle auto-selects if only one item
func WithAutoSelectSingle() PickerOption {
	return func(m *pickerModel) {
		m.autoSelectSingle = true
	}
}

// WithMaxVisible sets max visible items
func WithMaxVisible(n int) PickerOption {
	return func(m *pickerModel) {
		if n > 0 {
			m.maxVisible = n
		}
	}
}

// WithPageSize sets the page size for pagination
func WithPageSize(n int) PickerOption {
	return func(m *pickerModel) {
		if n > 0 {
			m.pageSize = n
		}
	}
}

// WithPageFetcher enables pagination with a fetcher function
func WithPageFetcher(fetcher PageFetcher, pageSize int) PickerOption {
	return func(m *pickerModel) {
		m.fetcher = fetcher
		m.pageSize = pageSize
		if m.pageSize <= 0 {
			m.pageSize = 50
		}
	}
}

// WithQueryablePageFetcher enables pagination with a fetcher that supports dynamic queries
// This is used for search-as-you-type functionality where typing letters triggers new API queries
func WithQueryablePageFetcher(fetcher QueryablePageFetcher, pageSize int) PickerOption {
	return func(m *pickerModel) {
		m.queryableFetcher = fetcher
		m.pageSize = pageSize
		if m.pageSize <= 0 {
			m.pageSize = 50
		}
	}
}

// pickerModel is the bubbletea model
type pickerModel struct {
	items            []PickerItem
	filtered         []PickerItem
	cursor           int
	selected         *PickerItem
	quitting         bool
	title            string
	emptyMessage     string
	maxVisible       int
	scrollOffset     int
	autoSelectSingle bool
	styles           pickerStyles

	// Pagination
	fetcher          PageFetcher
	queryableFetcher QueryablePageFetcher // For dynamic query support
	pageSize         int
	offset           int
	hasMore          bool
	loadingMore      bool
	totalCount       int
	ctx              context.Context

	// Filter state
	jumpMode   bool   // true when in type-to-filter mode
	jumpBuffer string // buffer for typed filter text
}

type pickerStyles struct {
	Header      lipgloss.Style
	Cursor      lipgloss.Style
	Selected    lipgloss.Style
	Body        lipgloss.Style
	Muted       lipgloss.Style
	Description lipgloss.Style
	Loading     lipgloss.Style
}

// Message types for pagination
type itemsLoadedMsg struct {
	items   []PickerItem
	hasMore bool
	total   int
	err     error
	isReset bool // true when this replaces all items (query change), false when appending
}

func newPickerModel(items []PickerItem, opts ...PickerOption) pickerModel {
	// Brand color (#e8a217)
	brandColor := lipgloss.Color("#e8a217")

	m := pickerModel{
		items:        items,
		filtered:     items,
		title:        "Select an item",
		maxVisible:   20,
		emptyMessage: "No items found",
		pageSize:     50,
		hasMore:      false,
		totalCount:   len(items),
		ctx:          context.Background(),
		styles: pickerStyles{
			Header:      lipgloss.NewStyle().Bold(true).Foreground(brandColor),
			Cursor:      lipgloss.NewStyle().Foreground(brandColor),
			Selected:    lipgloss.NewStyle().Bold(true),
			Body:        lipgloss.NewStyle(),
			Muted:       lipgloss.NewStyle().Foreground(lipgloss.Color("#888888")),
			Description: lipgloss.NewStyle().Foreground(lipgloss.Color("#888888")),
			Loading:     lipgloss.NewStyle().Foreground(brandColor).Italic(true),
		},
	}

	for _, opt := range opts {
		opt(&m)
	}

	return m
}

func (m pickerModel) Init() tea.Cmd {
	// If we have a fetcher but no items, load first page
	if m.fetcher != nil && len(m.items) == 0 {
		return m.loadMoreItems()
	}
	// If we have a queryable fetcher but no items, load first page with empty query
	if m.queryableFetcher != nil && len(m.items) == 0 {
		return m.loadWithQuery("", 0, true)
	}
	return nil
}

func (m *pickerModel) loadMoreItems() tea.Cmd {
	// Don't load if already loading or no more data
	if m.loadingMore || !m.hasMore {
		return nil
	}

	// Prefer queryable fetcher if available
	if m.queryableFetcher != nil {
		query := ""
		if m.jumpBuffer != "" {
			query = m.jumpBuffer
		}
		// Pass false for isReset because we're appending (pagination)
		return m.loadWithQuery(query, m.offset, false)
	}

	// Fall back to regular fetcher
	if m.fetcher == nil {
		return nil
	}

	m.loadingMore = true
	offset := m.offset

	return func() tea.Msg {
		result, err := m.fetcher(m.ctx, offset, m.pageSize)
		if err != nil {
			return itemsLoadedMsg{err: err}
		}
		return itemsLoadedMsg{
			items:   result.Items,
			hasMore: result.HasMore,
			total:   result.TotalCount,
			isReset: false, // Append mode for pagination
		}
	}
}

// loadWithQuery reloads items with a query
// isReset=true: replaces all items (new search)
// isReset=false: appends items (pagination)
func (m *pickerModel) loadWithQuery(query string, offset int, isReset bool) tea.Cmd {
	if m.queryableFetcher == nil || m.loadingMore {
		return nil
	}

	m.loadingMore = true

	return func() tea.Msg {
		result, err := m.queryableFetcher(m.ctx, offset, m.pageSize, query)
		if err != nil {
			return itemsLoadedMsg{err: err}
		}
		return itemsLoadedMsg{
			items:   result.Items,
			hasMore: result.HasMore,
			total:   result.TotalCount,
			isReset: isReset,
		}
	}
}

func (m pickerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case itemsLoadedMsg:
		m.loadingMore = false
		if msg.err != nil {
			// Just log error and continue with what we have
			return m, nil
		}

		if msg.isReset {
			// Replace all items (query changed)
			m.items = msg.items
			m.filtered = msg.items
			m.offset = len(msg.items)
			m.cursor = 0
			m.scrollOffset = 0
		} else {
			// Append new items (pagination)
			m.items = append(m.items, msg.items...)
			// Re-apply active filter to include new items, preserving cursor
			savedCursor := m.cursor
			savedScroll := m.scrollOffset
			if m.jumpMode && m.jumpBuffer != "" {
				m.jumpToLetter()
			} else {
				m.filtered = m.items
			}
			m.cursor = savedCursor
			m.scrollOffset = savedScroll
			m.offset = len(m.items)
		}
		m.hasMore = msg.hasMore
		if msg.total > 0 {
			m.totalCount = msg.total
		}
		return m, nil

	case tea.KeyMsg:
		// Handle jump mode
		if m.jumpMode {
			switch msg.String() {
			case "esc", "ctrl+c":
				m.jumpMode = false
				m.jumpBuffer = ""
				// If we have a queryable fetcher, reload without query to reset
				if m.queryableFetcher != nil {
					return m, m.loadWithQuery("", 0, true)
				}
				m.filtered = m.items
				m.cursor = 0
				m.scrollOffset = 0
				return m, nil
			case "enter":
				// Select the currently highlighted item
				if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
					m.selected = &m.filtered[m.cursor]
					return m, tea.Quit
				}
				// If nothing to select, just clear jump mode
				m.jumpMode = false
				m.jumpBuffer = ""
				if m.queryableFetcher != nil {
					return m, m.loadWithQuery("", 0, true)
				}
				m.filtered = m.items
				m.cursor = 0
				m.scrollOffset = 0
				return m, nil
			case "backspace":
				if len(m.jumpBuffer) > 0 {
					m.jumpBuffer = m.jumpBuffer[:len(m.jumpBuffer)-1]
					if m.jumpBuffer == "" {
						// Exit jump mode if buffer is empty
						m.jumpMode = false
						// Reload without query
						if m.queryableFetcher != nil {
							return m, m.loadWithQuery("", 0, true)
						}
						m.filtered = m.items
						m.cursor = 0
						m.scrollOffset = 0
					} else {
						// Reload with updated query (only if 2+ chars for server-side)
						if m.queryableFetcher != nil && len(m.jumpBuffer) >= 2 {
							return m, m.loadWithQuery(m.jumpBuffer, 0, true)
						}
						m.jumpToLetter()
					}
				}
				return m, nil
			default:
				// Allow any printable character in jump mode, including spaces/symbols.
				if isValidJumpInput(msg.String()) {
					m.jumpBuffer += msg.String()
					// If we have a queryable fetcher and 2+ chars, do server-side query
					// For 1 char, just do local filtering to avoid excessive API calls
					if m.queryableFetcher != nil && len(m.jumpBuffer) >= 2 {
						return m, m.loadWithQuery(m.jumpBuffer, 0, true)
					}
					// Otherwise fall back to local filtering
					m.jumpToLetter()
					return m, nil
				}
			}
		}

		// Normal mode
		switch msg.String() {
		case "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "esc":
			if len(m.filtered) < len(m.items) || m.jumpBuffer != "" {
				// Clear filter first
				m.jumpMode = false
				m.jumpBuffer = ""
				m.filtered = m.items
				m.cursor = 0
				m.scrollOffset = 0
				return m, nil
			}
			m.quitting = true
			return m, tea.Quit
		case "up":
			if m.cursor > 0 {
				m.cursor--
				m.adjustScroll()
			}
		case "down":
			// Move cursor down if possible
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
				m.adjustScroll()
			}

			// Check if we need to load more items (5 from bottom for smoother experience)
			// This runs even if we didn't move (e.g., at last item but more available)
			hasFetcher := m.fetcher != nil || m.queryableFetcher != nil
			if hasFetcher && m.hasMore && !m.loadingMore {
				itemsFromBottom := len(m.filtered) - m.cursor - 1
				if itemsFromBottom <= 5 {
					return m, m.loadMoreItems()
				}
			}
		case "enter":
			if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
				m.selected = &m.filtered[m.cursor]
				return m, tea.Quit
			}
		default:
			// Allow any printable character in jump mode, including spaces/symbols.
			if isValidJumpInput(msg.String()) {
				m.jumpMode = true
				m.jumpBuffer = msg.String()
				// If we have a queryable fetcher and 2+ chars, do server-side query
				// For 1 char, just do local filtering to avoid excessive API calls
				if m.queryableFetcher != nil && len(m.jumpBuffer) >= 2 {
					return m, m.loadWithQuery(m.jumpBuffer, 0, true)
				}
				// Otherwise fall back to local filtering
				m.jumpToLetter()
				return m, nil
			}
		}
	}
	return m, nil
}

func (m *pickerModel) adjustScroll() {
	// Adjust scroll offset to keep cursor visible
	if m.cursor < m.scrollOffset {
		m.scrollOffset = m.cursor
	} else if m.cursor >= m.scrollOffset+m.maxVisible {
		m.scrollOffset = m.cursor - m.maxVisible + 1
	}
	// Ensure scroll offset doesn't go negative
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

// jumpToLetter filters and jumps to items matching the jump buffer
func (m *pickerModel) jumpToLetter() {
	if m.jumpBuffer == "" {
		m.filtered = m.items
		m.cursor = 0
		m.scrollOffset = 0
		return
	}

	bufferLower := strings.ToLower(m.jumpBuffer)

	// Filter items to only those containing the jump buffer
	var filtered []PickerItem
	for _, item := range m.items {
		if strings.Contains(strings.ToLower(item.Title), bufferLower) ||
			strings.Contains(strings.ToLower(item.Description), bufferLower) {
			filtered = append(filtered, item)
		}
	}
	m.filtered = filtered
	m.cursor = 0
	m.scrollOffset = 0
}

// isValidJumpInput checks if a key input can be used for jump filtering.
// Allows any printable single rune (letters, numbers, spaces, symbols).
func isValidJumpInput(s string) bool {
	r := []rune(s)
	if len(r) != 1 {
		return false
	}
	return !unicode.IsControl(r[0])
}

func (m pickerModel) View() string {
	if m.quitting && m.selected == nil {
		return ""
	}

	var b strings.Builder

	// Title with mode indicators
	title := m.title
	if m.jumpMode {
		title = fmt.Sprintf("%s [jump: %s]", m.title, m.jumpBuffer)
	}
	b.WriteString(m.styles.Header.Render(title))
	b.WriteString("\n\n")

	// Items
	if len(m.filtered) == 0 && !m.loadingMore {
		if m.jumpMode && m.jumpBuffer != "" {
			b.WriteString(m.styles.Muted.Render(fmt.Sprintf("No items match '%s'", m.jumpBuffer)))
		} else {
			b.WriteString(m.styles.Muted.Render(m.emptyMessage))
		}
	} else {
		start := m.scrollOffset
		end := start + m.maxVisible
		if end > len(m.filtered) {
			end = len(m.filtered)
		}

		for i := start; i < end; i++ {
			item := m.filtered[i]
			cursor := "  "
			style := m.styles.Body

			if i == m.cursor {
				cursor = m.styles.Cursor.Render("> ")
				style = m.styles.Selected
			}

			line := cursor + style.Render(item.Title)
			if item.Description != "" {
				line += m.styles.Description.Render(" - " + item.Description)
			}
			b.WriteString(line + "\n")
		}

		// Pagination status line - shows visible range, loaded count, and total
		b.WriteString("\n")
		var statusParts []string

		// Visible range (e.g., "15-30")
		if len(m.filtered) > 0 {
			visibleEnd := end
			if m.loadingMore && visibleEnd < len(m.filtered) {
				visibleEnd = len(m.filtered)
			}
			statusParts = append(statusParts, fmt.Sprintf("%d-%d", start+1, visibleEnd))
		} else {
			statusParts = append(statusParts, "0")
		}

		// Loaded count
		statusParts = append(statusParts, fmt.Sprintf("of %d loaded", len(m.filtered)))

		// Total count (if known)
		if m.totalCount > 0 {
			statusParts = append(statusParts, fmt.Sprintf("(%d total)", m.totalCount))
		} else if m.hasMore {
			statusParts = append(statusParts, "(more available)")
		}

		status := strings.Join(statusParts, " ")
		b.WriteString(m.styles.Muted.Render(status))

		// Loading indicator
		if m.loadingMore {
			b.WriteString(" " + m.styles.Loading.Render("⟳ loading..."))
		}
	}

	// Help - context sensitive
	var helpText string
	if m.jumpMode {
		helpText = "type to jump/filter • backspace removes • esc/enter clear"
	} else {
		helpText = "↑ up • ↓ down • enter select • esc cancel • type to jump/filter"
		hasFetcher := m.fetcher != nil || m.queryableFetcher != nil
		if hasFetcher && m.hasMore {
			helpText += " • scroll to load more"
		}
	}
	b.WriteString("\n" + m.styles.Muted.Render(helpText))
	b.WriteString("\n")

	return b.String()
}

// Picker shows an interactive picker
type Picker struct {
	items   []PickerItem
	opts    []PickerOption
	fetcher PageFetcher
	ctx     context.Context
}

// NewPicker creates a new picker with items
func NewPicker(items []PickerItem, opts ...PickerOption) *Picker {
	return &Picker{
		items: items,
		opts:  opts,
		ctx:   context.Background(),
	}
}

// NewPickerWithFetcher creates a picker that loads items via pagination
func NewPickerWithFetcher(fetcher PageFetcher, opts ...PickerOption) *Picker {
	return &Picker{
		opts:    append([]PickerOption{WithPageFetcher(fetcher, 50)}, opts...),
		fetcher: fetcher,
		ctx:     context.Background(),
	}
}

// WithContext sets the context for the picker (for cancellation)
func (p *Picker) WithContext(ctx context.Context) *Picker {
	p.ctx = ctx
	return p
}

// Run shows the picker and returns the selected item
func (p *Picker) Run() (*PickerItem, error) {
	m := newPickerModel(p.items, p.opts...)
	m.ctx = p.ctx

	// Auto-select if only one item
	if m.autoSelectSingle && len(p.items) == 1 && !m.hasMore {
		return &p.items[0], nil
	}

	program := tea.NewProgram(m)

	finalModel, err := program.Run()
	if err != nil {
		return nil, err
	}

	final := finalModel.(pickerModel)
	if final.quitting {
		return nil, nil
	}
	return final.selected, nil
}

// Pick is a convenience function
func Pick(title string, items []PickerItem, opts ...PickerOption) (*PickerItem, error) {
	return NewPicker(items, append([]PickerOption{WithPickerTitle(title)}, opts...)...).Run()
}

// PickWithPagination is a convenience function for paginated picking
func PickWithPagination(title string, fetcher PageFetcher, opts ...PickerOption) (*PickerItem, error) {
	return NewPickerWithFetcher(fetcher, append([]PickerOption{WithPickerTitle(title)}, opts...)...).Run()
}

// QueryablePicker is a picker that supports dynamic queries for search-as-you-type
type QueryablePicker struct {
	fetcher QueryablePageFetcher
	opts    []PickerOption
	ctx     context.Context
}

// NewQueryablePicker creates a picker with a queryable fetcher
func NewQueryablePicker(fetcher QueryablePageFetcher, opts ...PickerOption) *QueryablePicker {
	return &QueryablePicker{
		fetcher: fetcher,
		opts:    append([]PickerOption{WithQueryablePageFetcher(fetcher, 50)}, opts...),
		ctx:     context.Background(),
	}
}

// WithContext sets the context for the picker
func (p *QueryablePicker) WithContext(ctx context.Context) *QueryablePicker {
	p.ctx = ctx
	return p
}

// Run shows the picker and returns the selected item
func (p *QueryablePicker) Run() (*PickerItem, error) {
	m := newPickerModel(nil, p.opts...)
	m.ctx = p.ctx
	m.queryableFetcher = p.fetcher

	// Load initial items
	program := tea.NewProgram(m)

	finalModel, err := program.Run()
	if err != nil {
		return nil, err
	}

	final := finalModel.(pickerModel)
	if final.quitting {
		return nil, nil
	}
	return final.selected, nil
}

// PickWithQueryablePagination is a convenience function for paginated picking with query support
// This enables search-as-you-type functionality where typing letters triggers new API queries
func PickWithQueryablePagination(title string, fetcher QueryablePageFetcher, opts ...PickerOption) (*PickerItem, error) {
	return NewQueryablePicker(fetcher, append([]PickerOption{WithPickerTitle(title)}, opts...)...).Run()
}
