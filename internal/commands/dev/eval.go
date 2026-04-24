// Package dev provides developer utility commands.
package dev

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// NewEvalCmd creates the eval command for background scripts.
func NewEvalCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "eval",
		Short: "Execute background scripts (eval)",
		Long: `Execute ServiceNow background scripts (server-side JavaScript/GS.eval).

WARNING: This is a stub implementation. Background script execution requires
careful handling as it runs with admin privileges on the ServiceNow instance.

Examples:
  # Run a script from command line
  jsn dev eval --script 'gs.info("Hello from background script");'

  # Run a script from file (future)
  jsn dev eval --file script.js

  # Run with variables (future)
  jsn dev eval --script 'gs.info(current.name);' --vars '{"current":"incident:abc123"}'`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			script, _ := cmd.Flags().GetString("script")
			if script == "" {
				return fmt.Errorf("--script is required")
			}

			return runBackgroundScript(cmd.Context(), app, script)
		},
	}

	cmd.Flags().StringP("script", "s", "", "JavaScript code to execute (required)")

	return cmd
}

func runBackgroundScript(ctx interface{}, app *appctx.App, script string) error {
	// STUB: Background script execution is a complex operation that requires:
	// 1. Access to the /sys.scripts.do endpoint (or similar)
	// 2. Proper CSRF token handling
	// 3. Parsing the execution results from HTML response
	// 4. Security considerations (admin-level access)

	// For now, we just display what would be executed
	return app.OK(map[string]interface{}{
		"status":   "stub",
		"message":  "Background script execution is not yet implemented",
		"script":   script,
		"note":     "This would execute the script on the ServiceNow instance with admin privileges",
		"instance": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary("Background Script (Stub)"),
	)
}
