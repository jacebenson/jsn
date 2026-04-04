// Package version provides build-time version information.
// These variables are set via ldflags at build time.
package version

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

const (
	// GitHubAPIURL is the GitHub API endpoint for latest release
	GitHubAPIURL = "https://api.github.com/repos/jacebenson/jsn/releases/latest"
)

// GitHubRelease represents the GitHub API response for a release
type GitHubRelease struct {
	TagName string `json:"tag_name"`
}

var (
	// Version is the semantic version (e.g., "1.0.0")
	// This is the default; overridden by ldflags at build/release time.
	Version = "0.4.4"

	// Commit is the git commit SHA
	Commit = "none"

	// Date is the build date in RFC3339 format
	Date = "unknown"
)

func init() {
	if Version == "dev" {
		if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
			Version = strings.TrimPrefix(info.Main.Version, "v")
		}
	}
}

// Full returns the full version string for display.
func Full() string {
	if Version == "dev" {
		return "jsn version dev (built from source)"
	}
	return fmt.Sprintf("jsn version %s (commit: %s, built: %s)", Version, Commit, Date)
}

// Short returns the short version string.
func Short() string {
	if Version == "dev" {
		return "dev"
	}
	return Version
}

// UserAgent returns the user agent string for API requests.
func UserAgent() string {
	v := Version
	if v == "dev" {
		v = "dev"
	}
	return "jsn/" + v + " (https://github.com/jacebenson/jsn)"
}

// IsDev returns true if this is a development build.
func IsDev() bool {
	return Version == "dev"
}

// CheckResult contains the result of a version check
type CheckResult struct {
	Current         string
	Latest          string
	IsLatest        bool
	UpdateAvailable bool
	Error           error
}

// CheckLatest fetches the latest version from the remote URL
func CheckLatest() CheckResult {
	result := CheckResult{
		Current:         Version,
		IsLatest:        false,
		UpdateAvailable: false,
	}

	// Skip check for dev builds
	if IsDev() {
		result.IsLatest = true
		return result
	}

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Get(GitHubAPIURL)
	if err != nil {
		result.Error = fmt.Errorf("failed to check for updates: %w", err)
		return result
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		result.Error = fmt.Errorf("GitHub API rate limit exceeded - try again later")
		return result
	}

	if resp.StatusCode != http.StatusOK {
		result.Error = fmt.Errorf("failed to check for updates: HTTP %d", resp.StatusCode)
		return result
	}

	var release GitHubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		result.Error = fmt.Errorf("failed to parse version: %w", err)
		return result
	}

	result.Latest = strings.TrimPrefix(release.TagName, "v")

	// Simple string comparison (assumes semver without 'v' prefix)
	result.IsLatest = result.Current == result.Latest
	result.UpdateAvailable = !result.IsLatest

	return result
}
