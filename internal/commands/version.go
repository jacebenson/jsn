package commands

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/version"
	"github.com/spf13/cobra"
)

// NewVersionCmd creates the version command.
func NewVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show version information",
		Long:  "Show the installed jsn CLI version and check for available updates.",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Show version info
			fmt.Fprintln(cmd.OutOrStdout(), version.Full())

			// Check for updates (skip for dev builds)
			if !version.IsDev() {
				result := version.CheckLatest()
				if result.Error == nil && result.UpdateAvailable {
					fmt.Fprintln(cmd.OutOrStdout())
					updateStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#ffaa00"))
					fmt.Fprintf(cmd.OutOrStdout(), "%s v%s is available. Run 'curl -fsSL https://jsn.jace.pro/install | bash' to update.\n",
						updateStyle.Render("Note:"),
						result.Latest)
				}
			}

			return nil
		},
	}
}
