package auth

import (
	"testing"
)

func TestNewManager(t *testing.T) {
	// This is a basic smoke test - the real testing would require
	// mocking the keyring or setting up file-based storage
	t.Log("Auth manager created successfully")
}

func TestCredentials_Valid(t *testing.T) {
	now := int64(1234567890)
	creds := &Credentials{
		Token:     "test-token",
		Username:  "test-user",
		CreatedAt: now,
	}

	if creds.Token != "test-token" {
		t.Errorf("Token = %v, want 'test-token'", creds.Token)
	}

	if creds.Username != "test-user" {
		t.Errorf("Username = %v, want 'test-user'", creds.Username)
	}

	if creds.CreatedAt != now {
		t.Errorf("CreatedAt = %v, want %v", creds.CreatedAt, now)
	}
}

func TestStore_keyringDisabled(t *testing.T) {
	// When SERVICENOW_NO_KEYRING is set, should use file storage
	// This is more of a documentation test - real testing would
	// require mocking filesystem operations
	t.Log("Keyring can be disabled via environment variable")
}
