package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/jacebenson/jsn/internal/tui"
	"github.com/spf13/cobra"
)

// jobsListFlags holds the flags for the jobs list command.
type jobsListFlags struct {
	limit       int
	jobType     string
	active      bool
	query       string
	order       string
	desc        bool
	all         bool
	interactive bool
}

// NewJobsCmd creates the jobs command group.
func NewJobsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "jobs",
		Short: "Manage scheduled jobs",
		Long:  "List and inspect ServiceNow scheduled jobs (sys_trigger, sysauto_script).",
	}

	cmd.AddCommand(
		newJobsListCmd(),
		newJobsShowCmd(),
	)

	return cmd
}

// newJobsListCmd creates the jobs list command.
func newJobsListCmd() *cobra.Command {
	var flags jobsListFlags

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List scheduled jobs",
		Long: `List scheduled jobs from sys_trigger (scheduled jobs) and sysauto_script (scheduled scripts).

Examples:
  jsn jobs list
  jsn jobs list --type scheduled
  jsn jobs list --type script
  jsn jobs list --active --limit 50`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runJobsList(cmd, flags)
		},
	}

	cmd.Flags().IntVarP(&flags.limit, "limit", "n", 20, "Maximum number of jobs to fetch")
	cmd.Flags().StringVarP(&flags.jobType, "type", "t", "", "Job type: scheduled or script")
	cmd.Flags().BoolVar(&flags.active, "active", false, "Show only active jobs")
	cmd.Flags().StringVar(&flags.query, "query", "", "ServiceNow encoded query filter")
	cmd.Flags().StringVar(&flags.order, "order", "name", "Order by field")
	cmd.Flags().BoolVar(&flags.desc, "desc", false, "Sort in descending order")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Fetch all jobs (no limit)")
	cmd.Flags().BoolVarP(&flags.interactive, "interactive", "i", false, "Interactive mode - select a job to view details")

	return cmd
}

// runJobsList executes the jobs list command.
func runJobsList(cmd *cobra.Command, flags jobsListFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Validate type
	table := "sys_trigger"
	if flags.jobType == "script" {
		table = "sysauto_script"
	} else if flags.jobType != "" && flags.jobType != "scheduled" {
		return output.ErrUsage("Invalid type. Use 'scheduled' or 'script'")
	}

	// Build query
	var queryParts []string
	if flags.active {
		queryParts = append(queryParts, "active=true")
	}
	if flags.query != "" {
		// Wrap simple queries with table-specific display column
		queryParts = append(queryParts, wrapSimpleQuery(flags.query, table))
	}
	sysparmQuery := strings.Join(queryParts, "^")

	// Set limit
	limit := flags.limit
	if flags.all {
		limit = 0
	}

	opts := &sdk.ListJobsOptions{
		Table:     table,
		Limit:     limit,
		Query:     sysparmQuery,
		OrderBy:   flags.order,
		OrderDesc: flags.desc,
	}

	jobs, err := sdkClient.ListJobs(cmd.Context(), opts)
	if err != nil {
		return fmt.Errorf("failed to list jobs: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	// Interactive mode - let user select a job to view
	if flags.interactive && isTerminal {
		selectedJob, err := pickJobFromList(cmd.Context(), sdkClient, jobs, table)
		if err != nil {
			return err
		}
		if selectedJob == "" {
			return fmt.Errorf("no job selected")
		}
		// Show the selected job
		return runJobsShow(cmd, selectedJob, table)
	}

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledJobsList(cmd, jobs, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownJobsList(cmd, jobs)
	}

	// Build data for JSON/quiet output
	var data []map[string]any
	for _, job := range jobs {
		row := map[string]any{
			"sys_id":         job.SysID,
			"name":           job.Name,
			"active":         job.Active,
			"job_type":       job.JobType,
			"next_action":    job.NextAction,
			"sys_updated_on": job.UpdatedOn,
		}
		if instanceURL != "" {
			tableName := "sys_trigger"
			if job.JobType == "script" {
				tableName = "sysauto_script"
			}
			row["link"] = fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, tableName, job.SysID)
		}
		data = append(data, row)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("%d scheduled jobs", len(jobs))),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "show",
				Cmd:         "jsn jobs show <sys_id>",
				Description: "Show job details",
			},
		),
	)
}

