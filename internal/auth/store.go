package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

// Store wraps keyring access with typed Credentials marshaling.
type Store struct {
	inner       *keyringStore
	fallbackDir string
	warnOnce    sync.Once
}

// keyringStore wraps the actual keyring implementation.
type keyringStore struct {
	serviceName string
}

// NewStore creates a credential store.
func NewStore(fallbackDir string) *Store {
	return &Store{
		inner: &keyringStore{
			serviceName: serviceName,
		},
		fallbackDir: fallbackDir,
	}
}

// Load retrieves credentials for the given origin.
func (s *Store) Load(origin string) (*Credentials, error) {
	// Check if keyring is disabled
	if os.Getenv("SERVICENOW_NO_KEYRING") != "" {
		return s.loadFromFile(origin)
	}

	// Try keyring first
	secret, err := keyring.Get(s.inner.serviceName, origin)
	if err == keyring.ErrNotFound {
		return s.loadFromFile(origin)
	}
	if err != nil {
		return s.loadFromFile(origin)
	}

	var creds Credentials
	if err := json.Unmarshal([]byte(secret), &creds); err != nil {
		return nil, fmt.Errorf("invalid credentials: %w", err)
	}
	return &creds, nil
}

// Save stores credentials for the given origin.
func (s *Store) Save(origin string, creds *Credentials) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}

	// Check if keyring is disabled
	if os.Getenv("SERVICENOW_NO_KEYRING") != "" {
		return s.saveToFile(origin, creds)
	}

	// Try keyring first, fallback to file
	if err := keyring.Set(s.inner.serviceName, origin, string(data)); err != nil {
		s.warnFallback()
		return s.saveToFile(origin, creds)
	}
	return nil
}

// Delete removes credentials for the given origin.
func (s *Store) Delete(origin string) error {
	// Check if keyring is disabled
	if os.Getenv("SERVICENOW_NO_KEYRING") == "" {
		_ = keyring.Delete(s.inner.serviceName, origin) // Ignore error - may not exist
	}
	return s.deleteFromFile(origin)
}

// loadFromFile loads credentials from the fallback file.
func (s *Store) loadFromFile(origin string) (*Credentials, error) {
	path := s.credentialsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var creds map[string]Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, err
	}

	c, ok := creds[origin]
	if !ok {
		return nil, fmt.Errorf("no credentials found for %s", origin)
	}
	return &c, nil
}

// saveToFile saves credentials to the fallback file.
func (s *Store) saveToFile(origin string, creds *Credentials) error {
	path := s.credentialsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	var existing map[string]Credentials
	data, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(data, &existing) // Ignore error - will start fresh if invalid
	}
	if existing == nil {
		existing = make(map[string]Credentials)
	}

	existing[origin] = *creds

	data, err = json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// deleteFromFile removes credentials from the fallback file.
func (s *Store) deleteFromFile(origin string) error {
	path := s.credentialsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var existing map[string]Credentials
	if err := json.Unmarshal(data, &existing); err != nil {
		return nil
	}

	delete(existing, origin)

	data, err = json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// credentialsPath returns the path to the fallback credentials file.
func (s *Store) credentialsPath() string {
	return filepath.Join(s.fallbackDir, "credentials.json")
}

// warnFallback prints a warning once if keyring is not available.
func (s *Store) warnFallback() {
	s.warnOnce.Do(func() {
		fmt.Fprintln(os.Stderr, "warning: could not use system keyring, falling back to file storage")
	})
}

// UsingKeyring returns true if the store is using the system keyring.
func (s *Store) UsingKeyring() bool {
	return os.Getenv("SERVICENOW_NO_KEYRING") == ""
}
