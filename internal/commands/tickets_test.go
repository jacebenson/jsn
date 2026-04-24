package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewTicketsCmd(t *testing.T) {
	cmd := NewTicketsCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "tickets", cmd.Name())
	assert.Contains(t, cmd.Aliases, "ticket")
}

func TestNewTicketsListCmd(t *testing.T) {
	cmd := newTicketsListCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Name())

	// Check flags exist
	flag := cmd.Flag("query")
	assert.NotNil(t, flag)

	flag = cmd.Flag("limit")
	assert.NotNil(t, flag)

	flag = cmd.Flag("offset")
	assert.NotNil(t, flag)
}

func TestNewTicketsShowCmd(t *testing.T) {
	cmd := newTicketsShowCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "show", cmd.Name())
	assert.NotNil(t, cmd.Args)
}

func TestNewTicketsCreateCmd(t *testing.T) {
	cmd := newTicketsCreateCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Name())

	flag := cmd.Flag("data")
	assert.NotNil(t, flag)
}

func TestNewTicketsUpdateCmd(t *testing.T) {
	cmd := newTicketsUpdateCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "update", cmd.Name())

	flag := cmd.Flag("data")
	assert.NotNil(t, flag)
}

func TestNewTicketsDeleteCmd(t *testing.T) {
	cmd := newTicketsDeleteCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "delete", cmd.Name())
	assert.NotNil(t, cmd.Args)
}
