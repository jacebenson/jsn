// Package tui provides terminal UI components for interactive selection.
package tui

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	tea "github.com/charmbracelet/bubbletea"
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
	fetcher     PageFetcher
	pageSize    int
	offset      int
	hasMore     bool
	loadingMore bool
	totalCount  int
	ctx         context.Context
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
	return nil
}

func (m pickerModel) loadMoreItems() tea.Cmd {
	if m.fetcher == nil || m.loadingMore || !m.hasMore && len(m.items) > 0 {
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

		// Append new items
		m.items = append(m.items, msg.items...)
		m.filtered = m.items // Reset filter
		m.offset = len(m.items)
		m.hasMore = msg.hasMore
		if msg.total > 0 {
			m.totalCount = msg.total
		}
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q", "esc":
			m.quitting = true
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
				m.adjustScroll()
			}
		case "down", "j":
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
				m.adjustScroll()

				// Check if we need to load more items (3 from bottom)
				if m.fetcher != nil && m.hasMore && !m.loadingMore {
					itemsFromBottom := len(m.filtered) - m.cursor - 1
					if itemsFromBottom <= 3 {
						return m, m.loadMoreItems()
					}
				}
			}
		case "enter":
			if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
				m.selected = &m.filtered[m.cursor]
				return m, tea.Quit
			}
		case "/":
			// Filter mode - clear current filter on next key
			return m, nil
		default:
			// Filter items based on typed text
			if len(msg.String()) == 1 {
				m.filterItems(msg.String())
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

func (m *pickerModel) filterItems(query string) {
	if query == "" {
		m.filtered = m.items
		return
	}

	queryLower := strings.ToLower(query)
	var filtered []PickerItem
	for _, item := range m.items {
		if strings.Contains(strings.ToLower(item.Title), queryLower) ||
			strings.Contains(strings.ToLower(item.Description), queryLower) {
			filtered = append(filtered, item)
		}
	}
	m.filtered = filtered
	m.cursor = 0
	m.scrollOffset = 0
}

func (m pickerModel) View() string {
	if m.quitting && m.selected == nil {
		return ""
	}

	var b strings.Builder

	// Title
	b.WriteString(m.styles.Header.Render(m.title))
	b.WriteString("\n\n")

	// Items
	if len(m.filtered) == 0 && !m.loadingMore {
		b.WriteString(m.styles.Muted.Render(m.emptyMessage))
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

		// Pagination info
		if m.totalCount > 0 || m.hasMore {
			b.WriteString("\n")
			var info string
			if m.totalCount > 0 {
				info = fmt.Sprintf("Showing %d-%d of %d", start+1, end, m.totalCount)
			} else {
				info = fmt.Sprintf("Showing %d-%d", start+1, end)
			}
			if m.hasMore {
				info += "+"
			}
			if m.loadingMore {
				info += " (loading...)"
			}
			b.WriteString(m.styles.Muted.Render(info))
		} else if len(m.filtered) > m.maxVisible {
			b.WriteString("\n")
			b.WriteString(m.styles.Muted.Render(
				fmt.Sprintf("Showing %d-%d of %d", start+1, end, len(m.filtered)),
			))
		}
	}

	// Help
	b.WriteString("\n" + m.styles.Muted.Render("↑/↓/jk navigate • enter select • esc cancel"))
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
	if m.autoSelectSingle && len(m.items) == 1 && !m.hasMore {
		return &m.items[0], nil
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

// PickUpdateSet shows a picker for update sets
func PickUpdateSet(updateSets []PickerItem) (*PickerItem, error) {
	return Pick("Select an update set", updateSets)
}

// PickTable shows a picker for tables
func PickTable(tables []PickerItem) (*PickerItem, error) {
	return Pick("Select a table", tables)
}

// SortWithCurrentFirst sorts items with current items first
func SortWithCurrentFirst(items []PickerItem, isCurrent func(PickerItem) bool) {
	for i := 0; i < len(items)-1; i++ {
		for j := i + 1; j < len(items); j++ {
			if isCurrent(items[j]) && !isCurrent(items[i]) {
				items[i], items[j] = items[j], items[i]
			}
		}
	}
}
