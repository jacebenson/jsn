package commands

import (
	"fmt"
	"strings"

	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/spf13/cobra"
)

// generateFlags holds the flags for generate commands.
type generateFlags struct {
	scope     string
	count     int
	operation string
}

// NewGenerateCmd creates the generate command group.
func NewGenerateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "generate",
		Short: "Generate code templates",
		Long:  "Generate GlideRecord templates, Script Include templates, REST API templates, and more.",
	}

	cmd.AddCommand(
		newGenerateGlideRecordCmd(),
		newGenerateScriptIncludeCmd(),
		newGenerateRESTCmd(),
		newGenerateTestCmd(),
		newGenerateACLCmd(),
	)

	return cmd
}

// newGenerateGlideRecordCmd creates the generate gliderecord command.
func newGenerateGlideRecordCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "gliderecord <table>",
		Short: "Generate GlideRecord template",
		Long: `Generate a GlideRecord script template for a table.

Examples:
  jsn generate gliderecord incident
  jsn generate gliderecord task`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGenerateGlideRecord(cmd, args[0])
		},
	}
}

// runGenerateGlideRecord executes the generate gliderecord command.
func runGenerateGlideRecord(cmd *cobra.Command, table string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	template := fmt.Sprintf(`var gr = new GlideRecord('%s');
gr.addQuery('active', true);
gr.query();

while (gr.next()) {
    // Process record
    gs.info('Record: ' + gr.sys_id);
}`, table)

	fmt.Fprintln(cmd.OutOrStdout(), template)
	return nil
}

// newGenerateScriptIncludeCmd creates the generate script-include command.
func newGenerateScriptIncludeCmd() *cobra.Command {
	var flags generateFlags

	cmd := &cobra.Command{
		Use:   "script-include <name>",
		Short: "Generate Script Include template",
		Long: `Generate a Script Include template.

Examples:
  jsn generate script-include MyClass
  jsn generate script-include MyClass --scope myapp`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGenerateScriptInclude(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVarP(&flags.scope, "scope", "s", "global", "Scope for the script include")

	return cmd
}

// runGenerateScriptInclude executes the generate script-include command.
func runGenerateScriptInclude(cmd *cobra.Command, name string, flags generateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	className := strings.ReplaceAll(name, " ", "_")
	className = strings.ReplaceAll(className, "-", "_")

	template := fmt.Sprintf(`var %s = Class.create();
%s.prototype = {
    initialize: function() {
        // Initialize
    },
    
    // Add your methods here
    myMethod: function() {
        return 'Hello from %s';
    },

    type: '%s'
};`, className, className, className, className)

	fmt.Fprintln(cmd.OutOrStdout(), template)
	return nil
}

// newGenerateRESTCmd creates the generate rest command.
func newGenerateRESTCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rest <name>",
		Short: "Generate Scripted REST API template",
		Long: `Generate a Scripted REST API template.

Examples:
  jsn generate rest MyAPI
  jsn generate rest IncidentAPI`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGenerateREST(cmd, args[0])
		},
	}
}

// runGenerateREST executes the generate rest command.
func runGenerateREST(cmd *cobra.Command, name string) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	template := fmt.Sprintf(`(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    // Process the request
    var queryParams = request.queryParams;
    var pathParams = request.pathParams;
    
    // Set response
    response.setStatus(200);
    response.setContentType('application/json');
    
    var result = {
        message: 'Hello from %s',
        pathParams: pathParams,
        queryParams: queryParams
    };
    
    response.setBody(result);
})(request, response);`, name)

	fmt.Fprintln(cmd.OutOrStdout(), template)
	return nil
}

// newGenerateTestCmd creates the generate test command.
func newGenerateTestCmd() *cobra.Command {
	var flags generateFlags

	cmd := &cobra.Command{
		Use:   "test <table>",
		Short: "Generate test data template",
		Long: `Generate a script to create test data.

Examples:
  jsn generate test incident --count 10
  jsn generate test task --count 5`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGenerateTest(cmd, args[0], flags)
		},
	}

	cmd.Flags().IntVarP(&flags.count, "count", "n", 5, "Number of test records to generate")

	return cmd
}

// runGenerateTest executes the generate test command.
func runGenerateTest(cmd *cobra.Command, table string, flags generateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	template := fmt.Sprintf(`// Generate %d test records for %s table
for (var i = 0; i < %d; i++) {
    var gr = new GlideRecord('%s');
    gr.initialize();
    // gr.short_description = 'Test record ' + i;
    // gr.active = true;
    // gr.insert();
}
gs.info('Generated %d test records for %s');`, flags.count, table, flags.count, table, flags.count, table)

	fmt.Fprintln(cmd.OutOrStdout(), template)
	return nil
}

// newGenerateACLCmd creates the generate acl command.
func newGenerateACLCmd() *cobra.Command {
	var flags generateFlags

	cmd := &cobra.Command{
		Use:   "acl <table>",
		Short: "Generate ACL template",
		Long: `Generate an ACL script template.

Examples:
  jsn generate acl incident --operation read
  jsn generate acl task --operation write`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGenerateACL(cmd, args[0], flags)
		},
	}

	cmd.Flags().StringVarP(&flags.operation, "operation", "o", "read", "ACL operation (read, write, create, delete)")

	return cmd
}

// runGenerateACL executes the generate acl command.
func runGenerateACL(cmd *cobra.Command, table string, flags generateFlags) error {
	appCtx := appctx.FromContext(cmd.Context())
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	template := fmt.Sprintf(`// ACL for %s - %s operation
(function executeRule(current, parent) {
    // Add your ACL logic here
    // Return true to allow access, false to deny
    
    // Example: Only allow access to active records
    // answer = current.active == true;
    
    // Example: Only allow access to records in user's department
    // answer = current.department == gs.getUser().getDepartmentID();
    
    answer = true;
})(current, parent);`, table, flags.operation)

	fmt.Fprintln(cmd.OutOrStdout(), template)
	return nil
}
