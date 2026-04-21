package sdk

import (
	"context"
	"fmt"
	"net/url"
	"strings"
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

// GetLog retrieves a single log entry by sys_id.
func (c *Client) GetLog(ctx context.Context, sysID string) (*LogEntry, error) {
	query := url.Values{}
	query.Set("sysparm_limit", "1")
	query.Set("sysparm_query", fmt.Sprintf("sys_id=%s", sysID))
	query.Set("sysparm_fields", "sys_id,level,message,source,sys_created_on,sys_created_by")

	resp, err := c.Get(ctx, "syslog", query)
	if err != nil {
		return nil, err
	}

	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("log entry not found: %s", sysID)
	}

	log := logEntryFromRecord(resp.Result[0])
	return &log, nil
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
	info := &InstanceInfo{
		Version:         "Unknown",
		Build:           "Unknown",
		InstanceName:    "Unknown",
		TimeZone:        "Unknown",
		UserName:        "Unknown",
		UserSysID:       "",
		GlideProperties: make(map[string]string),
	}

	// Get the actual current user (not just the first sys_user record)
	user, err := c.GetCurrentUser(ctx)
	if err == nil && user != nil {
		info.UserSysID = user.SysID
		info.UserName = user.UserName
	}

	// Query system properties for instance metadata
	propQuery := url.Values{}
	propQuery.Set("sysparm_limit", "20")
	propQuery.Set("sysparm_fields", "name,value")
	propQuery.Set("sysparm_query", "nameINinstance_name,mid.version,glide.build.tag,glide.builddate,glide.patch,glide.sys.default.tz")

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
				// Parse patch from version string like "australia-02-11-2026__patch1-03-23-2026_03-31-2026_1137"
				if idx := strings.Index(value, "__patch"); idx != -1 {
					patchStart := idx + 7 // len("__patch")
					patchEnd := strings.Index(value[patchStart:], "-")
					if patchEnd != -1 {
						info.Patch = value[patchStart : patchStart+patchEnd]
					}
				}
				// Parse build date from version string
				if info.BuildDate == "" {
					parts := strings.Split(value, "_")
					if len(parts) >= 2 {
						// Look for date pattern in parts
						for _, part := range parts {
							if len(part) == 10 && part[2] == '-' && part[5] == '-' {
								info.BuildDate = part
								break
							}
						}
					}
				}
			case "glide.build.tag":
				info.Build = value
			case "glide.builddate":
				info.BuildDate = value
			case "glide.patch":
				if value != "" {
					info.Patch = value
				}
			case "glide.sys.default.tz":
				info.TimeZone = value
			}
			info.GlideProperties[name] = value
		}
	}

	return info, nil
}
