package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// ListLayout represents a UI List layout (sys_ui_list record).
// Each record defines a list view for a specific table and view.
type ListLayout struct {
	SysID        string `json:"sys_id"`
	Name         string `json:"name"`         // Table name
	View         string `json:"view"`         // View name (e.g., "Default view")
	Parent       string `json:"parent"`       // Parent table name (for related lists, e.g., "incident")
	Relationship string `json:"relationship"` // Relationship (for related lists)
	CreatedOn    string `json:"sys_created_on"`
	UpdatedOn    string `json:"sys_updated_on"`
}

// ListElement represents a column in a list layout (sys_ui_list_element record).
type ListElement struct {
	SysID    string `json:"sys_id"`
	ListID   string `json:"list_id"`  // Parent list sys_id
	Element  string `json:"element"`  // Column/field name
	Position int    `json:"position"` // Column position (left to right)
	Type     string `json:"type"`     // Element type
}

// ListListViewsOptions holds options for listing list views.
type ListListViewsOptions struct {
	TableName string
	Limit     int
	Offset    int
}

// ListListViews retrieves distinct views that have list layouts for a table.
func (c *Client) ListListViews(ctx context.Context, tableName string, opts *ListListViewsOptions) ([]string, error) {
	if opts == nil {
		opts = &ListListViewsOptions{}
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

	// Build query — only top-level lists (no parent = not a related list)
	sysparmQuery := "ORDERBYview^parentISEMPTY"
	if tableName != "" {
		sysparmQuery = sysparmQuery + "^name=" + tableName
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_list", query)
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

// ListListLayoutsOptions holds options for listing list layouts.
type ListListLayoutsOptions struct {
	TableName string
	ViewName  string
	Limit     int
	Offset    int
}

// ListListLayouts retrieves the main list layout for a table/view from sys_ui_list.
// This returns only the top-level list (parentISEMPTY). Use ListRelatedLists for related lists.
func (c *Client) ListListLayouts(ctx context.Context, opts *ListListLayoutsOptions) ([]ListLayout, error) {
	if opts == nil {
		opts = &ListListLayoutsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,view,parent,relationship,sys_created_on,sys_updated_on")
	query.Set("sysparm_display_value", "all")

	// Build query — only top-level lists
	var sysparmQuery string
	if opts.TableName != "" {
		sysparmQuery = "name=" + opts.TableName + "^parentISEMPTY"
	} else {
		sysparmQuery = "parentISEMPTY"
	}
	if viewSysID != "" {
		sysparmQuery = sysparmQuery + "^view=" + viewSysID
	}
	sysparmQuery = sysparmQuery + "^ORDERBYname"

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_list", query)
	if err != nil {
		return nil, err
	}

	layouts := make([]ListLayout, len(resp.Result))
	for i, record := range resp.Result {
		layouts[i] = listLayoutFromRecord(record)
	}

	return layouts, nil
}

// RelatedList holds a related list layout and its columns.
type RelatedList struct {
	Layout   ListLayout    `json:"layout"`
	Elements []ListElement `json:"elements"`
}

// ListRelatedListsOptions holds options for fetching related lists.
type ListRelatedListsOptions struct {
	ParentTable string // The parent table name (e.g., "incident")
	ViewName    string // View name (e.g., "Default view")
}

// ListRelatedLists retrieves related lists for a parent table and view.
// Related lists are sys_ui_list records where parent = <table name>.
// Each related list's columns are also fetched.
func (c *Client) ListRelatedLists(ctx context.Context, opts *ListRelatedListsOptions) ([]RelatedList, error) {
	if opts == nil || opts.ParentTable == "" {
		return nil, nil
	}

	// Resolve view name to sys_id
	viewFilter := ""
	if opts.ViewName != "" {
		viewID, err := c.getViewSysID(ctx, opts.ViewName)
		if err != nil {
			viewFilter = opts.ViewName
		} else {
			viewFilter = viewID
		}
	}

	query := url.Values{}
	query.Set("sysparm_limit", "50")
	query.Set("sysparm_fields", "sys_id,name,view,parent,relationship,sys_created_on,sys_updated_on")
	query.Set("sysparm_display_value", "all")

	sysparmQuery := "parent=" + opts.ParentTable
	if viewFilter != "" {
		sysparmQuery = sysparmQuery + "^view=" + viewFilter
	}
	sysparmQuery = sysparmQuery + "^ORDERBYname"
	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_list", query)
	if err != nil {
		return nil, err
	}

	var results []RelatedList
	for _, record := range resp.Result {
		layout := listLayoutFromRecord(record)

		// Fetch columns for this related list
		elements, err := c.ListListElements(ctx, &ListListElementsOptions{
			ListID: layout.SysID,
		})
		if err != nil {
			// Include the layout even if we can't get columns
			elements = nil
		}

		results = append(results, RelatedList{
			Layout:   layout,
			Elements: elements,
		})
	}

	return results, nil
}

// ListListElementsOptions holds options for listing list elements (columns).
type ListListElementsOptions struct {
	ListID string // Parent list sys_id
	Limit  int
	Offset int
}

// ListListElements retrieves columns for a list layout from sys_ui_list_element.
func (c *Client) ListListElements(ctx context.Context, opts *ListListElementsOptions) ([]ListElement, error) {
	if opts == nil {
		opts = &ListListElementsOptions{}
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

	query.Set("sysparm_fields", "sys_id,list_id,element,position,type")
	query.Set("sysparm_display_value", "all")

	// Build query — order by position for left-to-right column order
	sysparmQuery := "ORDERBYposition"
	if opts.ListID != "" {
		sysparmQuery = "list_id=" + opts.ListID + "^" + sysparmQuery
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_list_element", query)
	if err != nil {
		return nil, err
	}

	elements := make([]ListElement, len(resp.Result))
	for i, record := range resp.Result {
		elements[i] = listElementFromRecord(record)
	}

	return elements, nil
}

// listLayoutFromRecord converts a record map to a ListLayout struct.
func listLayoutFromRecord(record map[string]interface{}) ListLayout {
	return ListLayout{
		SysID:        getString(record, "sys_id"),
		Name:         getString(record, "name"),
		View:         getString(record, "view"),
		Parent:       getString(record, "parent"),
		Relationship: getString(record, "relationship"),
		CreatedOn:    getString(record, "sys_created_on"),
		UpdatedOn:    getString(record, "sys_updated_on"),
	}
}

// listElementFromRecord converts a record map to a ListElement struct.
func listElementFromRecord(record map[string]interface{}) ListElement {
	return ListElement{
		SysID:    getString(record, "sys_id"),
		ListID:   getString(record, "list_id"),
		Element:  getString(record, "element"),
		Position: getInt(record, "position"),
		Type:     getString(record, "type"),
	}
}
