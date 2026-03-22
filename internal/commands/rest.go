package commands

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/spf13/cobra"
)

// restFlags holds shared flags for rest subcommands.
type restFlags struct {
	data    string
	headers []string
}

// NewRestCmd creates the rest command group.
func NewRestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rest",
		Short: "Make arbitrary REST API calls",
		Long: `Make arbitrary REST API calls to any endpoint on the ServiceNow instance.

Supports GET, POST, PATCH, and DELETE methods for calling custom, scoped,
or out-of-box REST APIs beyond the Table API.

The path should start with "/" and is appended to the instance URL.

Examples:
  jsn rest get /api/now/table/incident?sysparm_limit=5
  jsn rest post /api/now/table/incident --data '{"short_description":"test"}'
  jsn rest patch /api/now/table/incident/sys_id --data '{"state":"2"}'
  jsn rest delete /api/now/table/incident/sys_id
  jsn rest get /api/x_myapp/custom_api/resource
  jsn rest post /api/now/import/my_import_set --data '{"field":"value"}'
  jsn rest get /api/now/stats/incident?sysparm_count=true`,
	}

	cmd.AddCommand(
		newRestGetCmd(),
		newRestPostCmd(),
		newRestPatchCmd(),
		newRestDeleteCmd(),
	)

	return cmd
}

// parseHeaders converts ["Key: Value", ...] to map[string]string.
func parseHeaders(raw []string) map[string]string {
	headers := make(map[string]string)
	for _, h := range raw {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) == 2 {
			headers[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	return headers
}

// parseBody parses a JSON string into a map.
func parseBody(data string) (map[string]interface{}, error) {
	if data == "" {
		return nil, nil
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(data), &body); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	return body, nil
}

// runRest executes a REST call and outputs the result.
func runRest(cmd *cobra.Command, method, path string, flags restFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	sdkClient := appCtx.SDK.(*sdk.Client)
	outputWriter := appCtx.Output.(*output.Writer)

	// Ensure path starts with /
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	// Parse body for POST/PATCH
	body, err := parseBody(flags.data)
	if err != nil {
		return err
	}

	// Parse custom headers
	headers := parseHeaders(flags.headers)

	// Make the request
	result, statusCode, err := sdkClient.RawRequest(cmd.Context(), method, path, body, headers)
	if err != nil {
		return fmt.Errorf("REST %s %s failed: %w", method, path, err)
	}

	// Check for error status codes
	if statusCode >= 400 {
		return fmt.Errorf("REST %s %s returned status %d: %v", method, path, statusCode, result)
	}

	format := outputWriter.GetFormat()
	isTTY := output.IsTTY(cmd.OutOrStdout())

	effectiveFormat := format
	if format == output.FormatAuto {
		if isTTY {
			effectiveFormat = output.FormatStyled
		} else {
			effectiveFormat = output.FormatJSON
		}
	}

	if effectiveFormat == output.FormatStyled {
		return printStyledRest(cmd, method, path, statusCode, result, sdkClient.GetBaseURL())
	}

	// Build response envelope
	responseData := map[string]interface{}{
		"status": statusCode,
		"method": method,
		"path":   path,
		"body":   result,
	}

	return outputWriter.OK(responseData,
		output.WithSummary(fmt.Sprintf("%s %s -> %d", method, path, statusCode)),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "retry",
				Cmd:         fmt.Sprintf("jsn rest %s %s", strings.ToLower(method), path),
				Description: "Repeat this request",
			},
		),
	)
}

// printStyledRest renders a styled terminal output for REST responses.
func printStyledRest(cmd *cobra.Command, method, path string, statusCode int, result interface{}, baseURL string) error {
	w := cmd.OutOrStdout()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor)
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	successStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#00cc00"))
	errorStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#cc0000"))

	// Status line
	statusStr := fmt.Sprintf("%d", statusCode)
	if statusCode < 400 {
		statusStr = successStyle.Render(statusStr)
	} else {
		statusStr = errorStyle.Render(statusStr)
	}

	fmt.Fprintln(w)
	fmt.Fprintf(w, "%s  %s %s  %s\n",
		headerStyle.Render(method),
		mutedStyle.Render(baseURL+path),
		mutedStyle.Render("->"),
		statusStr,
	)
	fmt.Fprintln(w)

	// Pretty print the response body
	if result != nil {
		jsonBytes, err := json.MarshalIndent(result, "  ", "  ")
		if err != nil {
			fmt.Fprintf(w, "  %v\n", result)
		} else {
			fmt.Fprintf(w, "  %s\n", string(jsonBytes))
		}
	} else {
		fmt.Fprintln(w, mutedStyle.Render("  (no response body)"))
	}

	fmt.Fprintln(w)

	return nil
}

