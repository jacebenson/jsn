// Package tui provides interactive terminal UI components.
package tui

import (
	"fmt"
	"io"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// IncidentItem represents an incident in the picker.
type IncidentItem struct {
	Number           string
	ShortDescription string
	Priority         string
	State            string
	AssignedTo       string
	SysID            string
	Index            int
}

// Title returns the display title for the list item (compact single-line format).
func (i IncidentItem) Title() string {
	// Compact format: ICON NUMBER DESC | STATE → ASSIGNED
	priorityIcon := getPriorityIcon(i.Priority)
	stateStr := formatState(i.State)

	// Truncate short description
	desc := i.ShortDescription
	if len(desc) > 35 {
		desc = desc[:32] + "..."
	}

	if i.AssignedTo != "" && i.AssignedTo != "null" {
		return fmt.Sprintf("%s %s  %s  | %s → %s", priorityIcon, i.Number, desc, stateStr, i.AssignedTo)
	}
	return fmt.Sprintf("%s %s  %s  | %s", priorityIcon, i.Number, desc, stateStr)
}

// Description returns empty string for compact single-line display.
func (i IncidentItem) Description() string {
	return ""
}

// FilterValue returns the value to filter against.
func (i IncidentItem) FilterValue() string {
	return i.Number + " " + i.ShortDescription
}

// getPriorityIcon returns an icon for the priority level.
func getPriorityIcon(priority string) string {
	switch priority {
	case "1", "Critical":
		return "🔴"
	case "2", "High":
		return "🟠"
	case "3", "Moderate":
		return "🟡"
	case "4", "Low":
		return "🟢"
	default:
		return "⚪"
	}
}

// formatState formats the incident state for display.
func formatState(state string) string {
	// Map common state values
	stateMap := map[string]string{
		"1": "New",
		"2": "In Progress",
		"3": "On Hold",
		"6": "Resolved",
		"7": "Closed",
		"8": "Canceled",
	}

	if mapped, ok := stateMap[state]; ok {
		return mapped
	}
	return state
}

// IncidentPicker is a TUI for selecting an incident.
type IncidentPicker struct {
	list     list.Model
	choice   *IncidentItem
	quitting bool
}

// NewIncidentPicker creates a new incident picker.
func NewIncidentPicker(incidents []IncidentItem) *IncidentPicker {
	items := make([]list.Item, len(incidents))
	for i, inc := range incidents {
		items[i] = inc
	}

	const defaultWidth = 80
	const listHeight = 15

	l := list.New(items, incidentItemDelegate{}, defaultWidth, listHeight)
	l.Title = "Select an incident"
	l.SetShowStatusBar(true)
	l.SetFilteringEnabled(true)
	l.Styles.Title = lipgloss.NewStyle().
		MarginLeft(2).
		Bold(true).
		Foreground(lipgloss.Color("#e8a217"))
	l.Styles.PaginationStyle = list.DefaultStyles().PaginationStyle.PaddingLeft(4)
	l.Styles.HelpStyle = list.DefaultStyles().HelpStyle.PaddingLeft(4).PaddingBottom(1)
	l.SetStatusBarItemName("incident", "incidents")

	return &IncidentPicker{
		list: l,
	}
}

// incidentItemDelegate defines the list item styling for compact single-line display.
type incidentItemDelegate struct{}

func (d incidentItemDelegate) Height() int                               { return 1 }
func (d incidentItemDelegate) Spacing() int                              { return 0 }
func (d incidentItemDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }

func (d incidentItemDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	incident, ok := item.(IncidentItem)
	if !ok {
		return
	}

	// Determine style based on selection
	var style lipgloss.Style
	if index == m.Index() {
		style = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#e8a217")).
			Bold(true)
	} else {
		style = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#cccccc"))
	}

	fmt.Fprint(w, style.Render(incident.Title()))
}

// Init initializes the picker.
func (p *IncidentPicker) Init() tea.Cmd {
	return nil
}

// Update handles messages.
func (p *IncidentPicker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.list.SetWidth(msg.Width)
		return p, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			p.quitting = true
			return p, tea.Quit

		case "enter":
			if item, ok := p.list.SelectedItem().(IncidentItem); ok {
				p.choice = &item
				p.quitting = true
				return p, tea.Quit
			}
		}
	}

	var cmd tea.Cmd
	p.list, cmd = p.list.Update(msg)
	return p, cmd
}

// View renders the picker.
func (p *IncidentPicker) View() string {
	if p.quitting && p.choice != nil {
		return ""
	}

	return "\n" + p.list.View()
}

// Selected returns the chosen incident (nil if none selected).
func (p *IncidentPicker) Selected() *IncidentItem {
	return p.choice
}

// Run starts the picker and returns the selected incident.
func (p *IncidentPicker) Run() (*IncidentItem, error) {
	finalModel, err := tea.NewProgram(p).Run()
	if err != nil {
		return nil, err
	}

	picker, ok := finalModel.(*IncidentPicker)
	if !ok {
		return nil, fmt.Errorf("unexpected model type")
	}

	return picker.Selected(), nil
}
