// Package appctx provides application context helpers.
package appctx

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jacebenson/jsn/internal/auth"
	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/output"
	"github.com/jacebenson/jsn/internal/sdk"
)

// Context holds runtime context information
type Context struct {
	ProfileName string
	Username    string
	Scope       string
	UpdateSet   string
}

// contextKey is a private type for context keys.
type contextKey string

const appKey contextKey = "app"

// App holds the shared application context for all commands.
type App struct {
	Config  *config.Config
	Auth    *auth.Manager
	SDK     *sdk.Client
	Output  *output.Writer
	Context Context
}

// NewApp creates a new App with the given configuration.
func NewApp(cfg *config.Config) *App {
	// Create auth manager
	authMgr := auth.NewManager(cfg)

	// Create SDK client
	var sdkClient *sdk.Client
	if cfg.GetEffectiveInstance() != "" {
		sdkClient = sdk.NewClient(
			cfg.GetEffectiveInstance(),
			authMgr,
		)
	}

	// Determine output format from config
	format := output.FormatAuto
	switch cfg.Format {
	case "json":
		format = output.FormatJSON
	case "markdown", "md":
		format = output.FormatMarkdown
	case "quiet":
		format = output.FormatQuiet
	case "styled":
		format = output.FormatStyled
	}

	app := &App{
		Config: cfg,
		Auth:   authMgr,
		SDK:    sdkClient,
		Output: output.New(output.Options{
			Format: format,
			Writer: os.Stdout,
		}),
	}

	// Load context information if authenticated
	app.loadContext()

	return app
}

// loadContext loads basic runtime context from config.
// Note: Scope and UpdateSet are fetched dynamically in PrintContextHeader.
func (a *App) loadContext() {
	// Get profile name
	instance := a.Config.GetEffectiveInstance()
	if instance != "" {
		a.Context.ProfileName = extractProfileName(instance)

		// Try to get username from config
		for name, profile := range a.Config.Profiles {
			if profile.InstanceURL == instance {
				a.Context.ProfileName = name
				a.Context.Username = profile.Username
				break
			}
		}
	}
}

// extractProfileName creates a short profile name from instance URL.
func extractProfileName(instanceURL string) string {
	// Remove protocol
	name := instanceURL
	name = strings.TrimPrefix(name, "https://")
	name = strings.TrimPrefix(name, "http://")
	// Remove common suffixes
	name = strings.TrimSuffix(name, ".service-now.com")
	name = strings.TrimSuffix(name, ".servicenowservices.com")
	return name
}

// PrintContextHeader prints the contextual header like the original JSN.
// This fetches current user, scope, and update set from ServiceNow.
func (a *App) PrintContextHeader() {
	if a.Config.GetEffectiveInstance() == "" || a.SDK == nil {
		return
	}

	// Check if suppressed
	if os.Getenv("JSN_NO_HEADER") != "" || a.Output.GetFormat() == output.FormatJSON || a.Output.GetFormat() == output.FormatQuiet {
		return
	}

	// Fetch current user info dynamically
	userDisplayName := "Unknown"
	userSysID := ""

	user, err := a.SDK.GetCurrentUser(context.Background())
	if err == nil && user != nil {
		// Use full name if available, otherwise username
		if user.Name != "" {
			userDisplayName = user.Name
		} else {
			userDisplayName = user.UserName
		}
		userSysID = user.SysID
		a.Context.Username = userDisplayName
	}

	// Format username: if > 10 chars, show first 6 + "..." (total 9 chars)
	// Otherwise show full name
	displayUserName := userDisplayName
	if len(displayUserName) > 10 {
		displayUserName = displayUserName[:6] + "..."
	}

	// Get scope
	scope := "global"
	if userSysID != "" {
		app, err := a.SDK.GetCurrentApplication(context.Background(), userSysID)
		if err == nil && app != nil && app.Scope != "" {
			scope = app.Scope
		}
	}
	a.Context.Scope = scope

	// Get update set - show "Default" if none selected
	updateSet := "Default"
	updateSetSysID := ""
	if userSysID != "" {
		us, err := a.SDK.GetCurrentUpdateSet(context.Background(), userSysID)
		if err == nil && us != nil && us.Name != "" && us.Name != "-" {
			updateSet = us.Name
			updateSetSysID = us.SysID
		}
	}
	a.Context.UpdateSet = updateSet

	// Format: PROFILE(9) USER(6) [SCOPE] UPDATE SET
	// Show full scope name without shortening

	instance := a.Config.GetEffectiveInstance()

	// Build clickable links
	instanceLink := instance
	userLink := fmt.Sprintf("%s/sys_user_list.do?sysparm_query=sys_id=%s", instance, userSysID)
	scopeLink := fmt.Sprintf("%s/sys_scope.do?sysparm_query=scope=%s", instance, scope)
	// Link to specific update set if we have one, otherwise link to update set list
	updateSetLink := fmt.Sprintf("%s/sys_update_set_list.do", instance)
	if updateSetSysID != "" {
		updateSetLink = fmt.Sprintf("%s/sys_update_set.do?sys_id=%s", instance, updateSetSysID)
	}

	// Format scope with full name
	scopeFormatted := fmt.Sprintf("[%s]", scope)

	// Print hint line
	fmt.Fprintln(os.Stderr, "# Use `jsn updateset use` or `jsn scope use` to change scope/updateset")

	// Print header - PROFILE, USER, and SCOPE columns
	// USER column width is 9 to accommodate "xxxxxx..." format
	fmt.Fprintln(os.Stderr, "PROFILE   USER      [SCOPE]           UPDATE SET")

	// Print data row with OSC8 hyperlinks - all fields are now clickable!
	profileStr := output.Hyperlink(fmt.Sprintf("%-9s", a.Context.ProfileName), instanceLink)
	userStr := output.Hyperlink(fmt.Sprintf("%-9s", displayUserName), userLink)
	scopeStr := output.Hyperlink(fmt.Sprintf("%-17s", scopeFormatted), scopeLink)
	updateSetStr := output.Hyperlink(updateSet, updateSetLink)

	fmt.Fprintf(os.Stderr, "%s %s %s %s\n\n", profileStr, userStr, scopeStr, updateSetStr)
}

// OK outputs a success response.
func (a *App) OK(data any, opts ...output.ResponseOption) error {
	return a.Output.OK(data, opts...)
}

// Err outputs an error response.
func (a *App) Err(err error) error {
	return a.Output.Err(err)
}

// IsInteractive returns true if the terminal supports interactive TUI.
func (a *App) IsInteractive() bool {
	return output.IsTTY(os.Stdout)
}

// WithApp stores the app in the context.
func WithApp(ctx context.Context, app *App) context.Context {
	return context.WithValue(ctx, appKey, app)
}

// FromContext retrieves the app from the context.
func FromContext(ctx context.Context) *App {
	app, _ := ctx.Value(appKey).(*App)
	return app
}

// RequireInstance validates that an instance is configured.
func (a *App) RequireInstance() error {
	if a.Config == nil || a.Config.GetEffectiveInstance() == "" {
		return output.ErrUsage("Instance URL required. Set via --instance flag, SERVICENOW_INSTANCE_URL env, or config file.")
	}
	return nil
}

// RequireAuth validates that the user is authenticated.
func (a *App) RequireAuth() error {
	if !a.Auth.IsAuthenticated() {
		return output.ErrAuth("Not authenticated")
	}
	return nil
}