// ─── GET ────────────────────────────────────────────────────────────────────

func newRestGetCmd() *cobra.Command {
	var flags restFlags

	cmd := &cobra.Command{
		Use:   "get <path>",
		Short: "Perform a GET request",
		Long: `Perform a GET request to any endpoint on the instance.

The path is appended to the instance base URL. Query parameters can be
included directly in the path.

Examples:
  jsn rest get /api/now/table/incident?sysparm_limit=5
  jsn rest get /api/x_myapp/custom_api/resource
  jsn rest get /api/now/stats/incident?sysparm_count=true
  jsn rest get /api/now/cmdb/instance/cmdb_ci_server
  jsn rest get /api/sn_sc/servicecatalog/items`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRest(cmd, "GET", args[0], flags)
		},
	}

	cmd.Flags().StringSliceVarP(&flags.headers, "header", "H", nil, "Custom headers (e.g., -H 'X-Custom: value')")

	return cmd
}

// ─── POST ───────────────────────────────────────────────────────────────────

func newRestPostCmd() *cobra.Command {
	var flags restFlags

	cmd := &cobra.Command{
		Use:   "post <path>",
		Short: "Perform a POST request",
		Long: `Perform a POST request to any endpoint on the instance.

Use --data to provide a JSON request body.

Examples:
  jsn rest post /api/now/table/incident --data '{"short_description":"Created via REST"}'
  jsn rest post /api/x_myapp/custom_api/action --data '{"param":"value"}'
  jsn rest post /api/now/import/my_import_set --data '{"field":"value"}'
  jsn rest post /api/sn_sc/servicecatalog/items/sys_id/order_now --data '{"sysparm_quantity":1}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRest(cmd, "POST", args[0], flags)
		},
	}

	cmd.Flags().StringVarP(&flags.data, "data", "d", "", "JSON request body")
	cmd.Flags().StringSliceVarP(&flags.headers, "header", "H", nil, "Custom headers (e.g., -H 'X-Custom: value')")

	return cmd
}

// ─── PATCH ──────────────────────────────────────────────────────────────────

func newRestPatchCmd() *cobra.Command {
	var flags restFlags

	cmd := &cobra.Command{
		Use:   "patch <path>",
		Short: "Perform a PATCH request",
		Long: `Perform a PATCH request to any endpoint on the instance.

Use --data to provide a JSON request body with the fields to update.

Examples:
  jsn rest patch /api/now/table/incident/sys_id --data '{"state":"2"}'
  jsn rest patch /api/x_myapp/custom_api/resource/id --data '{"status":"active"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRest(cmd, "PATCH", args[0], flags)
		},
	}

	cmd.Flags().StringVarP(&flags.data, "data", "d", "", "JSON request body")
	cmd.Flags().StringSliceVarP(&flags.headers, "header", "H", nil, "Custom headers (e.g., -H 'X-Custom: value')")

	return cmd
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

func newRestDeleteCmd() *cobra.Command {
	var flags restFlags

	cmd := &cobra.Command{
		Use:   "delete <path>",
		Short: "Perform a DELETE request",
		Long: `Perform a DELETE request to any endpoint on the instance.

Examples:
  jsn rest delete /api/now/table/incident/sys_id
  jsn rest delete /api/x_myapp/custom_api/resource/id`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRest(cmd, "DELETE", args[0], flags)
		},
	}

	cmd.Flags().StringSliceVarP(&flags.headers, "header", "H", nil, "Custom headers (e.g., -H 'X-Custom: value')")

	return cmd
}
