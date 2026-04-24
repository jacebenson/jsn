// Package dev provides developer utility commands.
package dev

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// NewRestCmd creates the rest command for raw REST API access.
func NewRestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rest [endpoint]",
		Short: "Make raw REST API calls to ServiceNow",
		Long: `Make raw REST API calls to ServiceNow.

This command provides direct access to the ServiceNow REST API for advanced use cases.

Examples:
  # GET request to Table API
  jsn dev rest api/now/table/incident --method GET

  # POST request with data
  jsn dev rest api/now/table/incident --method POST --data '{"short_description":"Test"}'

  # Use --table shorthand for table API
  jsn dev rest --table incident --method GET --query "priority=1"

  # Update a record
  jsn dev rest api/now/table/incident/abc123 --method PUT --data '{"state":"6"}'

  # Delete a record
  jsn dev rest api/now/table/incident/abc123 --method DELETE`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			// Get flags
			method, _ := cmd.Flags().GetString("method")
			data, _ := cmd.Flags().GetString("data")
			table, _ := cmd.Flags().GetString("table")
			query, _ := cmd.Flags().GetString("query")

			// Determine endpoint
			var endpoint string
			if table != "" {
				// Build table API endpoint
				endpoint = fmt.Sprintf("api/now/table/%s", table)
				if len(args) > 0 {
					// Append sys_id if provided
					endpoint = fmt.Sprintf("%s/%s", endpoint, args[0])
				}
			} else if len(args) > 0 {
				endpoint = args[0]
			} else {
				return fmt.Errorf("either provide an endpoint argument or use --table flag")
			}

			return makeRestCall(cmd.Context(), app, method, endpoint, data, query)
		},
	}

	cmd.Flags().StringP("method", "X", "GET", "HTTP method (GET, POST, PUT, DELETE, PATCH)")
	cmd.Flags().StringP("data", "d", "", "Request body data (JSON string)")
	cmd.Flags().StringP("table", "t", "", "Table name (shorthand for api/now/table/{table})")
	cmd.Flags().StringP("query", "", "", "Query parameters (e.g., 'sysparm_limit=10&sysparm_fields=number')")

	return cmd
}

func makeRestCall(ctx interface{}, app *appctx.App, method, endpoint, data, queryStr string) error {
	// Ensure endpoint doesn't start with /
	endpoint = strings.TrimPrefix(endpoint, "/")

	// Build full URL
	baseURL := app.Config.GetEffectiveInstance()
	if baseURL == "" {
		return fmt.Errorf("no instance configured")
	}

	// Validate HTTP method
	method = strings.ToUpper(method)
	validMethods := map[string]bool{"GET": true, "POST": true, "PUT": true, "DELETE": true, "PATCH": true}
	if !validMethods[method] {
		return fmt.Errorf("invalid HTTP method: %s (must be GET, POST, PUT, DELETE, or PATCH)", method)
	}

	// For now, this is a stub that shows what would be executed
	// Full implementation would require access to raw credentials from the SDK
	return app.OK(map[string]interface{}{
		"status":   "stub",
		"message":  "Raw REST API access is not yet fully implemented",
		"method":   method,
		"endpoint": endpoint,
		"data":     data,
		"query":    queryStr,
		"instance": baseURL,
		"note":     "This would make a raw HTTP request to the ServiceNow REST API",
	},
		output.WithSummary(fmt.Sprintf("%s %s (stub)", method, endpoint)),
	)
}
