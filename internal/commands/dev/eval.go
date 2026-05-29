// Package dev provides developer utility commands.
package dev

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// NewEvalCmd creates the eval command for background scripts.
func NewEvalCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "eval",
		Short: "Execute background scripts on the instance",
		Long: `Execute ServiceNow background scripts (server-side JavaScript).

Scripts run via sys.scripts.do with the same privileges as the authenticated user.`,
		Example: `  # Run a script inline
  jsn dev eval --script 'gs.info("Hello");'

  # Run a script from a file
  jsn dev eval --file background.js`,
		RunE: func(cmd *cobra.Command, args []string) error {
			app := appctx.FromContext(cmd.Context())

			script, _ := cmd.Flags().GetString("script")
			file, _ := cmd.Flags().GetString("file")

			switch {
			case file != "":
				data, err := os.ReadFile(file)
				if err != nil {
					return fmt.Errorf("reading script file: %w", err)
				}
				script = string(data)
			case script == "":
				return fmt.Errorf("--script or --file is required")
			}

			return runBackgroundScript(cmd.Context(), app, script)
		},
	}

	cmd.Flags().StringP("script", "s", "", "JavaScript code to execute")
	cmd.Flags().StringP("file", "f", "", "Read script from file")

	return cmd
}

func runBackgroundScript(ctx context.Context, app *appctx.App, script string) error {
	outputText, err := app.SDK.ExecuteScript(ctx, script)
	if err != nil {
		return app.Err(fmt.Errorf("script execution failed: %w\n\nThis may be due to:\n- Auth method (OAuth tokens may not work with sys.scripts.do)\n- Instance configuration\n- Try using basic auth credentials or the browser-based Background Scripts page", err))
	}

	return app.OK(map[string]interface{}{
		"script":   script,
		"output":   outputText,
		"instance": app.Config.GetEffectiveInstance(),
	},
		output.WithSummary("Script executed"),
		output.WithBreadcrumbs(
			output.Breadcrumb{
				Action:      "eval",
				Cmd:        "jsn dev eval --script '...'",
				Description: "Execute a background script on the ServiceNow instance",
			},
		),
	)
}
