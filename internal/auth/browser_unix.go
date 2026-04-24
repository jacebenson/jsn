//go:build !windows && !darwin
// +build !windows,!darwin

package auth

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openBrowser opens the specified URL in the default browser.
func openBrowser(url string) error {
	switch runtime.GOOS {
	case "linux":
		return exec.Command("xdg-open", url).Start()
	default:
		return fmt.Errorf("unsupported platform")
	}
}
