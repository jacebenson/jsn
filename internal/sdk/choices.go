package sdk

import (
	"context"
	"fmt"
	"net/url"
)

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
