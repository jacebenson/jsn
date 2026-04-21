package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestAuthCmd tests the auth command
func TestAuthCmd(t *testing.T) {
	cmd := NewAuthCommand()
	assert.NotNil(t, cmd, "Command should not be nil")
	assert.Equal(t, "auth", cmd.Use, "Command use should match")
	assert.NotEmpty(t, cmd.Short, "Command should have a short description")

	// Check subcommands
	subcommands := []string{"login", "logout", "status"}
	for _, name := range subcommands {
		t.Run(name, func(t *testing.T) {
			sub := findSubcommand(cmd, name)
			assert.NotNil(t, sub, "Subcommand %s should exist", name)
		})
	}
}

// TestAuthLoginSubcommand tests the auth login subcommand
func TestAuthLoginSubcommand(t *testing.T) {
	cmd := NewAuthCommand()
	loginCmd := findSubcommand(cmd, "login")
	assert.NotNil(t, loginCmd, "login subcommand should exist")

	// Check flags that actually exist (based on auth.go implementation)
	flags := []string{"method"}
	for _, flag := range flags {
		assert.NotNil(t, loginCmd.Flag(flag), "Flag --%s should exist", flag)
	}
}

// TestAuthLogoutSubcommand tests the auth logout subcommand
func TestAuthLogoutSubcommand(t *testing.T) {
	cmd := NewAuthCommand()
	logoutCmd := findSubcommand(cmd, "logout")
	assert.NotNil(t, logoutCmd, "logout subcommand should exist")
}

// TestAuthStatusSubcommand tests the auth status subcommand
func TestAuthStatusSubcommand(t *testing.T) {
	cmd := NewAuthCommand()
	statusCmd := findSubcommand(cmd, "status")
	assert.NotNil(t, statusCmd, "status subcommand should exist")
}
