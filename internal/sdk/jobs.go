package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

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
	JobID     string // Filter by specific job sys_id (stored in 'source' field of syslog_transaction)
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

	// Filter by specific job if provided
	// First, get the job name from sys_trigger using the sys_id
	// Then filter syslog_transaction by url field which contains "JOB: <name>"
	if opts.JobID != "" {
		// Lookup job name from sys_trigger
		jobQuery := url.Values{}
		jobQuery.Set("sysparm_fields", "name")
		jobQuery.Set("sysparm_query", "sys_id="+opts.JobID)
		jobResp, err := c.Get(ctx, "sys_trigger", jobQuery)
		if err == nil && len(jobResp.Result) > 0 {
			jobName := getString(jobResp.Result[0], "name")
			if jobName != "" {
				sysparmQuery = sysparmQuery + "^url=JOB: " + jobName
			}
		}
	}

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

		c.setAuth(req)

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

	c.setAuth(req)

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
