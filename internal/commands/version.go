package commands

import (
	"fmt"

	"github.com/jacebenson/jsn/internal/version"
	"github.com/spf13/cobra"
)

// NewVersionCmd creates the version command.
func NewVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show version information",
		Long:  "Show the installed jsn CLI version.",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), version.Full())
			return err
		},
	}
}