// printStyledJobsList outputs styled jobs list.
func printStyledJobsList(cmd *cobra.Command, jobs []sdk.ScheduledJob, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	activeStyle := lipgloss.NewStyle()
	inactiveStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Scheduled Jobs"))
	fmt.Fprintln(cmd.OutOrStdout())

	// Column headers
	fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-20s\n",
		headerStyle.Render("Name"),
		headerStyle.Render("Type"),
		headerStyle.Render("Status"),
		headerStyle.Render("Next Run"),
	)
	fmt.Fprintln(cmd.OutOrStdout())

	// Jobs
	for _, job := range jobs {
		status := "Active"
		statusStyle := activeStyle
		if !job.Active {
			status = "Inactive"
			statusStyle = inactiveStyle
		}

		name := job.Name
		if len(name) > 38 {
			name = name[:35] + "..."
		}

		nextRun := job.NextAction
		if nextRun == "" {
			nextRun = "-"
		}

		tableName := "sys_trigger"
		if job.JobType == "script" {
			tableName = "sysauto_script"
		}

		if instanceURL != "" {
			link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, tableName, job.SysID)
			nameWithLink := fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", link, name)
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-20s\n",
				nameWithLink,
				mutedStyle.Render(job.JobType),
				statusStyle.Render(status),
				mutedStyle.Render(nextRun),
			)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "  %-40s %-12s %-12s %-20s\n",
				name,
				mutedStyle.Render(job.JobType),
				statusStyle.Render(status),
				mutedStyle.Render(nextRun),
			)
		}
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn jobs show <sys_id>",
		mutedStyle.Render("Show job details"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownJobsList outputs markdown jobs list.
func printMarkdownJobsList(cmd *cobra.Command, jobs []sdk.ScheduledJob) error {
	fmt.Fprintln(cmd.OutOrStdout(), "**Scheduled Jobs**")
	fmt.Fprintln(cmd.OutOrStdout(), "| Name | Type | Status | Next Run |")
	fmt.Fprintln(cmd.OutOrStdout(), "|------|------|--------|----------|")

	for _, job := range jobs {
		status := "Active"
		if !job.Active {
			status = "Inactive"
		}
		nextRun := job.NextAction
		if nextRun == "" {
			nextRun = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "| %s | %s | %s | %s |\n", job.Name, job.JobType, status, nextRun)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// newJobsShowCmd creates the jobs show command.
func newJobsShowCmd() *cobra.Command {
	var jobType string

	cmd := &cobra.Command{
		Use:   "show [<sys_id>]",
		Short: "Show scheduled job details",
		Long: `Display detailed information about a scheduled job.

If no sys_id is provided, an interactive picker will help you select one.
Use --type to specify if looking for a scheduled script (sysauto_script).

Examples:
  jsn jobs show 0123456789abcdef0123456789abcdef
  jsn jobs show --type script 0123456789abcdef0123456789abcdef
  jsn jobs show  # Interactive picker`,
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var sysID string
			if len(args) > 0 {
				sysID = args[0]
			}
			return runJobsShow(cmd, sysID, jobType)
		},
	}

	cmd.Flags().StringVarP(&jobType, "type", "t", "", "Job type: scheduled or script (required if sys_id not from sys_trigger)")

	return cmd
}

// runJobsShow executes the jobs show command.
func runJobsShow(cmd *cobra.Command, sysID, jobType string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	outputWriter := appCtx.Output.(*output.Writer)
	cfg := appCtx.Config.(*config.Config)
	profile := cfg.GetActiveProfile()
	instanceURL := ""
	if profile != nil {
		instanceURL = profile.InstanceURL
	}

	sdkClient := appCtx.SDK.(*sdk.Client)

	// Determine table
	table := "sys_trigger"
	if jobType == "script" {
		table = "sysauto_script"
	}

	// Interactive job selection if no sys_id provided
	if sysID == "" {
		isTerminal := output.IsTTY(cmd.OutOrStdout())
		if !isTerminal {
			return output.ErrUsage("Job sys_id is required in non-interactive mode")
		}

		selectedJob, err := pickJob(cmd.Context(), sdkClient, "Select a scheduled job:", table)
		if err != nil {
			return err
		}
		sysID = selectedJob
	}

	// Get the job
	job, err := sdkClient.GetJob(cmd.Context(), sysID, table)
	if err != nil {
		return fmt.Errorf("failed to get job: %w", err)
	}

	// Determine output format
	format := outputWriter.GetFormat()
	isTerminal := output.IsTTY(cmd.OutOrStdout())

	if format == output.FormatStyled || (format == output.FormatAuto && isTerminal) {
		return printStyledJob(cmd, job, instanceURL)
	}

	if format == output.FormatMarkdown {
		return printMarkdownJob(cmd, job, instanceURL)
	}

	// Build data for JSON
	data := map[string]any{
		"sys_id":         job.SysID,
		"name":           job.Name,
		"active":         job.Active,
		"job_type":       job.JobType,
		"next_action":    job.NextAction,
		"description":    job.Description,
		"script":         job.Script,
		"sys_created_on": job.CreatedOn,
		"sys_updated_on": job.UpdatedOn,
		"sys_created_by": job.CreatedBy,
		"sys_updated_by": job.UpdatedBy,
	}
	if instanceURL != "" {
		tableName := "sys_trigger"
		if job.JobType == "script" {
			tableName = "sysauto_script"
		}
		data["link"] = fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, tableName, job.SysID)
	}

	return outputWriter.OK(data,
		output.WithSummary(fmt.Sprintf("Scheduled Job: %s", job.Name)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "list",
				Cmd:         "jsn jobs list",
				Description: "List all jobs",
			},
		),
	)
}

