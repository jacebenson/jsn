package sdk

import (
	"context"
	"fmt"
	"net/url"
)

// Portal represents a ServiceNow Service Portal (sp_portal record).
type Portal struct {
	SysID       string `json:"sys_id"`
	Title       string `json:"title"`    // Display name of the portal
	ID          string `json:"id"`       // URL identifier (e.g., "itsm", "esc")
	Inactive    string `json:"inactive"` // "true" or "false" - if "true", portal is inactive
	Description string `json:"description"`
	Homepage    string `json:"homepage"`
	HomepageID  string `json:"homepage.id"`
	Theme       string `json:"theme"`
	ThemeName   string `json:"theme.name"`
	URLSuffix   string `json:"url_suffix"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListPortalsOptions holds options for listing portals.
type ListPortalsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListPortals retrieves service portals from sp_portal.
func (c *Client) ListPortals(ctx context.Context, opts *ListPortalsOptions) ([]Portal, error) {
	if opts == nil {
		opts = &ListPortalsOptions{}
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

	query.Set("sysparm_fields", "sys_id,title,id,inactive,description,homepage,homepage.id,theme,theme.name,url_suffix,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "title"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sp_portal", query)
	if err != nil {
		return nil, err
	}

	portals := make([]Portal, len(resp.Result))
	for i, record := range resp.Result {
		portals[i] = portalFromRecord(record)
	}

	return portals, nil
}

// GetPortal retrieves a single portal by ID or sys_id.
func (c *Client) GetPortal(ctx context.Context, identifier string) (*Portal, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,title,id,inactive,description,homepage,homepage.id,theme,theme.name,url_suffix,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("id=%s", identifier))
	}

	resp, err := c.Get(ctx, "sp_portal", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("portal not found: %s", identifier)
	}

	portal := portalFromRecord(resp.Result[0])
	return &portal, nil
}

// portalFromRecord converts a record map to a Portal struct.
func portalFromRecord(record map[string]interface{}) Portal {
	return Portal{
		SysID:       getString(record, "sys_id"),
		Title:       getString(record, "title"),
		ID:          getString(record, "id"),
		Inactive:    getString(record, "inactive"),
		Description: getString(record, "description"),
		Homepage:    getString(record, "homepage"),
		HomepageID:  getString(record, "homepage.id"),
		Theme:       getString(record, "theme"),
		ThemeName:   getString(record, "theme.name"),
		URLSuffix:   getString(record, "url_suffix"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// Widget represents a ServiceNow Service Portal Widget (sp_widget record).
type Widget struct {
	SysID        string `json:"sys_id"`
	Name         string `json:"name"`
	ID           string `json:"id"` // Widget ID
	Description  string `json:"description"`
	Template     string `json:"template"` // HTML template
	CSS          string `json:"css"`
	ClientScript string `json:"client_script"`
	ServerScript string `json:"script"`
	Link         string `json:"link"`
	Scope        string `json:"sys_scope"`
	CreatedOn    string `json:"sys_created_on"`
	CreatedBy    string `json:"sys_created_by"`
	UpdatedOn    string `json:"sys_updated_on"`
	UpdatedBy    string `json:"sys_updated_by"`
}

// ListWidgetsOptions holds options for listing widgets.
type ListWidgetsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListWidgets retrieves widgets from sp_widget.
func (c *Client) ListWidgets(ctx context.Context, opts *ListWidgetsOptions) ([]Widget, error) {
	if opts == nil {
		opts = &ListWidgetsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,id,description,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "all")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sp_widget", query)
	if err != nil {
		return nil, err
	}

	widgets := make([]Widget, len(resp.Result))
	for i, record := range resp.Result {
		widgets[i] = widgetFromRecord(record)
	}

	return widgets, nil
}

// GetWidget retrieves a single widget by ID or sys_id.
func (c *Client) GetWidget(ctx context.Context, identifier string) (*Widget, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,id,description,template,css,client_script,script,link,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "all")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("id=%s", identifier))
	}

	resp, err := c.Get(ctx, "sp_widget", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("widget not found: %s", identifier)
	}

	widget := widgetFromRecord(resp.Result[0])
	return &widget, nil
}

// widgetFromRecord converts a record map to a Widget struct.
func widgetFromRecord(record map[string]interface{}) Widget {
	return Widget{
		SysID:        getString(record, "sys_id"),
		Name:         getString(record, "name"),
		ID:           getString(record, "id"),
		Description:  getString(record, "description"),
		Template:     getString(record, "template"),
		CSS:          getString(record, "css"),
		ClientScript: getString(record, "client_script"),
		ServerScript: getString(record, "script"),
		Link:         getString(record, "link"),
		Scope:        getString(record, "sys_scope"),
		CreatedOn:    getString(record, "sys_created_on"),
		CreatedBy:    getString(record, "sys_created_by"),
		UpdatedOn:    getString(record, "sys_updated_on"),
		UpdatedBy:    getString(record, "sys_updated_by"),
	}
}

// Page represents a ServiceNow Service Portal Page (sp_page record).
type Page struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	ID          string `json:"id"` // Page ID
	Active      bool   `json:"active,string"`
	Description string `json:"description"`
	Title       string `json:"title"`
	Theme       string `json:"theme"`
	ThemeName   string `json:"theme.name"`
	CSS         string `json:"css"`
	Draft       bool   `json:"draft,string"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListPagesOptions holds options for listing pages.
type ListPagesOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListPages retrieves pages from sp_page.
func (c *Client) ListPages(ctx context.Context, opts *ListPagesOptions) ([]Page, error) {
	if opts == nil {
		opts = &ListPagesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,id,active,description,title,theme,theme.name,css,draft,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sp_page", query)
	if err != nil {
		return nil, err
	}

	pages := make([]Page, len(resp.Result))
	for i, record := range resp.Result {
		pages[i] = pageFromRecord(record)
	}

	return pages, nil
}

// GetPage retrieves a single page by ID or sys_id.
func (c *Client) GetPage(ctx context.Context, identifier string) (*Page, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,id,active,description,title,theme,theme.name,css,draft,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("id=%s", identifier))
	}

	resp, err := c.Get(ctx, "sp_page", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("page not found: %s", identifier)
	}

	page := pageFromRecord(resp.Result[0])
	return &page, nil
}

