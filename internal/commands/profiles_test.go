package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewProfilesCmd(t *testing.T) {
	cmd := NewProfilesCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "profiles", cmd.Use)
	assert.Contains(t, cmd.Short, "profiles")
	assert.Contains(t, cmd.Long, "instance")
}

func TestProfilesListCmd(t *testing.T) {
	profilesCmd := NewProfilesCmd()
	cmd, _, err := profilesCmd.Find([]string{"list"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Name())
}

func TestProfilesUseCmd(t *testing.T) {
	profilesCmd := NewProfilesCmd()
	cmd, _, err := profilesCmd.Find([]string{"use"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "use", cmd.Name())
}

func TestProfilesShowCmd(t *testing.T) {
	profilesCmd := NewProfilesCmd()
	cmd, _, err := profilesCmd.Find([]string{"show"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "show", cmd.Name())
}
