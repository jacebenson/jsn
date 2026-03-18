package sdk

import (
	"context"
	"fmt"
	"net/url"
	"sort"
)

// FormSection represents a UI Section (sys_ui_section record) - defines a section in a form.
type FormSection struct {
	SysID     string `json:"sys_id"`
	Name      string `json:"name"`    // Table name
	View      string `json:"view"`    // View name (e.g., "Default view", "service operations workspace")
	Caption   string `json:"caption"` // Section caption/title
	Header    string `json:"header"`  // Section header
	Order     int    `json:"order"`
	Active    bool   `json:"active"`
	CreatedOn string `json:"sys_created_on"`
	UpdatedOn string `json:"sys_updated_on"`
}

// FormElement represents a UI Element (sys_ui_element record) - a field or element in a section.
type FormElement struct {
	SysID       string `json:"sys_id"`
	Section     string `json:"sys_ui_section"` // Parent section sys_id
	Name        string `json:"element"`        // Field name (stored in 'element' field)
	Label       string `json:"label"`          // Display label
	ElementType string `json:"type"`           // Type: field, formatter, etc.
	Position    int    `json:"position"`       // Position order
	Row         int    `json:"row"`            // Row position in section
	Column      int    `json:"col"`            // Column position (0 or 1 for two-column)
	Mandatory   bool   `json:"mandatory"`
	ReadOnly    bool   `json:"read_only"`
	Visible     bool   `json:"visible"`
}

// ListFormViewsOptions holds options for listing form views.
type ListFormViewsOptions struct {
	TableName string // Filter by table
	Limit     int
	Offset    int
}

// ListFormViews retrieves distinct views for a table from sys_ui_section.
func (c *Client) ListFormViews(ctx context.Context, tableName string, opts *ListFormViewsOptions) ([]string, error) {
	if opts == nil {
		opts = &ListFormViewsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "view")
	query.Set("sysparm_group_by", "view")
	query.Set("sysparm_display_value", "all")

	// Build query
	sysparmQuery := "ORDERBYview"
	if tableName != "" {
		sysparmQuery = sysparmQuery + "^name=" + tableName
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_section", query)
	if err != nil {
		return nil, err
	}

	// Extract unique view names
	viewMap := make(map[string]bool)
	var views []string
	for _, record := range resp.Result {
		view := getString(record, "view")
		if view != "" && !viewMap[view] {
			viewMap[view] = true
			views = append(views, view)
		}
	}

	return views, nil
}

// ListFormSectionsOptions holds options for listing form sections.
type ListFormSectionsOptions struct {
	TableName string
	ViewName  string
	Limit     int
	Offset    int
}

// ListFormSections retrieves sections for a table/view from sys_ui_section.
func (c *Client) ListFormSections(ctx context.Context, opts *ListFormSectionsOptions) ([]FormSection, error) {
	if opts == nil {
		opts = &ListFormSectionsOptions{}
	}

	// If view name is provided, look up its sys_id first
	viewSysID := ""
	if opts.ViewName != "" {
		viewID, err := c.getViewSysID(ctx, opts.ViewName)
		if err != nil {
			// Fall back to using view name directly in query
			viewSysID = opts.ViewName
		} else {
			viewSysID = viewID
		}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,name,view,caption,header,order,active,sys_created_on,sys_updated_on")
	query.Set("sysparm_display_value", "all")

	// Build query
	var sysparmQuery string
	if opts.TableName != "" {
		sysparmQuery = "name=" + opts.TableName
	}
	if viewSysID != "" {
		if sysparmQuery != "" {
			sysparmQuery = sysparmQuery + "^"
		}
		sysparmQuery = sysparmQuery + "view=" + viewSysID
	}
	if sysparmQuery == "" {
		sysparmQuery = "ORDERBYorder"
	} else {
		sysparmQuery = sysparmQuery + "^ORDERBYorder"
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_section", query)
	if err != nil {
		return nil, err
	}

	sections := make([]FormSection, len(resp.Result))
	for i, record := range resp.Result {
		sections[i] = formSectionFromRecord(record)
	}

	// Sort sections: main section (no caption) first, then by creation date
	// The main form section typically has no caption and was created first
	sort.Slice(sections, func(i, j int) bool {
		// If one has a caption and the other doesn't, put the one without first
		iHasCaption := sections[i].Caption != ""
		jHasCaption := sections[j].Caption != ""
		if iHasCaption != jHasCaption {
			return !iHasCaption // No caption comes first
		}
		// Otherwise sort by creation date (oldest first)
		return sections[i].CreatedOn < sections[j].CreatedOn
	})

	return sections, nil
}

// getViewSysID looks up a view's sys_id by its name from sys_ui_view.
func (c *Client) getViewSysID(ctx context.Context, viewName string) (string, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", viewName))

	resp, err := c.Get(ctx, "sys_ui_view", query)
	if err != nil {
		return "", err
	}

	if len(resp.Result) == 0 {
		return "", fmt.Errorf("view not found: %s", viewName)
	}

	return getString(resp.Result[0], "sys_id"), nil
}

// ListFormElementsOptions holds options for listing form elements.
type ListFormElementsOptions struct {
	SectionID string // Filter by section sys_id
	Limit     int
	Offset    int
}

// ListFormElements retrieves elements for a section from sys_ui_element.
func (c *Client) ListFormElements(ctx context.Context, opts *ListFormElementsOptions) ([]FormElement, error) {
	if opts == nil {
		opts = &ListFormElementsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,sys_ui_section,element,label,type,position,row,col,mandatory,read_only,visible")
	query.Set("sysparm_display_value", "all")

	// Build query
	sysparmQuery := "ORDERBYorder"
	if opts.SectionID != "" {
		sysparmQuery = "sys_ui_section=" + opts.SectionID + "^" + sysparmQuery
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_element", query)
	if err != nil {
		return nil, err
	}

	elements := make([]FormElement, len(resp.Result))
	for i, record := range resp.Result {
		elements[i] = formElementFromRecord(record)
	}

	return elements, nil
}

// formSectionFromRecord converts a record map to a FormSection struct.
func formSectionFromRecord(record map[string]interface{}) FormSection {
	return FormSection{
		SysID:     getString(record, "sys_id"),
		Name:      getString(record, "name"),
		View:      getString(record, "view"),
		Caption:   getString(record, "caption"),
		Header:    getString(record, "header"),
		Order:     getInt(record, "order"),
		Active:    getBool(record, "active"),
		CreatedOn: getString(record, "sys_created_on"),
		UpdatedOn: getString(record, "sys_updated_on"),
	}
}

// formElementFromRecord converts a record map to a FormElement struct.
func formElementFromRecord(record map[string]interface{}) FormElement {
	return FormElement{
		SysID:       getString(record, "sys_id"),
		Section:     getString(record, "sys_ui_section"),
		Name:        getString(record, "element"),
		Label:       getString(record, "label"),
		ElementType: getString(record, "type"),
		Position:    getInt(record, "position"),
		Row:         getInt(record, "row"),
		Column:      getInt(record, "col"),
		Mandatory:   getBool(record, "mandatory"),
		ReadOnly:    getBool(record, "read_only"),
		Visible:     getBool(record, "visible"),
	}
}