// pageFromRecord converts a record map to a Page struct.
func pageFromRecord(record map[string]interface{}) Page {
	return Page{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		ID:          getString(record, "id"),
		Active:      getBool(record, "active"),
		Description: getString(record, "description"),
		Title:       getString(record, "title"),
		Theme:       getString(record, "theme"),
		ThemeName:   getString(record, "theme.name"),
		CSS:         getString(record, "css"),
		Draft:       getBool(record, "draft"),
		Scope:       getString(record, "sys_scope"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// WidgetInstance represents a widget instance on a page (sp_instance record).
type WidgetInstance struct {
	SysID      string `json:"sys_id"`
	Page       string `json:"page"`
	PageID     string `json:"page.id"`
	Widget     string `json:"sp_widget"`
	WidgetID   string `json:"sp_widget.id"`
	WidgetName string `json:"sp_widget.name"`
	Title      string `json:"title"`
	Order      int    `json:"order,string"`
	Active     bool   `json:"active,string"`
	CSS        string `json:"css"`
	CreatedOn  string `json:"sys_created_on"`
	CreatedBy  string `json:"sys_created_by"`
	UpdatedOn  string `json:"sys_updated_on"`
	UpdatedBy  string `json:"sys_updated_by"`
}

// ListWidgetInstancesOptions holds options for listing widget instances.
type ListWidgetInstancesOptions struct {
	PageID    string // Filter by page
	WidgetID  string // Filter by widget
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListWidgetInstances retrieves widget instances from sp_instance.
func (c *Client) ListWidgetInstances(ctx context.Context, opts *ListWidgetInstancesOptions) ([]WidgetInstance, error) {
	if opts == nil {
		opts = &ListWidgetInstancesOptions{}
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

	query.Set("sysparm_fields", "sys_id,page,page.id,sp_widget,sp_widget.id,sp_widget.name,title,order,active,css,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "order"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	// Add page filter if provided (using dot-walk through sp_column.sp_row.sp_container.sp_page)
	if opts.PageID != "" {
		sysparmQuery = sysparmQuery + "^sp_column.sp_row.sp_container.sp_page=" + opts.PageID
	}

	// Add widget filter if provided
	if opts.WidgetID != "" {
		sysparmQuery = sysparmQuery + "^sp_widget=" + opts.WidgetID
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sp_instance", query)
	if err != nil {
		return nil, err
	}

	instances := make([]WidgetInstance, len(resp.Result))
	for i, record := range resp.Result {
		instances[i] = widgetInstanceFromRecord(record)
	}

	return instances, nil
}

// GetWidgetInstance retrieves a single widget instance by sys_id.
func (c *Client) GetWidgetInstance(ctx context.Context, sysID string) (*WidgetInstance, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,page,page.id,sp_widget,sp_widget.id,sp_widget.name,title,order,active,css,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sp_instance", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("widget instance not found: %s", sysID)
	}

	instance := widgetInstanceFromRecord(resp.Result[0])
	return &instance, nil
}

// widgetInstanceFromRecord converts a record map to a WidgetInstance struct.
func widgetInstanceFromRecord(record map[string]interface{}) WidgetInstance {
	return WidgetInstance{
		SysID:      getString(record, "sys_id"),
		Page:       getString(record, "page"),
		PageID:     getString(record, "page.id"),
		Widget:     getString(record, "sp_widget"),
		WidgetID:   getString(record, "sp_widget.id"),
		WidgetName: getString(record, "sp_widget.name"),
		Title:      getString(record, "title"),
		Order:      getInt(record, "order"),
		Active:     getBool(record, "active"),
		CSS:        getString(record, "css"),
		CreatedOn:  getString(record, "sys_created_on"),
		CreatedBy:  getString(record, "sys_created_by"),
		UpdatedOn:  getString(record, "sys_updated_on"),
		UpdatedBy:  getString(record, "sys_updated_by"),
	}
}

// UIScript represents a ServiceNow UI Script (sys_ui_script record).
type UIScript struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"` // API Name
	Description string `json:"description"`
	Script      string `json:"script"` // The JavaScript code
	Active      bool   `json:"active"`
	UIType      string `json:"ui_type"` // Desktop, Mobile / Service Portal, or All
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListUIScriptsOptions holds options for listing UI scripts.
type ListUIScriptsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListUIScripts retrieves UI scripts from sys_ui_script.
func (c *Client) ListUIScripts(ctx context.Context, opts *ListUIScriptsOptions) ([]UIScript, error) {
	if opts == nil {
		opts = &ListUIScriptsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,description,active,ui_type,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "all")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_script", query)
	if err != nil {
		return nil, err
	}

	scripts := make([]UIScript, len(resp.Result))
	for i, record := range resp.Result {
		scripts[i] = uiScriptFromRecord(record)
	}

	return scripts, nil
}

// uiScriptFromRecord converts a record map to a UIScript struct.
func uiScriptFromRecord(record map[string]interface{}) UIScript {
	return UIScript{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		Active:      getBool(record, "active"),
		UIType:      getString(record, "ui_type"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// GetUIScript retrieves a single UI script by name or sys_id.
func (c *Client) GetUIScript(ctx context.Context, identifier string) (*UIScript, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,description,script,active,ui_type,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "all")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_ui_script", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("ui script not found: %s", identifier)
	}

	script := uiScriptFromRecord(resp.Result[0])
	return &script, nil
}
