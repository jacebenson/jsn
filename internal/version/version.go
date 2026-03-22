// Package version provides build-time version information.
// These variables are set via ldflags at build time.
package version

import (
	"fmt"
	"runtime/debug"
	"strings"
)

var (
	// Version is the semantic version (e.g., "1.0.0")
	// This is the default; overridden by ldflags at build/release time.
	Version = "0.2.3"

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
