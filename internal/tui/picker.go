// Package tui provides interactive terminal UI components.
package tui

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ProfileItem represents a profile in the picker.
type ProfileItem struct {
	Name      string
	Instance  string
	IsDefault bool
	Status    string // "valid", "expired", "invalid", "unknown"
	Username  string
	Number    int
}

// Title returns the display title for the list item.
func (p ProfileItem) Title() string {
	prefix := fmt.Sprintf("%d.", p.Number)
	if p.IsDefault {
		return fmt.Sprintf("%s * %s", prefix, p.Name)
	}
	return fmt.Sprintf("%s   %s", prefix, p.Name)
}

// Description returns the display description for the list item.
func (p ProfileItem) Description() string {
	statusIcon := "◌"
	switch p.Status {
	case "valid":
		statusIcon = "✓"
	case "expired":
		statusIcon = "⏱"
	case "invalid":
		statusIcon = "✗"
	}

	if p.Username != "" && p.Status == "valid" {
		return fmt.Sprintf("%s %s (as %s)", statusIcon, p.Instance, p.Username)
	}
	return fmt.Sprintf("%s %s", statusIcon, p.Instance)
}

// FilterValue returns the value to filter against.
func (p ProfileItem) FilterValue() string {
	return p.Name + " " + p.Instance
}

// ProfilePicker is a TUI for selecting a profile.
type ProfilePicker struct {
	list     list.Model
	choice   *ProfileItem
	quitting bool
}

// NewProfilePicker creates a new profile picker.
func NewProfilePicker(profiles []ProfileItem) *ProfilePicker {
	items := make([]list.Item, len(profiles))
	for i, p := range profiles {
		items[i] = p
	}

	const defaultWidth = 60
	const listHeight = 20

	l := list.New(items, itemDelegate{}, defaultWidth, listHeight)
	l.Title = "Select a profile"
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(true)
	l.Styles.Title = lipgloss.NewStyle().
		MarginLeft(2).
		Bold(true)
	l.Styles.PaginationStyle = list.DefaultStyles().PaginationStyle.PaddingLeft(4)
	l.Styles.HelpStyle = list.DefaultStyles().HelpStyle.PaddingLeft(4).PaddingBottom(1)
	l.SetStatusBarItemName("profile", "profiles")

	return &ProfilePicker{
		list: l,
	}
}

// itemDelegate defines the list item styling.
type itemDelegate struct{}

func (d itemDelegate) Height() int                               { return 2 }
func (d itemDelegate) Spacing() int                              { return 1 }
func (d itemDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }

func (d itemDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	profile, ok := item.(ProfileItem)
	if !ok {
		return
	}

	var titleStyle, descStyle lipgloss.Style

	// Style based on selection and status
	if index == m.Index() {
		titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFDF5")).
			Background(lipgloss.Color("#5F87FF")).
			Bold(true).
			Padding(0, 1)
		descStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFDF5")).
			Background(lipgloss.Color("#5F87FF")).
			Padding(0, 1)
	} else {
		titleStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFDF5"))
		descStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#A0A0A0"))
	}

	// Status color
	statusColor := "#A0A0A0"
	switch profile.Status {
	case "valid":
		statusColor = "#00FF00"
	case "expired":
		statusColor = "#FFA500"
	case "invalid":
		statusColor = "#FF0000"
	}

	title := profile.Title()
	desc := profile.Description()

	// Highlight status icon with color
	descParts := strings.SplitN(desc, " ", 2)
	if len(descParts) == 2 {
		statusIcon := lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor)).Render(descParts[0])
		desc = statusIcon + " " + descParts[1]
	}

	fmt.Fprintf(w, "%s\n%s", titleStyle.Render(title), descStyle.Render(desc))
}

// Init implements tea.Model.
func (p *ProfilePicker) Init() tea.Cmd {
	return nil
}

