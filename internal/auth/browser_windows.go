//go:build windows
// +build windows

package auth

import (
	"os/exec"
)

// openBrowser opens the specified URL in the default browser.
func openBrowser(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
