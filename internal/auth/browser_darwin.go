//go:build darwin
// +build darwin

package auth

import (
	"os/exec"
)

// openBrowser opens the specified URL in the default browser.
func openBrowser(url string) error {
	return exec.Command("open", url).Start()
}
