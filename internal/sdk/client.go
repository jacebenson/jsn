// Package sdk provides a client for the ServiceNow Table API.
package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a ServiceNow API client.
type Client struct {
	baseURL    string
	httpClient *http.Client
	getAuth    func() (username, password string)
}

// NewClient creates a new ServiceNow API client.
func NewClient(baseURL string, getAuth func() (username, password string)) *Client {
	return &Client{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		getAuth: getAuth,
	}
}

// Get performs a GET request to the Table API.
func (c *Client) Get(ctx context.Context, table string, query url.Values) (*Response, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)
	if query != nil {
		endpoint = endpoint + "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	// Set headers
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	// Set auth
	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result Response
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Response represents a ServiceNow Table API response (array result).
type Response struct {
	Result []map[string]interface{} `json:"result"`
}

// SingleResponse represents a ServiceNow Table API response for single record operations.
type SingleResponse struct {
	Result map[string]interface{} `json:"result"`
}

// Table represents a ServiceNow table (sys_db_object record).
type Table struct {
	Name         string `json:"name"`
	Label        string `json:"label"`
	SysID        string `json:"sys_id"`
	SuperClass   string `json:"super_class,omitempty"`
	Scope        string `json:"sys_scope,omitempty"`
	IsExtendable bool   `json:"is_extendable,string"`
}

// ListTablesOptions holds options for listing tables.
type ListTablesOptions struct {
	Limit       int
	Offset      int
	Query       string
	OrderBy     string
	OrderDesc   bool
	ShowExtends bool
}

// ListTables retrieves tables from sys_db_object with filtering options.
func (c *Client) ListTables(ctx context.Context, opts *ListTablesOptions) ([]Table, error) {
	if opts == nil {
		opts = &ListTablesOptions{}
	}

	query := url.Values{}

	// Set limit
	limit := opts.Limit
	if limit <= 0 {
		limit = 1000
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	// Set fields - always include scope, optionally include super_class.name
	fields := "name,label,sys_id,sys_scope,is_extendable"
	if opts.ShowExtends {
		fields = "name,label,sys_id,sys_scope,super_class.name,is_extendable"
	}
	query.Set("sysparm_fields", fields)

	// Build query with ORDERBY
	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "name"
	}

	// Start with ORDERBY clause
	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	// Append user query if provided
	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	tables := make([]Table, len(resp.Result))
	for i, record := range resp.Result {
		tables[i] = tableFromRecord(record)
	}

	return tables, nil
}

// GetTable retrieves a single table by name.
func (c *Client) GetTable(ctx context.Context, name string) (*Table, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "name,label,sys_id,sys_scope,super_class.name,is_extendable")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", name))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("table not found: %s", name)
	}

	table := tableFromRecord(resp.Result[0])
	return &table, nil
}

// tableFromRecord converts a record map to a Table struct.
func tableFromRecord(record map[string]interface{}) Table {
	// super_class.name is returned when dot-walking the reference
	superClass := getString(record, "super_class.name")
	if superClass == "" {
		// Fallback to super_class field if it exists as a string
		superClass = getString(record, "super_class")
	}

	return Table{
		Name:         getString(record, "name"),
		Label:        getString(record, "label"),
		SysID:        getString(record, "sys_id"),
		SuperClass:   superClass,
		Scope:        getString(record, "sys_scope"),
		IsExtendable: getBool(record, "is_extendable"),
	}
}

// getString safely extracts a string value from a map.
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// getBool safely extracts a bool value from a map.
func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case bool:
			return val
		case string:
			return val == "true" || val == "1"
		}
	}
	return false
}

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case int:
			return val
		case float64:
			return int(val)
		case string:
			if i, err := strconv.Atoi(val); err == nil {
				return i
			}
		}
	}
	return 0
}

// TableColumn represents a column from sys_dictionary.
type TableColumn struct {
	Name         string `json:"element"`
	Label        string `json:"column_label"`
	Type         string `json:"internal_type"`
	Reference    string `json:"reference"`
	Mandatory    bool   `json:"mandatory,string"`
	MaxLength    int    `json:"max_length,string"`
	DefaultValue string `json:"default_value"`
	Comments     string `json:"comments"`
}

// GetTableColumns retrieves columns for a table from sys_dictionary.
func (c *Client) GetTableColumns(ctx context.Context, tableName string) ([]TableColumn, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1000")
	query.Set("sysparm_fields", "element,column_label,internal_type,reference,mandatory,max_length,default_value,comments")
	query.Set("sysparm_orderby", "column_label")
	query.Set("sysparm_query", fmt.Sprintf("name=%s^elementISNOTEMPTY", tableName))

	resp, err := c.Get(ctx, "sys_dictionary", query)
	if err != nil {
		return nil, err
	}

	columns := make([]TableColumn, len(resp.Result))
	for i, record := range resp.Result {
		columns[i] = columnFromRecord(record)
	}

	return columns, nil
}

// columnFromRecord converts a record map to a TableColumn struct.
func columnFromRecord(record map[string]interface{}) TableColumn {
	return TableColumn{
		Name:         getString(record, "element"),
		Label:        getString(record, "column_label"),
		Type:         getString(record, "internal_type"),
		Reference:    getString(record, "reference"),
		Mandatory:    getBool(record, "mandatory"),
		DefaultValue: getString(record, "default_value"),
		Comments:     getString(record, "comments"),
	}
}

// GetChildTables retrieves tables that extend the given table.
func (c *Client) GetChildTables(ctx context.Context, tableName string) ([]Table, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "name,label,sys_id")
	query.Set("sysparm_orderby", "name")
	query.Set("sysparm_query", fmt.Sprintf("super_class.name=%s", tableName))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return nil, err
	}

	tables := make([]Table, len(resp.Result))
	for i, record := range resp.Result {
		tables[i] = tableFromRecord(record)
	}

	return tables, nil
}

// ChoiceValue represents a choice option from sys_choice.
type ChoiceValue struct {
	SysID     string `json:"sys_id"`
	Table     string `json:"name"`
	Element   string `json:"element"`
	Value     string `json:"value"`
	Label     string `json:"label"`
	Sequence  int    `json:"sequence,string"`
	Dependent string `json:"dependent_value"`
	Inactive  bool   `json:"inactive,string"`
}

// UpdateSet represents a ServiceNow update set (sys_update_set record).
type UpdateSet struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	State       string `json:"state"`
	Application string `json:"application"`
	AppName     string `json:"application.name"`
	Description string `json:"description"`
	Parent      string `json:"parent"`
	ParentName  string `json:"parent.name"`
	CreatedBy   string `json:"sys_created_by"`
	CreatedOn   string `json:"sys_created_on"`
	UpdatedBy   string `json:"sys_updated_by"`
	UpdatedOn   string `json:"sys_updated_on"`
}

