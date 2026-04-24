package commands

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewRecordsCmd(t *testing.T) {
	cmd := NewRecordsCmd()
	assert.NotNil(t, cmd)
	assert.Equal(t, "records", cmd.Use)
	assert.Contains(t, cmd.Short, "table")
}

func TestRecordsListCmd(t *testing.T) {
	recordsCmd := NewRecordsCmd()
	cmd, _, err := recordsCmd.Find([]string{"list"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "list", cmd.Name())

	// Check flags exist
	tableFlag := cmd.Flags().Lookup("table")
	assert.NotNil(t, tableFlag)

	queryFlag := cmd.Flags().Lookup("query")
	assert.NotNil(t, queryFlag)

	columnsFlag := cmd.Flags().Lookup("columns")
	assert.NotNil(t, columnsFlag)

	limitFlag := cmd.Flags().Lookup("limit")
	assert.NotNil(t, limitFlag)
}

func TestRecordsGetCmd(t *testing.T) {
	recordsCmd := NewRecordsCmd()
	cmd, _, err := recordsCmd.Find([]string{"get"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "get", cmd.Name())
}

func TestRecordsCreateCmd(t *testing.T) {
	recordsCmd := NewRecordsCmd()
	cmd, _, err := recordsCmd.Find([]string{"create"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "create", cmd.Name())
}

func TestRecordsUpdateCmd(t *testing.T) {
	recordsCmd := NewRecordsCmd()
	cmd, _, err := recordsCmd.Find([]string{"update"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "update", cmd.Name())
}

func TestRecordsDeleteCmd(t *testing.T) {
	recordsCmd := NewRecordsCmd()
	cmd, _, err := recordsCmd.Find([]string{"delete"})
	assert.NoError(t, err)
	assert.NotNil(t, cmd)
	assert.Equal(t, "delete", cmd.Name())
}