// printStyledJob outputs styled job details.
func printStyledJob(cmd *cobra.Command, job *sdk.ScheduledJob, instanceURL string) error {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	valueStyle := lipgloss.NewStyle()

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render(job.Name))
	fmt.Fprintln(cmd.OutOrStdout())

	// Basic info
	status := "Active"
	if !job.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Sys ID:"), valueStyle.Render(job.SysID))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Status:"), valueStyle.Render(status))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Type:"), valueStyle.Render(job.JobType))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Next Run:"), valueStyle.Render(job.NextAction))

	if job.Description != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", mutedStyle.Render("Description:"))
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", valueStyle.Render(job.Description))
	}

	// Script section
	if job.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", headerStyle.Render("Script:"))
		fmt.Fprintln(cmd.OutOrStdout())
		// Print script with indentation
		lines := strings.Split(job.Script, "\n")
		for _, line := range lines {
			fmt.Fprintf(cmd.OutOrStdout(), "    %s\n", mutedStyle.Render(line))
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n  %-20s %s\n", mutedStyle.Render("Created:"), valueStyle.Render(fmt.Sprintf("%s by %s", job.CreatedOn, job.CreatedBy)))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-20s %s\n", mutedStyle.Render("Updated:"), valueStyle.Render(fmt.Sprintf("%s by %s", job.UpdatedOn, job.UpdatedBy)))

	// Link
	if instanceURL != "" {
		tableName := "sys_trigger"
		if job.JobType == "script" {
			tableName = "sysauto_script"
		}
		link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, tableName, job.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "\n  %s  \x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\\n",
			mutedStyle.Render("Link:"),
			link,
			link,
		)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), "─────")
	fmt.Fprintln(cmd.OutOrStdout())
	fmt.Fprintln(cmd.OutOrStdout(), headerStyle.Render("Hints:"))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-50s  %s\n",
		"jsn jobs list",
		mutedStyle.Render("List all jobs"),
	)

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// printMarkdownJob outputs markdown job details.
func printMarkdownJob(cmd *cobra.Command, job *sdk.ScheduledJob, instanceURL string) error {
	status := "Active"
	if !job.Active {
		status = "Inactive"
	}

	fmt.Fprintf(cmd.OutOrStdout(), "**%s**\n\n", job.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Sys ID:** %s\n", job.SysID)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Status:** %s\n", status)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Type:** %s\n", job.JobType)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Next Run:** %s\n", job.NextAction)
	if job.Description != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "- **Description:** %s\n", job.Description)
	}

	if job.Script != "" {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), "**Script:**")
		fmt.Fprintln(cmd.OutOrStdout(), "```javascript")
		fmt.Fprintln(cmd.OutOrStdout(), job.Script)
		fmt.Fprintln(cmd.OutOrStdout(), "```")
	}

	fmt.Fprintf(cmd.OutOrStdout(), "\n- **Created:** %s by %s\n", job.CreatedOn, job.CreatedBy)
	fmt.Fprintf(cmd.OutOrStdout(), "- **Updated:** %s by %s\n", job.UpdatedOn, job.UpdatedBy)

	if instanceURL != "" {
		tableName := "sys_trigger"
		if job.JobType == "script" {
			tableName = "sysauto_script"
		}
		link := fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, tableName, job.SysID)
		fmt.Fprintf(cmd.OutOrStdout(), "- **Link:** %s\n", link)
	}

	fmt.Fprintln(cmd.OutOrStdout())
	return nil
}

// pickJob shows an interactive job picker and returns the selected job sys_id.
func pickJob(ctx context.Context, sdkClient *sdk.Client, title, table string) (string, error) {
	fetcher := func(ctx context.Context, offset, limit int) (*tui.PageResult, error) {
		opts := &sdk.ListJobsOptions{
			Table:   table,
			Limit:   limit,
			Offset:  offset,
			OrderBy: "name",
		}
		jobs, err := sdkClient.ListJobs(ctx, opts)
		if err != nil {
			return nil, err
		}

		var items []tui.PickerItem
		for _, j := range jobs {
			status := "Active"
			if !j.Active {
				status = "Inactive"
			}
			items = append(items, tui.PickerItem{
				ID:          j.SysID,
				Title:       j.Name,
				Description: status,
			})
		}

		hasMore := len(jobs) >= limit
		return &tui.PageResult{
			Items:   items,
			HasMore: hasMore,
		}, nil
	}

	selected, err := tui.PickWithPagination(title, fetcher, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", fmt.Errorf("selection cancelled")
	}

	return selected.ID, nil
}

// pickJobFromList shows a picker from an already-fetched list of jobs.
func pickJobFromList(ctx context.Context, sdkClient *sdk.Client, jobs []sdk.ScheduledJob, table string) (string, error) {
	var items []tui.PickerItem
	for _, j := range jobs {
		status := "Active"
		if !j.Active {
			status = "Inactive"
		}
		items = append(items, tui.PickerItem{
			ID:          j.SysID,
			Title:       j.Name,
			Description: fmt.Sprintf("%s - %s", j.JobType, status),
		})
	}

	// Use a simple picker without pagination since we already have all items
	selected, err := tui.Pick("Select a job to view:", items, tui.WithMaxVisible(15))
	if err != nil {
		return "", err
	}
	if selected == nil {
		return "", nil
	}

	return selected.ID, nil
}
