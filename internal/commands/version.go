package commands

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/version"
	"github.com/spf13/cobra"
)

// NewVersionCmd creates the version command.
func NewVersionCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Show version information",
		Long:  "Show the installed jsn CLI version.",
		RunE: func(cmd *cobra.Command, args []string) error {
			checkFlag, _ := cmd.Flags().GetBool("check")

			if checkFlag {
				return runVersionCheck(cmd)
			}

			_, err := fmt.Fprintln(cmd.OutOrStdout(), version.Full())
			return err
		},
	}

	cmd.Flags().Bool("check", false, "Check for updates")

	cmd.AddCommand(&cobra.Command{
		Use:   "check",
		Short: "Check for available updates",
		Long:  "Check if a newer version of jsn is available on GitHub.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVersionCheck(cmd)
		},
	})

	return cmd
}

func runVersionCheck(cmd *cobra.Command) error {
	fmt.Fprintln(cmd.OutOrStdout(), "Checking for updates...")

	result := version.CheckLatest()

	if result.Error != nil {
		return result.Error
	}

	currentStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	latestStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00"))
	updateStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffaa00"))
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00ff00"))

	fmt.Fprintf(cmd.OutOrStdout(), "Current: %s\n", currentStyle.Render(result.Current))
	fmt.Fprintf(cmd.OutOrStdout(), "Latest:  %s\n", latestStyle.Render(result.Latest))

	if result.UpdateAvailable {
		fmt.Fprintln(cmd.OutOrStdout())
		fmt.Fprintln(cmd.OutOrStdout(), updateStyle.Render("Update available!"))
		fmt.Fprintln(cmd.OutOrStdout(), "Run the following to update:")
		fmt.Fprintln(cmd.OutOrStdout(), "  curl -fsSL https://raw.githubusercontent.com/jacebenson/jsn/main/scripts/install.sh | bash")
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), okStyle.Render("✓ You're up to date!"))
	}

	return nil
}
