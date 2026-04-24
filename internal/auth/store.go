// Package auth provides OAuth authentication for ServiceNow.
package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jacebenson/jsn/internal/config"
	"github.com/jacebenson/jsn/internal/sdk"
	"github.com/zalando/go-keyring"
)

// Store handles secure storage of credentials.
type Store struct {
	keyring string
}

// NewStore creates a new credential store.
func NewStore() *Store {
	return &Store{
		keyring: "servicenow-cli",
	}
}

// Save stores credentials for an instance.
func (s *Store) Save(instance string, creds *sdk.Credentials) error {
	// Normalize instance URL
	instance = normalizeURL(instance)

	// Try keyring first
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}

	err = keyring.Set(s.keyring, instance, string(data))
	if err == nil {
		return nil
	}

	// Fallback to file storage
	return s.saveToFile(instance, creds)
}

// Load retrieves credentials for an instance.
func (s *Store) Load(instance string) (*sdk.Credentials, error) {
	// Normalize instance URL
	instance = normalizeURL(instance)

	// Try keyring first
	data, err := keyring.Get(s.keyring, instance)
	if err == nil {
		var creds sdk.Credentials
		if err := json.Unmarshal([]byte(data), &creds); err != nil {
			return nil, err
		}
		return &creds, nil
	}

	// Fallback to file storage
	return s.loadFromFile(instance)
}

// Delete removes stored credentials for an instance.
func (s *Store) Delete(instance string) error {
	// Normalize instance URL
	instance = normalizeURL(instance)

	// Try to delete from keyring
	_ = keyring.Delete(s.keyring, instance)

	// Also delete from file
	path := s.credsPath(instance)
	return os.Remove(path)
}

// saveToFile saves credentials to a file.
func (s *Store) saveToFile(instance string, creds *sdk.Credentials) error {
	path := s.credsPath(instance)

	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// loadFromFile loads credentials from a file.
func (s *Store) loadFromFile(instance string) (*sdk.Credentials, error) {
	path := s.credsPath(instance)

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no credentials found")
	}

	var creds sdk.Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, err
	}

	return &creds, nil
}

// credsPath returns the path to the credentials file for an instance.
func (s *Store) credsPath(instance string) string {
	// Create a safe filename from the instance URL
	filename := strings.ReplaceAll(instance, "://", "_")
	filename = strings.ReplaceAll(filename, "/", "_")
	filename = strings.ReplaceAll(filename, ":", "_")

	return filepath.Join(config.GlobalConfigDir(), "credentials", filename+".json")
}
