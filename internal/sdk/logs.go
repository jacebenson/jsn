package sdk

import (
	"context"
	"fmt"
	"net/url"
)

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
