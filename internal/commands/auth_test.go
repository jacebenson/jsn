package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAuthCmd(t *testing.T) {
	cmd := NewAuthCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "auth", cmd.Use)
	assert.Contains(t, cmd.Long, "OAuth")
	assert.Contains(t, cmd.Long, "SDK")
}

func TestAuthLoginCmd(t *testing.T) {
	authCmd := NewAuthCmd()
	cmd, _, err := authCmd.Find([]string{"login"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "login", cmd.Name())

	// Verify help mentions SDK-style OAuth
	assert.Contains(t, cmd.Long, "SDK")
	assert.Contains(t, cmd.Long, "PKCE")
}

func TestAuthLogoutCmd(t *testing.T) {
	authCmd := NewAuthCmd()
	cmd, _, err := authCmd.Find([]string{"logout"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "logout", cmd.Name())
}

func TestAuthStatusCmd(t *testing.T) {
	authCmd := NewAuthCmd()
	cmd, _, err := authCmd.Find([]string{"status"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "status", cmd.Name())
}