// Update implements tea.Model.
func (p *ProfilePicker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
			if item, ok := p.list.SelectedItem().(ProfileItem); ok {
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

// View implements tea.Model.
func (p *ProfilePicker) View() string {
	if p.quitting && p.choice == nil {
		return "Cancelled.\n"
	}
	return "\n" + p.list.View()
}

// Run runs the picker and returns the selected profile.
func (p *ProfilePicker) Run() (*ProfileItem, error) {
	finalModel, err := tea.NewProgram(p).Run()
	if err != nil {
		return nil, err
	}

	picker, ok := finalModel.(*ProfilePicker)
	if !ok {
		return nil, fmt.Errorf("unexpected model type")
	}

	return picker.choice, nil
}

// GetSelected returns the selected profile or nil if cancelled.
func (p *ProfilePicker) GetSelected() *ProfileItem {
	return p.choice
}

// UpdateSetItem represents an update set in the picker.
type UpdateSetItem struct {
	Name        string
	Application string
	State       string
	UpdateCount int
	SysID       string
	Number      int
}

// Title returns the display title for the list item.
func (u UpdateSetItem) Title() string {
	prefix := fmt.Sprintf("%d.", u.Number)
	return fmt.Sprintf("%s %s", prefix, truncateString(u.Name, 30))
}

// Description returns the display description for the list item.
func (u UpdateSetItem) Description() string {
	stateIcon := "◌"
	stateColor := "#A0A0A0"
	switch strings.ToLower(u.State) {
	case "complete", "completed":
		stateIcon = "✓"
		stateColor = "#00FF00"
	case "in progress", "inprogress":
		stateIcon = "⏱"
		stateColor = "#FFA500"
	}

	app := u.Application
	if app == "" {
		app = "Global"
	}

	statusStr := lipgloss.NewStyle().Foreground(lipgloss.Color(stateColor)).Render(stateIcon)
	return fmt.Sprintf("%s %s | %s | %d updates", statusStr, truncateString(app, 20), u.State, u.UpdateCount)
}

// FilterValue returns the value to filter against.
func (u UpdateSetItem) FilterValue() string {
	return u.Name + " " + u.Application + " " + u.State
}

// UpdateSetPicker is a TUI for selecting an update set.
type UpdateSetPicker struct {
	list     list.Model
	choice   *UpdateSetItem
	quitting bool
}

// NewUpdateSetPicker creates a new update set picker.
func NewUpdateSetPicker(updateSets []UpdateSetItem) *UpdateSetPicker {
	items := make([]list.Item, len(updateSets))
	for i, u := range updateSets {
		items[i] = u
	}

	const defaultWidth = 80
	const listHeight = 20

	l := list.New(items, updateSetDelegate{}, defaultWidth, listHeight)
	l.Title = "Select an update set to make current"
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(true)
	l.Styles.Title = lipgloss.NewStyle().
		MarginLeft(2).
		Bold(true)
	l.Styles.PaginationStyle = list.DefaultStyles().PaginationStyle.PaddingLeft(4)
	l.Styles.HelpStyle = list.DefaultStyles().HelpStyle.PaddingLeft(4).PaddingBottom(1)
	l.SetStatusBarItemName("update set", "update sets")
	l.Help.ShortSeparator = "  "
	l.Help.FullSeparator = "    "

	return &UpdateSetPicker{
		list: l,
	}
}

// updateSetDelegate defines the list item styling - single line layout.
type updateSetDelegate struct{}

func (d updateSetDelegate) Height() int                               { return 1 }
func (d updateSetDelegate) Spacing() int                              { return 0 }
func (d updateSetDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }

func (d updateSetDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	updateSet, ok := item.(UpdateSetItem)
	if !ok {
		return
	}

	// Build the full line content
	prefix := fmt.Sprintf("%d.", updateSet.Number)
	name := truncateString(updateSet.Name, 25)

	app := updateSet.Application
	if app == "" {
		app = "Global"
	}
	app = truncateString(app, 20)

	// State icon with color
	stateIcon := "◌"
	stateColor := "#A0A0A0"
	switch strings.ToLower(updateSet.State) {
	case "complete", "completed":
		stateIcon = "✓"
		stateColor = "#00FF00"
	case "in progress", "inprogress":
		stateIcon = "⏱"
		stateColor = "#FFA500"
	}

	// Format: "1. Update Set Name | ✓ Application | state | 5 updates"
	line := fmt.Sprintf("%s %-25s | %s %-20s | %-12s | %d updates",
		prefix, name,
		lipgloss.NewStyle().Foreground(lipgloss.Color(stateColor)).Render(stateIcon),
		app,
		updateSet.State,
		updateSet.UpdateCount)

	var style lipgloss.Style
	if index == m.Index() {
		// Highlighted selection
		style = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFDF5")).
			Background(lipgloss.Color("#5F87FF")).
			Padding(0, 1)
	} else {
		// Normal item
		style = lipgloss.NewStyle().
			Padding(0, 1)
	}

	fmt.Fprint(w, style.Render(line))
}

// Init implements tea.Model.
func (u *UpdateSetPicker) Init() tea.Cmd {
	return nil
}

// Update implements tea.Model.
func (u *UpdateSetPicker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		u.list.SetWidth(msg.Width)
		return u, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			u.quitting = true
			return u, tea.Quit

		case "enter":
			if item, ok := u.list.SelectedItem().(UpdateSetItem); ok {
				u.choice = &item
				u.quitting = true
				return u, tea.Quit
			}
		}
	}

	var cmd tea.Cmd
	u.list, cmd = u.list.Update(msg)
	return u, cmd
}

// View implements tea.Model.
func (u *UpdateSetPicker) View() string {
	if u.quitting && u.choice == nil {
		return "Cancelled. No update set selected.\n"
	}
	return "\n" + u.list.View()
}

// Run runs the picker and returns the selected update set.
func (u *UpdateSetPicker) Run() (*UpdateSetItem, error) {
	finalModel, err := tea.NewProgram(u).Run()
	if err != nil {
		return nil, err
	}

	picker, ok := finalModel.(*UpdateSetPicker)
	if !ok {
		return nil, fmt.Errorf("unexpected model type")
	}

	return picker.choice, nil
}

// GetSelected returns the selected update set or nil if cancelled.
func (u *UpdateSetPicker) GetSelected() *UpdateSetItem {
	return u.choice
}

// truncateString truncates a string to max length, adding "..." if truncated
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}