// UserPreference represents a user preference (sys_user_preference record).
type UserPreference struct {
	SysID    string `json:"sys_id"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	User     string `json:"user"`
	UserName string `json:"user.user_name"`
}

// User represents a ServiceNow user (sys_user record).
type User struct {
	SysID    string `json:"sys_id"`
	UserName string `json:"user_name"`
	Name     string `json:"name"`
	Email    string `json:"email"`
}

// Application represents a ServiceNow application scope (sys_scope record).
type Application struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Scope       string `json:"scope"`
	Description string `json:"description"`
}

// GetColumnChoices retrieves choice values for a column.
func (c *Client) GetColumnChoices(ctx context.Context, tableName, columnName string) ([]ChoiceValue, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "value,label,sequence,dependent_value")
	query.Set("sysparm_orderby", "sequence")
	query.Set("sysparm_query", fmt.Sprintf("name=%s^element=%s^inactive=false", tableName, columnName))

	resp, err := c.Get(ctx, "sys_choice", query)
	if err != nil {
		return nil, err
	}

	choices := make([]ChoiceValue, len(resp.Result))
	for i, record := range resp.Result {
		choices[i] = choiceFromRecord(record)
	}

	return choices, nil
}

// choiceFromRecord converts a record map to a ChoiceValue struct.
func choiceFromRecord(record map[string]interface{}) ChoiceValue {
	return ChoiceValue{
		SysID:     getString(record, "sys_id"),
		Table:     getString(record, "name"),
		Element:   getString(record, "element"),
		Value:     getString(record, "value"),
		Label:     getString(record, "label"),
		Sequence:  getInt(record, "sequence"),
		Dependent: getString(record, "dependent_value"),
		Inactive:  getBool(record, "inactive"),
	}
}

// Post performs a POST request to create a record.
func (c *Client) Post(ctx context.Context, table string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s", c.baseURL, table)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Put performs a PUT request to update a record.
func (c *Client) Put(ctx context.Context, table, sysID string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Patch performs a PATCH request to update a record.
func (c *Client) Patch(ctx context.Context, table, sysID string, data map[string]interface{}) (*SingleResponse, error) {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	bodyData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshaling request body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PATCH", endpoint, strings.NewReader(string(bodyData)))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result SingleResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parsing response: %w", err)
	}

	return &result, nil
}

// Delete performs a DELETE request to delete a record.
func (c *Client) Delete(ctx context.Context, table, sysID string) error {
	endpoint := fmt.Sprintf("%s/api/now/table/%s/%s", c.baseURL, table, sysID)

	req, err := http.NewRequestWithContext(ctx, "DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// ListUpdateSetsOptions holds options for listing update sets.
type ListUpdateSetsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListUpdateSets retrieves update sets from sys_update_set.
func (c *Client) ListUpdateSets(ctx context.Context, opts *ListUpdateSetsOptions) ([]UpdateSet, error) {
	if opts == nil {
		opts = &ListUpdateSetsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_updated_on"
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

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	updateSets := make([]UpdateSet, len(resp.Result))
	for i, record := range resp.Result {
		updateSets[i] = updateSetFromRecord(record)
	}

	return updateSets, nil
}

// GetUpdateSet retrieves a single update set by name or sys_id.
func (c *Client) GetUpdateSet(ctx context.Context, identifier string) (*UpdateSet, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("update set not found: %s", identifier)
	}

	updateSet := updateSetFromRecord(resp.Result[0])
	return &updateSet, nil
}

// GetChildUpdateSets retrieves update sets that have this one as a parent.
func (c *Client) GetChildUpdateSets(ctx context.Context, parentSysID string) ([]UpdateSet, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,state,application,application.name,description,parent,parent.name,sys_created_by,sys_created_on,sys_updated_by,sys_updated_on")
	query.Set("sysparm_orderby", "name")
	query.Set("sysparm_query", fmt.Sprintf("parent=%s", parentSysID))

	resp, err := c.Get(ctx, "sys_update_set", query)
	if err != nil {
		return nil, err
	}

	updateSets := make([]UpdateSet, len(resp.Result))
	for i, record := range resp.Result {
		updateSets[i] = updateSetFromRecord(record)
	}

	return updateSets, nil
}

// CreateUpdateSet creates a new update set.
func (c *Client) CreateUpdateSet(ctx context.Context, name, scope, description, parent string) (*UpdateSet, error) {
	data := map[string]interface{}{
		"name": name,
	}

	if description != "" {
		data["description"] = description
	}

	if scope != "" {
		data["application"] = scope
	}

	if parent != "" {
		data["parent"] = parent
	}

	resp, err := c.Post(ctx, "sys_update_set", data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	updateSet := updateSetFromRecord(resp.Result)
	return &updateSet, nil
}

// UpdateUpdateSet updates an existing update set.
func (c *Client) UpdateUpdateSet(ctx context.Context, sysID string, updates map[string]interface{}) (*UpdateSet, error) {
	resp, err := c.Patch(ctx, "sys_update_set", sysID, updates)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update")
	}

	updateSet := updateSetFromRecord(resp.Result)
	return &updateSet, nil
}

// GetCurrentUser retrieves the currently authenticated user.
func (c *Client) GetCurrentUser(ctx context.Context) (*User, error) {
	// Get username from auth credentials
	username, _ := c.getAuth()

	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,user_name,name,email")

	// Query by username if available, otherwise get first active user
	if username != "" {
		query.Set("sysparm_query", fmt.Sprintf("user_name=%s", username))
	} else {
		query.Set("sysparm_query", "active=true")
	}

	resp, err := c.Get(ctx, "sys_user", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("could not determine current user")
	}

	user := userFromRecord(resp.Result[0])
	return &user, nil
}

// GetUserPreference retrieves a user preference by name for the current user.
func (c *Client) GetUserPreference(ctx context.Context, userID, name string) (*UserPreference, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,value,user,user.user_name")
	query.Set("sysparm_query", fmt.Sprintf("user=%s^name=%s", userID, name))

	resp, err := c.Get(ctx, "sys_user_preference", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, nil
	}

	pref := userPreferenceFromRecord(resp.Result[0])
	return &pref, nil
}

// SetUserPreference creates or updates a user preference.
func (c *Client) SetUserPreference(ctx context.Context, userID, name, value string) error {
	// Check if preference already exists
	existing, err := c.GetUserPreference(ctx, userID, name)
	if err != nil {
		return err
	}

	data := map[string]interface{}{
		"user":  userID,
		"name":  name,
		"value": value,
	}

	if existing != nil {
		// Update existing
		_, err = c.Patch(ctx, "sys_user_preference", existing.SysID, data)
	} else {
		// Create new
		_, err = c.Post(ctx, "sys_user_preference", data)
	}

	return err
}

// GetCurrentUpdateSet retrieves the current update set for the user.
func (c *Client) GetCurrentUpdateSet(ctx context.Context, userID string) (*UpdateSet, error) {
	pref, err := c.GetUserPreference(ctx, userID, "sys_update_set")
	if err != nil {
		return nil, err
	}

	if pref == nil || pref.Value == "" {
		return nil, nil
	}

	return c.GetUpdateSet(ctx, pref.Value)
}

// SetCurrentUpdateSet sets the current update set for the user.
func (c *Client) SetCurrentUpdateSet(ctx context.Context, userID, updateSetSysID string) error {
	return c.SetUserPreference(ctx, userID, "sys_update_set", updateSetSysID)
}

// ListApplications retrieves applications/scopes from sys_scope.
func (c *Client) ListApplications(ctx context.Context, limit int) ([]Application, error) {
	if limit <= 0 {
		limit = 100
	}

	query := url.Values{}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))
	query.Set("sysparm_fields", "sys_id,name,scope,description")
	query.Set("sysparm_orderby", "name")

	resp, err := c.Get(ctx, "sys_scope", query)
	if err != nil {
		return nil, err
	}

	apps := make([]Application, len(resp.Result))
	for i, record := range resp.Result {
		apps[i] = applicationFromRecord(record)
	}

	return apps, nil
}

// GetApplication retrieves an application by scope name or sys_id.
func (c *Client) GetApplication(ctx context.Context, identifier string) (*Application, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,scope,description")

	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("scope=%s^ORname=%s", identifier, identifier))
	}

	resp, err := c.Get(ctx, "sys_scope", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("application not found: %s", identifier)
	}

	app := applicationFromRecord(resp.Result[0])
	return &app, nil
}

// Helper functions

func updateSetFromRecord(record map[string]interface{}) UpdateSet {
	return UpdateSet{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		State:       getString(record, "state"),
		Application: getString(record, "application"),
		AppName:     getString(record, "application.name"),
		Description: getString(record, "description"),
		Parent:      getString(record, "parent"),
		ParentName:  getString(record, "parent.name"),
		CreatedBy:   getString(record, "sys_created_by"),
		CreatedOn:   getString(record, "sys_created_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
	}
}

func userFromRecord(record map[string]interface{}) User {
	return User{
		SysID:    getString(record, "sys_id"),
		UserName: getString(record, "user_name"),
		Name:     getString(record, "name"),
		Email:    getString(record, "email"),
	}
}

func userPreferenceFromRecord(record map[string]interface{}) UserPreference {
	return UserPreference{
		SysID:    getString(record, "sys_id"),
		Name:     getString(record, "name"),
		Value:    getString(record, "value"),
		User:     getString(record, "user"),
		UserName: getString(record, "user.user_name"),
	}
}

func applicationFromRecord(record map[string]interface{}) Application {
	return Application{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Scope:       getString(record, "scope"),
		Description: getString(record, "description"),
	}
}

// GetAllColumnChoices retrieves all choice values (including inactive) for a column.
func (c *Client) GetAllColumnChoices(ctx context.Context, tableName, columnName string) ([]ChoiceValue, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,element,value,label,sequence,dependent_value,inactive")
	query.Set("sysparm_orderby", "sequence")
	query.Set("sysparm_query", fmt.Sprintf("name=%s^element=%s", tableName, columnName))

	resp, err := c.Get(ctx, "sys_choice", query)
	if err != nil {
		return nil, err
	}

	choices := make([]ChoiceValue, len(resp.Result))
	for i, record := range resp.Result {
		choices[i] = choiceFromRecord(record)
	}

	return choices, nil
}

// GetChoice retrieves a single choice by sys_id.
func (c *Client) GetChoice(ctx context.Context, sysID string) (*ChoiceValue, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,element,value,label,sequence,dependent_value,inactive")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_choice", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("choice not found: %s", sysID)
	}

	choice := choiceFromRecord(resp.Result[0])
	return &choice, nil
}

// CreateChoice creates a new choice value.
func (c *Client) CreateChoice(ctx context.Context, tableName, columnName, value, label string, sequence int, dependent string) (*ChoiceValue, error) {
	data := map[string]interface{}{
		"name":     tableName,
		"element":  columnName,
		"value":    value,
		"label":    label,
		"sequence": sequence,
	}
	if dependent != "" {
		data["dependent_value"] = dependent
	}

	resp, err := c.Post(ctx, "sys_choice", data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	choice := choiceFromRecord(resp.Result)
	return &choice, nil
}

// UpdateChoice updates an existing choice.
func (c *Client) UpdateChoice(ctx context.Context, sysID string, updates map[string]interface{}) (*ChoiceValue, error) {
	resp, err := c.Patch(ctx, "sys_choice", sysID, updates)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update")
	}

	choice := choiceFromRecord(resp.Result)
	return &choice, nil
}

// DeleteChoice deletes a choice by sys_id.
func (c *Client) DeleteChoice(ctx context.Context, sysID string) error {
	return c.Delete(ctx, "sys_choice", sysID)
}

// ListRecordsOptions holds options for listing records from any table.
type ListRecordsOptions struct {
	Limit     int
	Offset    int
	Query     string
	Fields    []string
	OrderBy   string
	OrderDesc bool
}

// ListRecords retrieves records from any table.
func (c *Client) ListRecords(ctx context.Context, table string, opts *ListRecordsOptions) ([]map[string]interface{}, error) {
	if opts == nil {
		opts = &ListRecordsOptions{}
	}

	query := url.Values{}

	// Set limit
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	// Set offset for pagination
	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	// Set fields - always include sys_id
	fields := opts.Fields
	if len(fields) == 0 {
		// Default fields: sys_id, number, and display value fields
		fields = []string{"sys_id", "number", "name", "short_description", "sys_updated_on"}
	}
	// Ensure sys_id is always included
	hasSysID := false
	for _, f := range fields {
		if f == "sys_id" {
			hasSysID = true
			break
		}
	}
	if !hasSysID {
		fields = append([]string{"sys_id"}, fields...)
	}
	query.Set("sysparm_fields", strings.Join(fields, ","))

	// Build query with ORDERBY
	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_updated_on"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	// Append user query if provided
	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	// Add display value parameter to get reference field display values
	query.Set("sysparm_display_value", "true")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	return resp.Result, nil
}

// GetRecord retrieves a single record by sys_id.
func (c *Client) GetRecord(ctx context.Context, table, sysID string) (map[string]interface{}, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))
	query.Set("sysparm_display_value", "true")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("record not found: %s", sysID)
	}

	return resp.Result[0], nil
}

// CreateRecord creates a new record in the specified table.
func (c *Client) CreateRecord(ctx context.Context, table string, data map[string]interface{}) (map[string]interface{}, error) {
	resp, err := c.Post(ctx, table, data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create")
	}

	return resp.Result, nil
}

// UpdateRecord updates an existing record by sys_id.
func (c *Client) UpdateRecord(ctx context.Context, table, sysID string, data map[string]interface{}) (map[string]interface{}, error) {
	resp, err := c.Patch(ctx, table, sysID, data)
	if err != nil {
		return nil, err
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update")
	}

	return resp.Result, nil
}

// DeleteRecord deletes a record by sys_id.
func (c *Client) DeleteRecord(ctx context.Context, table, sysID string) error {
	return c.Delete(ctx, table, sysID)
}

// GetRecordNumber retrieves a record by its number field (e.g., INC0010001).
func (c *Client) GetRecordByNumber(ctx context.Context, table, number string) (map[string]interface{}, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("number=%s", number))
	query.Set("sysparm_display_value", "true")

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("record not found: %s", number)
	}

	return resp.Result[0], nil
}

// GetTableDisplayColumn returns the display column for a table (e.g., "short_description" for incident).
func (c *Client) GetTableDisplayColumn(ctx context.Context, tableName string) (string, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "name,display_field")
	query.Set("sysparm_query", fmt.Sprintf("name=%s", tableName))

	resp, err := c.Get(ctx, "sys_db_object", query)
	if err != nil {
		return "", err
	}

	if len(resp.Result) == 0 {
		return "", fmt.Errorf("table not found: %s", tableName)
	}

	displayField := getString(resp.Result[0], "display_field")
	if displayField == "" {
		// Default fallback columns based on common patterns
		switch tableName {
		case "incident", "problem", "change_request", "sc_request", "sc_req_item":
			return "short_description", nil
		case "sys_user":
			return "name", nil
		case "sys_user_group":
			return "name", nil
		default:
			return "name", nil
		}
	}

	return displayField, nil
}

// Flow represents a ServiceNow Flow Designer flow (sys_hub_flow record).
type Flow struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	SysScope    string `json:"sys_scope"`
	Version     string `json:"version"`
	RunAs       string `json:"run_as"`
	RunAsUser   string `json:"run_as_user"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListFlowsOptions holds options for listing flows.
type ListFlowsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListFlows retrieves flows from sys_hub_flow.
func (c *Client) ListFlows(ctx context.Context, opts *ListFlowsOptions) ([]Flow, error) {
	if opts == nil {
		opts = &ListFlowsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	resp, err := c.Get(ctx, "sys_hub_flow", query)
	if err != nil {
		return nil, err
	}

	flows := make([]Flow, len(resp.Result))
	for i, record := range resp.Result {
		flows[i] = flowFromRecord(record)
	}

	return flows, nil
}

// GetFlow retrieves a single flow by name or sys_id.
func (c *Client) GetFlow(ctx context.Context, identifier string) (*Flow, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,description,scope,sys_scope,version,run_as,run_as_user,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_hub_flow", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("flow not found: %s", identifier)
	}

	flow := flowFromRecord(resp.Result[0])
	return &flow, nil
}

// flowFromRecord converts a record map to a Flow struct.
func flowFromRecord(record map[string]interface{}) Flow {
	return Flow{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Description: getString(record, "description"),
		Scope:       getString(record, "scope"),
		SysScope:    getString(record, "sys_scope"),
		Version:     getString(record, "version"),
		RunAs:       getString(record, "run_as"),
		RunAsUser:   getString(record, "run_as_user"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// BusinessRule represents a ServiceNow business rule (sys_script record).
type BusinessRule struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Collection  string `json:"collection"`
	When        string `json:"when"`
	Order       int    `json:"order,string"`
	Filter      string `json:"filter_condition"`
	Condition   string `json:"condition"`
	Description string `json:"description"`
	Script      string `json:"script"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListRulesOptions holds options for listing business rules.
type ListRulesOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListRules retrieves business rules from sys_script.
func (c *Client) ListRules(ctx context.Context, opts *ListRulesOptions) ([]BusinessRule, error) {
	if opts == nil {
		opts = &ListRulesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,collection,when,order,filter_condition,condition,description,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	resp, err := c.Get(ctx, "sys_script", query)
	if err != nil {
		return nil, err
	}

	rules := make([]BusinessRule, len(resp.Result))
	for i, record := range resp.Result {
		rules[i] = ruleFromRecord(record)
	}

	return rules, nil
}

// GetRule retrieves a single business rule by sys_id.
func (c *Client) GetRule(ctx context.Context, sysID string) (*BusinessRule, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,collection,when,order,filter_condition,condition,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_script", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("business rule not found: %s", sysID)
	}

	rule := ruleFromRecord(resp.Result[0])
	return &rule, nil
}

// ruleFromRecord converts a record map to a BusinessRule struct.
func ruleFromRecord(record map[string]interface{}) BusinessRule {
	return BusinessRule{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Collection:  getString(record, "collection"),
		When:        getString(record, "when"),
		Order:       getInt(record, "order"),
		Filter:      getString(record, "filter_condition"),
		Condition:   getString(record, "condition"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// ScheduledJob represents a ServiceNow scheduled job (sys_trigger or sysauto_script record).
type ScheduledJob struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	JobType     string `json:"job_type"`
	NextAction  string `json:"next_action"`
	Description string `json:"description"`
	Script      string `json:"script"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListJobsOptions holds options for listing scheduled jobs.
type ListJobsOptions struct {
	Table     string // "sys_trigger" or "sysauto_script"
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListJobs retrieves scheduled jobs from sys_trigger or sysauto_script.
func (c *Client) ListJobs(ctx context.Context, opts *ListJobsOptions) ([]ScheduledJob, error) {
	if opts == nil {
		opts = &ListJobsOptions{Table: "sys_trigger"}
	}

	table := opts.Table
	if table == "" {
		table = "sys_trigger"
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

	// Fields differ between tables
	if table == "sysauto_script" {
		query.Set("sysparm_fields", "sys_id,name,active,next_action,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	} else {
		query.Set("sysparm_fields", "sys_id,name,next_action,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	}

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

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	jobs := make([]ScheduledJob, len(resp.Result))
	for i, record := range resp.Result {
		jobs[i] = jobFromRecord(record, table)
	}

	return jobs, nil
}

// GetJob retrieves a single scheduled job by sys_id.
func (c *Client) GetJob(ctx context.Context, sysID, table string) (*ScheduledJob, error) {
	if table == "" {
		table = "sys_trigger"
	}

	query := url.Values{}
	query.Set("sysparm_limit", "1")

	if table == "sysauto_script" {
		query.Set("sysparm_fields", "sys_id,name,active,next_action,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	} else {
		query.Set("sysparm_fields", "sys_id,name,next_action,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	}

	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, table, query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("job not found: %s", sysID)
	}

	job := jobFromRecord(resp.Result[0], table)
	return &job, nil
}

// jobFromRecord converts a record map to a ScheduledJob struct.
func jobFromRecord(record map[string]interface{}, table string) ScheduledJob {
	jobType := "scheduled"
	if table == "sysauto_script" {
		jobType = "script"
	}

	return ScheduledJob{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		JobType:     jobType,
		NextAction:  getString(record, "next_action"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// JobExecution represents a scheduled job execution log entry (syslog_transaction).
type JobExecution struct {
	SysID    string `json:"sys_id"`
	JobID    string `json:"source"`
	JobName  string `json:"url"`
	Started  string `json:"sys_created_on"`
	Duration string `json:"response_time"`
	Status   string `json:"http_status"`
	Message  string `json:"message"`
	Server   string `json:"server"`
}

// ListJobExecutionsOptions holds options for listing job executions.
type ListJobExecutionsOptions struct {
	JobID     string // Filter by specific job sys_id (not directly available in syslog_transaction)
	Limit     int
	Offset    int
	OrderBy   string
	OrderDesc bool
}

// ListJobExecutions retrieves job execution logs from syslog_transaction.
// Scheduled job executions are logged with type='Scheduler' and the job name in the URL field.
func (c *Client) ListJobExecutions(ctx context.Context, opts *ListJobExecutionsOptions) ([]JobExecution, error) {
	if opts == nil {
		opts = &ListJobExecutionsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,source,url,response_time,http_status,message,server,sys_created_on")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_created_on"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	// Filter for scheduler type entries
	sysparmQuery = sysparmQuery + "^type=Scheduler"

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "syslog_transaction", query)
	if err != nil {
		return nil, err
	}

	executions := make([]JobExecution, len(resp.Result))
	for i, record := range resp.Result {
		executions[i] = jobExecutionFromRecord(record)
	}

	return executions, nil
}

// jobExecutionFromRecord converts a record map to a JobExecution struct.
func jobExecutionFromRecord(record map[string]interface{}) JobExecution {
	return JobExecution{
		SysID:    getString(record, "sys_id"),
		JobID:    getString(record, "source"),
		JobName:  getString(record, "url"),
		Started:  getString(record, "sys_created_on"),
		Duration: getString(record, "response_time"),
		Status:   getString(record, "http_status"),
		Message:  getString(record, "message"),
		Server:   getString(record, "server"),
	}
}

// ExecuteJob triggers immediate execution of a scheduled job.
// For sys_trigger jobs, it uses the executeNow API.
// For sysauto_script jobs, it inserts a sys_trigger record.
func (c *Client) ExecuteJob(ctx context.Context, sysID, table string) error {
	if table == "" {
		table = "sys_trigger"
	}

	if table == "sysauto_script" {
		// For scheduled scripts, we need to create a trigger record
		// Get the scheduled script first
		job, err := c.GetJob(ctx, sysID, table)
		if err != nil {
			return fmt.Errorf("failed to get scheduled script: %w", err)
		}

		// Create a trigger record to execute now
		triggerData := map[string]interface{}{
			"name":         job.Name,
			"script":       job.Script,
			"trigger_type": 0,                     // Run once
			"next_action":  "2024-01-01 00:00:00", // Will run immediately
		}

		endpoint := fmt.Sprintf("%s/api/now/table/sys_trigger", c.baseURL)
		body, err := json.Marshal(triggerData)
		if err != nil {
			return fmt.Errorf("marshaling trigger data: %w", err)
		}

		req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(string(body)))
		if err != nil {
			return fmt.Errorf("creating request: %w", err)
		}

		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")

		username, password := c.getAuth()
		req.SetBasicAuth(username, password)

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("executing request: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			body, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
		}

		return nil
	}

	// For sys_trigger jobs, try to execute via the executeNow API
	// This uses the GlideSysTrigger API to execute immediately
	endpoint := fmt.Sprintf("%s/api/now/table/sys_trigger/%s", c.baseURL, sysID)

	// First, get the job to verify it exists
	_, err := c.GetJob(ctx, sysID, table)
	if err != nil {
		return fmt.Errorf("failed to get job: %w", err)
	}

	// Update the job to trigger immediate execution by setting next_action to now
	updateData := map[string]interface{}{
		"next_action": time.Now().UTC().Format("2006-01-02 15:04:05"),
	}

	body, err := json.Marshal(updateData)
	if err != nil {
		return fmt.Errorf("marshaling update data: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// ScriptInclude represents a ServiceNow script include (sys_script_include record).
type ScriptInclude struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Scope       string `json:"scope"`
	SysScope    string `json:"sys_scope"`
	Description string `json:"description"`
	Script      string `json:"script"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListScriptIncludesOptions holds options for listing script includes.
type ListScriptIncludesOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListScriptIncludes retrieves script includes from sys_script_include.
func (c *Client) ListScriptIncludes(ctx context.Context, opts *ListScriptIncludesOptions) ([]ScriptInclude, error) {
	if opts == nil {
		opts = &ListScriptIncludesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,scope,sys_scope,description,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	resp, err := c.Get(ctx, "sys_script_include", query)
	if err != nil {
		return nil, err
	}

	scripts := make([]ScriptInclude, len(resp.Result))
	for i, record := range resp.Result {
		scripts[i] = scriptIncludeFromRecord(record)
	}

	return scripts, nil
}

// GetScriptInclude retrieves a single script include by name or sys_id.
func (c *Client) GetScriptInclude(ctx context.Context, identifier string) (*ScriptInclude, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,scope,sys_scope,description,script,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

	// Check if identifier looks like a sys_id (32 character hex string)
	if len(identifier) == 32 {
		query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", identifier))
	} else {
		query.Set("sysparm_query", fmt.Sprintf("name=%s", identifier))
	}

	resp, err := c.Get(ctx, "sys_script_include", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("script include not found: %s", identifier)
	}

	script := scriptIncludeFromRecord(resp.Result[0])
	return &script, nil
}

// scriptIncludeFromRecord converts a record map to a ScriptInclude struct.
func scriptIncludeFromRecord(record map[string]interface{}) ScriptInclude {
	return ScriptInclude{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Scope:       getString(record, "scope"),
		SysScope:    getString(record, "sys_scope"),
		Description: getString(record, "description"),
		Script:      getString(record, "script"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// UIPolicy represents a ServiceNow UI Policy (sys_ui_policy record).
type UIPolicy struct {
	SysID          string `json:"sys_id"`
	Name           string `json:"name"`
	Active         bool   `json:"active,string"`
	Table          string `json:"table"`
	ShortDesc      string `json:"short_description"`
	Order          int    `json:"order,string"`
	RunScripts     bool   `json:"run_scripts,string"`
	IsolateScript  bool   `json:"isolate_script,string"`
	OnLoad         bool   `json:"onload,string"`
	OnChange       bool   `json:"onchange,string"`
	Conditions     string `json:"conditions"`
	ScriptTrue     string `json:"script_true"`
	ScriptFalse    string `json:"script_false"`
	ReverseIfFalse bool   `json:"reverse_if_false,string"`
	Inherited      bool   `json:"sys_policy_inherited,string"`
	Scope          string `json:"sys_scope"`
	CreatedOn      string `json:"sys_created_on"`
	CreatedBy      string `json:"sys_created_by"`
	UpdatedOn      string `json:"sys_updated_on"`
	UpdatedBy      string `json:"sys_updated_by"`
}

// ListUIPoliciesOptions holds options for listing UI policies.
type ListUIPoliciesOptions struct {
	Limit     int
	Offset    int
	Table     string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListUIPolicies retrieves UI policies from sys_ui_policy.
func (c *Client) ListUIPolicies(ctx context.Context, opts *ListUIPoliciesOptions) ([]UIPolicy, error) {
	if opts == nil {
		opts = &ListUIPoliciesOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,table,short_description,order,run_scripts,isolate_script,onload,onchange,conditions,reverse_if_false,sys_policy_inherited,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	// Add table filter if provided
	if opts.Table != "" {
		sysparmQuery = sysparmQuery + "^table=" + opts.Table
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_ui_policy", query)
	if err != nil {
		return nil, err
	}

	policies := make([]UIPolicy, len(resp.Result))
	for i, record := range resp.Result {
		policies[i] = uiPolicyFromRecord(record)
	}

	return policies, nil
}

// GetUIPolicy retrieves a single UI policy by sys_id.
func (c *Client) GetUIPolicy(ctx context.Context, sysID string) (*UIPolicy, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,table,short_description,order,run_scripts,isolate_script,onload,onchange,conditions,script_true,script_false,reverse_if_false,sys_policy_inherited,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_ui_policy", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("UI policy not found: %s", sysID)
	}

	policy := uiPolicyFromRecord(resp.Result[0])
	return &policy, nil
}

// uiPolicyFromRecord converts a record map to a UIPolicy struct.
func uiPolicyFromRecord(record map[string]interface{}) UIPolicy {
	return UIPolicy{
		SysID:          getString(record, "sys_id"),
		Name:           getString(record, "name"),
		Active:         getBool(record, "active"),
		Table:          getString(record, "table"),
		ShortDesc:      getString(record, "short_description"),
		Order:          getInt(record, "order"),
		RunScripts:     getBool(record, "run_scripts"),
		IsolateScript:  getBool(record, "isolate_script"),
		OnLoad:         getBool(record, "onload"),
		OnChange:       getBool(record, "onchange"),
		Conditions:     getString(record, "conditions"),
		ScriptTrue:     getString(record, "script_true"),
		ScriptFalse:    getString(record, "script_false"),
		ReverseIfFalse: getBool(record, "reverse_if_false"),
		Inherited:      getBool(record, "sys_policy_inherited"),
		Scope:          getString(record, "sys_scope"),
		CreatedOn:      getString(record, "sys_created_on"),
		CreatedBy:      getString(record, "sys_created_by"),
		UpdatedOn:      getString(record, "sys_updated_on"),
		UpdatedBy:      getString(record, "sys_updated_by"),
	}
}

// ACL represents a ServiceNow Access Control List (sys_security_acl record).
type ACL struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Operation   string `json:"operation"`
	Type        string `json:"type"`
	Field       string `json:"field_name"` // For field ACLs
	Advanced    bool   `json:"advanced,string"`
	Condition   string `json:"condition"`
	Script      string `json:"script"`
	Description string `json:"description"`
	AdminOver   bool   `json:"admin_overrides,string"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ACLRole represents an ACL role assignment (sys_security_acl_role record).
type ACLRole struct {
	SysID    string `json:"sys_id"`
	ACL      string `json:"sys_security_acl"`
	Role     string `json:"sys_user_role"`
	RoleName string `json:"sys_user_role.name"`
	Active   bool   `json:"active,string"`
}

// ListACLOptions holds options for listing ACLs.
type ListACLOptions struct {
	Limit     int
	Offset    int
	Table     string
	Operation string
	Type      string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListACLs retrieves ACLs from sys_security_acl.
func (c *Client) ListACLs(ctx context.Context, opts *ListACLOptions) ([]ACL, error) {
	if opts == nil {
		opts = &ListACLOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,operation,type,field_name,advanced,condition,description,admin_overrides,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	// Use display_value to get string values for reference fields (operation, type)
	query.Set("sysparm_display_value", "true")

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

	// Add table filter if provided (ACL name typically contains table.field)
	if opts.Table != "" {
		sysparmQuery = sysparmQuery + "^nameSTARTSWITH" + opts.Table + "."
	}

	// Add operation filter if provided
	if opts.Operation != "" {
		sysparmQuery = sysparmQuery + "^operation=" + opts.Operation
	}

	// Add type filter if provided
	if opts.Type != "" {
		sysparmQuery = sysparmQuery + "^type=" + opts.Type
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_security_acl", query)
	if err != nil {
		return nil, err
	}

	acls := make([]ACL, len(resp.Result))
	for i, record := range resp.Result {
		acls[i] = aclFromRecord(record)
	}

	return acls, nil
}

// GetACL retrieves a single ACL by sys_id.
func (c *Client) GetACL(ctx context.Context, sysID string) (*ACL, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,operation,type,field_name,advanced,condition,script,description,admin_overrides,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_display_value", "true")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_security_acl", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("ACL not found: %s", sysID)
	}

	acl := aclFromRecord(resp.Result[0])
	return &acl, nil
}

// GetACLRoles retrieves roles assigned to an ACL.
func (c *Client) GetACLRoles(ctx context.Context, aclSysID string) ([]ACLRole, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,sys_security_acl,sys_user_role,sys_user_role.name,active")
	query.Set("sysparm_query", fmt.Sprintf("sys_security_acl=%s", aclSysID))

	resp, err := c.Get(ctx, "sys_security_acl_role", query)
	if err != nil {
		return nil, err
	}

	roles := make([]ACLRole, len(resp.Result))
	for i, record := range resp.Result {
		roles[i] = aclRoleFromRecord(record)
	}

	return roles, nil
}

// aclFromRecord converts a record map to an ACL struct.
func aclFromRecord(record map[string]interface{}) ACL {
	return ACL{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Operation:   getDisplayValue(record, "operation"),
		Type:        getDisplayValue(record, "type"),
		Field:       getString(record, "field_name"),
		Advanced:    getBool(record, "advanced"),
		Condition:   getString(record, "condition"),
		Script:      getString(record, "script"),
		Description: getString(record, "description"),
		AdminOver:   getBool(record, "admin_overrides"),
		Scope:       getString(record, "sys_scope"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// getDisplayValue extracts a display value from a field that may be either
// a string or an object with a display_value property.
func getDisplayValue(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]interface{}:
			if dv, ok := val["display_value"].(string); ok {
				return dv
			}
		}
	}
	return ""
}

// aclRoleFromRecord converts a record map to an ACLRole struct.
func aclRoleFromRecord(record map[string]interface{}) ACLRole {
	return ACLRole{
		SysID:    getString(record, "sys_id"),
		ACL:      getString(record, "sys_security_acl"),
		Role:     getString(record, "sys_user_role"),
		RoleName: getString(record, "sys_user_role.name"),
		Active:   getBool(record, "active"),
	}
}

// ClientScript represents a ServiceNow Client Script (sys_script_client record).
type ClientScript struct {
	SysID       string `json:"sys_id"`
	Name        string `json:"name"`
	Active      bool   `json:"active,string"`
	Table       string `json:"table_name"`
	Type        string `json:"type"` // onLoad, onChange, onSubmit, onCellEdit
	FieldName   string `json:"field_name"`
	Order       int    `json:"order,string"`
	Script      string `json:"script"`
	Isolate     bool   `json:"isolate_script,string"`
	UiType      string `json:"ui_type"` // desktop, mobile, both
	Description string `json:"description"`
	Scope       string `json:"sys_scope"`
	CreatedOn   string `json:"sys_created_on"`
	CreatedBy   string `json:"sys_created_by"`
	UpdatedOn   string `json:"sys_updated_on"`
	UpdatedBy   string `json:"sys_updated_by"`
}

// ListClientScriptsOptions holds options for listing client scripts.
type ListClientScriptsOptions struct {
	Limit     int
	Offset    int
	Table     string
	Type      string
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListClientScripts retrieves client scripts from sys_script_client.
func (c *Client) ListClientScripts(ctx context.Context, opts *ListClientScriptsOptions) ([]ClientScript, error) {
	if opts == nil {
		opts = &ListClientScriptsOptions{}
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

	query.Set("sysparm_fields", "sys_id,name,active,table_name,type,field_name,order,isolate_script,ui_type,description,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")

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

	// Add table filter if provided
	if opts.Table != "" {
		sysparmQuery = sysparmQuery + "^table_name=" + opts.Table
	}

	// Add type filter if provided
	if opts.Type != "" {
		sysparmQuery = sysparmQuery + "^type=" + opts.Type
	}

	if opts.Query != "" {
		sysparmQuery = sysparmQuery + "^" + opts.Query
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_script_client", query)
	if err != nil {
		return nil, err
	}

	scripts := make([]ClientScript, len(resp.Result))
	for i, record := range resp.Result {
		scripts[i] = clientScriptFromRecord(record)
	}

	return scripts, nil
}

// GetClientScript retrieves a single client script by sys_id.
func (c *Client) GetClientScript(ctx context.Context, sysID string) (*ClientScript, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,name,active,table_name,type,field_name,order,script,isolate_script,ui_type,description,sys_scope,sys_created_on,sys_created_by,sys_updated_on,sys_updated_by")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))

	resp, err := c.Get(ctx, "sys_script_client", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("client script not found: %s", sysID)
	}

	script := clientScriptFromRecord(resp.Result[0])
	return &script, nil
}

// clientScriptFromRecord converts a record map to a ClientScript struct.
func clientScriptFromRecord(record map[string]interface{}) ClientScript {
	return ClientScript{
		SysID:       getString(record, "sys_id"),
		Name:        getString(record, "name"),
		Active:      getBool(record, "active"),
		Table:       getString(record, "table_name"),
		Type:        getString(record, "type"),
		FieldName:   getString(record, "field_name"),
		Order:       getInt(record, "order"),
		Script:      getString(record, "script"),
		Isolate:     getBool(record, "isolate_script"),
		UiType:      getString(record, "ui_type"),
		Description: getString(record, "description"),
		Scope:       getString(record, "sys_scope"),
		CreatedOn:   getString(record, "sys_created_on"),
		CreatedBy:   getString(record, "sys_created_by"),
		UpdatedOn:   getString(record, "sys_updated_on"),
		UpdatedBy:   getString(record, "sys_updated_by"),
	}
}

// LogEntry represents a system log entry (syslog record).
type LogEntry struct {
	SysID     string `json:"sys_id"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	Source    string `json:"source"`
	CreatedOn string `json:"sys_created_on"`
	CreatedBy string `json:"sys_created_by"`
}

// ListLogsOptions holds options for listing system logs.
type ListLogsOptions struct {
	Limit     int
	Offset    int
	Query     string
	OrderBy   string
	OrderDesc bool
}

// ListLogs retrieves system logs from syslog.
func (c *Client) ListLogs(ctx context.Context, opts *ListLogsOptions) ([]LogEntry, error) {
	if opts == nil {
		opts = &ListLogsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,level,message,source,sys_created_on,sys_created_by")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_created_on"
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

	resp, err := c.Get(ctx, "syslog", query)
	if err != nil {
		return nil, err
	}

	logs := make([]LogEntry, len(resp.Result))
	for i, record := range resp.Result {
		logs[i] = logEntryFromRecord(record)
	}

	return logs, nil
}

// logEntryFromRecord converts a record map to a LogEntry struct.
func logEntryFromRecord(record map[string]interface{}) LogEntry {
	return LogEntry{
		SysID:     getString(record, "sys_id"),
		Level:     getString(record, "level"),
		Message:   getString(record, "message"),
		Source:    getString(record, "source"),
		CreatedOn: getString(record, "sys_created_on"),
		CreatedBy: getString(record, "sys_created_by"),
	}
}

// InstanceInfo holds ServiceNow instance information.
type InstanceInfo struct {
	Version         string            `json:"version"`
	Build           string            `json:"build"`
	BuildDate       string            `json:"build_date"`
	Patch           string            `json:"patch"`
	InstanceName    string            `json:"instance_name"`
	TimeZone        string            `json:"time_zone"`
	UserName        string            `json:"user_name"`
	UserSysID       string            `json:"user_sys_id"`
	GlideProperties map[string]string `json:"glide_properties"`
}

// GetInstanceInfo retrieves ServiceNow instance information.
func (c *Client) GetInstanceInfo(ctx context.Context) (*InstanceInfo, error) {
	// Get the user session info to extract instance details
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_fields", "sys_id,user_name,first_name,last_name")

	resp, err := c.Get(ctx, "sys_user", query)
	if err != nil {
		return nil, err
	}

	info := &InstanceInfo{
		Version:         "Unknown",
		Build:           "Unknown",
		InstanceName:    "Unknown",
		TimeZone:        "Unknown",
		UserName:        "Unknown",
		UserSysID:       "",
		GlideProperties: make(map[string]string),
	}

	// Try to get user info from the first record
	if len(resp.Result) > 0 {
		info.UserSysID = getString(resp.Result[0], "sys_id")
		info.UserName = getString(resp.Result[0], "user_name")
	}

	// Try to get instance info from stats.do or a known property
	// For now, we'll use a simpler approach - query the system properties
	propQuery := url.Values{}
	propQuery.Set("sysparm_limit", "10")
	propQuery.Set("sysparm_fields", "name,value")
	propQuery.Set("sysparm_query", "nameINinstance_name,mid.version,glide.build.tag")

	propResp, err := c.Get(ctx, "sys_properties", propQuery)
	if err == nil {
		for _, record := range propResp.Result {
			name := getString(record, "name")
			value := getString(record, "value")
			switch name {
			case "instance_name":
				info.InstanceName = value
			case "mid.version":
				info.Version = value
			case "glide.build.tag":
				info.Build = value
			}
			info.GlideProperties[name] = value
		}
	}

	return info, nil
}

// FlowExecution represents a flow execution record from sys_hub_trigger_instance_v2.
type FlowExecution struct {
	SysID        string `json:"sys_id"`
	FlowID       string `json:"flow_id"`
	FlowName     string `json:"flow_name"`
	Status       string `json:"status"`
	Started      string `json:"started"`
	Ended        string `json:"ended"`
	Duration     string `json:"duration"`
	SysUpdatedOn string `json:"sys_updated_on"`
}

// ListFlowExecutionsOptions holds options for listing flow executions.
type ListFlowExecutionsOptions struct {
	FlowID    string
	Limit     int
	Offset    int
	OrderBy   string
	OrderDesc bool
}

// ListFlowExecutions retrieves flow execution history from sys_hub_trigger_instance_v2.
func (c *Client) ListFlowExecutions(ctx context.Context, opts *ListFlowExecutionsOptions) ([]FlowExecution, error) {
	if opts == nil {
		opts = &ListFlowExecutionsOptions{}
	}

	query := url.Values{}

	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	query.Set("sysparm_limit", fmt.Sprintf("%d", limit))

	if opts.Offset > 0 {
		query.Set("sysparm_offset", fmt.Sprintf("%d", opts.Offset))
	}

	query.Set("sysparm_fields", "sys_id,flow,flow.name,status,started,ended,duration,sys_updated_on")

	orderBy := opts.OrderBy
	if orderBy == "" {
		orderBy = "sys_updated_on"
	}

	var sysparmQuery string
	if opts.OrderDesc {
		sysparmQuery = "ORDERBYDESC" + orderBy
	} else {
		sysparmQuery = "ORDERBY" + orderBy
	}

	if opts.FlowID != "" {
		sysparmQuery = sysparmQuery + "^flow=" + opts.FlowID
	}

	query.Set("sysparm_query", sysparmQuery)

	resp, err := c.Get(ctx, "sys_hub_trigger_instance_v2", query)
	if err != nil {
		return nil, err
	}

	executions := make([]FlowExecution, len(resp.Result))
	for i, record := range resp.Result {
		executions[i] = flowExecutionFromRecord(record)
	}

	return executions, nil
}

// flowExecutionFromRecord converts a record map to a FlowExecution struct.
func flowExecutionFromRecord(record map[string]interface{}) FlowExecution {
	// Handle flow.name which might be a display value object
	flowName := ""
	if flow, ok := record["flow"].(map[string]interface{}); ok {
		flowName = getString(flow, "display_value")
		if flowName == "" {
			flowName = getString(flow, "value")
		}
	}

	return FlowExecution{
		SysID:        getString(record, "sys_id"),
		FlowID:       getString(record, "flow"),
		FlowName:     flowName,
		Status:       getString(record, "status"),
		Started:      getString(record, "started"),
		Ended:        getString(record, "ended"),
		Duration:     getString(record, "duration"),
		SysUpdatedOn: getString(record, "sys_updated_on"),
	}
}

// FlowAction represents a flow action instance.
type FlowAction struct {
	SysID  string `json:"sys_id"`
	Name   string `json:"name"`
	Action string `json:"action"`
	Order  int    `json:"order"`
	Active bool   `json:"active"`
	FlowID string `json:"flow_id"`
}

// GetFlowActions retrieves actions for a flow from sys_hub_action_instance.
func (c *Client) GetFlowActions(ctx context.Context, flowID string) ([]FlowAction, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,action_type,order,active,flow")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s^ORDERBYorder", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err != nil {
		return nil, err
	}

	actions := make([]FlowAction, len(resp.Result))
	for i, record := range resp.Result {
		actions[i] = flowActionFromRecord(record)
	}

	return actions, nil
}

// flowActionFromRecord converts a record map to a FlowAction struct.
func flowActionFromRecord(record map[string]interface{}) FlowAction {
	return FlowAction{
		SysID:  getString(record, "sys_id"),
		Name:   getString(record, "name"),
		Action: getString(record, "action_type"),
		Order:  getInt(record, "order"),
		Active: getBool(record, "active"),
		FlowID: getString(record, "flow"),
	}
}

// FlowVariable represents a flow variable definition.
type FlowVariable struct {
	SysID string `json:"sys_id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Label string `json:"label"`
	Value string `json:"value"`
}

// GetFlowVariables retrieves variables for a flow.
func (c *Client) GetFlowVariables(ctx context.Context, flowID string) ([]FlowVariable, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "100")
	query.Set("sysparm_fields", "sys_id,name,variable_type,label,default_value")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_flow_variable", query)
	if err != nil {
		return nil, err
	}

	variables := make([]FlowVariable, len(resp.Result))
	for i, record := range resp.Result {
		variables[i] = flowVariableFromRecord(record)
	}

	return variables, nil
}

// flowVariableFromRecord converts a record map to a FlowVariable struct.
func flowVariableFromRecord(record map[string]interface{}) FlowVariable {
	return FlowVariable{
		SysID: getString(record, "sys_id"),
		Name:  getString(record, "name"),
		Type:  getString(record, "variable_type"),
		Label: getString(record, "label"),
		Value: getString(record, "default_value"),
	}
}

// UpdateFlowStatus activates or deactivates a flow.
func (c *Client) UpdateFlowStatus(ctx context.Context, flowID string, active bool) error {
	endpoint := fmt.Sprintf("%s/api/now/table/sys_hub_flow/%s", c.baseURL, flowID)

	updateData := map[string]interface{}{
		"active": active,
	}

	body, err := json.Marshal(updateData)
	if err != nil {
		return fmt.Errorf("marshaling update data: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	username, password := c.getAuth()
	req.SetBasicAuth(username, password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// CreateFlowInput holds parameters for creating a new flow.
type CreateFlowInput struct {
	Name        string
	Description string
	Scope       string // Scope name or sys_id
	Active      bool
	RunAs       string // "system", "user", or sys_id of a user
}

// CreateFlow creates a new flow with basic configuration.
func (c *Client) CreateFlow(ctx context.Context, input CreateFlowInput) (*Flow, error) {
	data := map[string]interface{}{
		"name":        input.Name,
		"description": input.Description,
		"active":      input.Active,
	}

	// Handle scope - resolve scope name to sys_id if needed
	if input.Scope != "" {
		if len(input.Scope) == 32 {
			// Looks like a sys_id
			data["sys_scope"] = input.Scope
		} else {
			// Try to resolve scope name to sys_id
			app, err := c.GetApplication(ctx, input.Scope)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve scope '%s': %w", input.Scope, err)
			}
			data["sys_scope"] = app.SysID
		}
	}

	// Handle run_as
	if input.RunAs != "" {
		data["run_as"] = input.RunAs
	}

	resp, err := c.Post(ctx, "sys_hub_flow", data)
	if err != nil {
		return nil, fmt.Errorf("failed to create flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create flow")
	}

	flow := flowFromRecord(resp.Result)
	return &flow, nil
}

// DeleteFlow deletes a flow by sys_id or name.
// If cascade is true, it will also delete related records (actions, variables, etc.)
func (c *Client) DeleteFlow(ctx context.Context, identifier string, cascade bool) error {
	// First, get the flow to resolve name to sys_id
	flow, err := c.GetFlow(ctx, identifier)
	if err != nil {
		return err
	}

	// If cascade, delete related records first
	if cascade {
		// Delete action instances
		if err := c.deleteFlowActions(ctx, flow.SysID); err != nil {
			return fmt.Errorf("failed to delete flow actions: %w", err)
		}

		// Delete variables
		if err := c.deleteFlowVariables(ctx, flow.SysID); err != nil {
			return fmt.Errorf("failed to delete flow variables: %w", err)
		}
	}

	// Delete the flow itself
	return c.Delete(ctx, "sys_hub_flow", flow.SysID)
}

// deleteFlowActions deletes all action instances for a flow.
func (c *Client) deleteFlowActions(ctx context.Context, flowID string) error {
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_action_instance", query)
	if err != nil {
		return err
	}

	for _, record := range resp.Result {
		sysID := getString(record, "sys_id")
		if sysID != "" {
			if err := c.Delete(ctx, "sys_hub_action_instance", sysID); err != nil {
				// Log but continue - some actions might already be deleted
				continue
			}
		}
	}

	return nil
}

// deleteFlowVariables deletes all variables for a flow.
func (c *Client) deleteFlowVariables(ctx context.Context, flowID string) error {
	query := url.Values{}
	query.Set("sysparm_fields", "sys_id")
	query.Set("sysparm_query", fmt.Sprintf("flow=%s", flowID))

	resp, err := c.Get(ctx, "sys_hub_flow_variable", query)
	if err != nil {
		return err
	}

	for _, record := range resp.Result {
		sysID := getString(record, "sys_id")
		if sysID != "" {
			if err := c.Delete(ctx, "sys_hub_flow_variable", sysID); err != nil {
				// Log but continue
				continue
			}
		}
	}

	return nil
}

// UpdateFlow updates flow properties (name, description, run_as, etc.).
func (c *Client) UpdateFlow(ctx context.Context, identifier string, updates map[string]interface{}) (*Flow, error) {
	// First, get the flow to resolve name to sys_id
	flow, err := c.GetFlow(ctx, identifier)
	if err != nil {
		return nil, err
	}

	// Handle scope resolution if scope is being updated
	if scope, ok := updates["scope"]; ok {
		scopeStr := fmt.Sprintf("%v", scope)
		if scopeStr != "" && len(scopeStr) != 32 {
			// Try to resolve scope name to sys_id
			app, err := c.GetApplication(ctx, scopeStr)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve scope '%s': %w", scopeStr, err)
			}
			updates["sys_scope"] = app.SysID
			delete(updates, "scope")
		}
	}

	resp, err := c.Patch(ctx, "sys_hub_flow", flow.SysID, updates)
	if err != nil {
		return nil, fmt.Errorf("failed to update flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from update flow")
	}

	updatedFlow := flowFromRecord(resp.Result)
	return &updatedFlow, nil
}
