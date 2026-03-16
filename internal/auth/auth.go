// Package auth provides authentication management for ServiceNow.
package auth

import (
	"fmt"
	"os"

	"github.com/jacebenson/jsn/internal/config"
)

const (
	serviceName = "servicenow"
)

// Manager handles authentication.
type Manager struct {
	cfg   *config.Config
	store *Store
}

// NewManager creates a new auth manager.
func NewManager(cfg *config.Config) *Manager {
	return &Manager{
		cfg:   cfg,
		store: NewStore(config.GlobalConfigDir()),
	}
}

// credentialKey returns the storage key for credentials.
// Uses the active profile's instance URL as the key.
func (m *Manager) credentialKey() string {
	if profile := m.cfg.GetActiveProfile(); profile != nil {
		return profile.InstanceURL
	}
	return ""
}

// GetCredentials retrieves credentials for the active profile.
// Checks SERVICENOW_TOKEN env var first, then stored credentials.
func (m *Manager) GetCredentials() (*Credentials, error) {
	// Check for SERVICENOW_TOKEN environment variable first
	if token := os.Getenv("SERVICENOW_TOKEN"); token != "" {
		return &Credentials{
			Token:     token,
			CreatedAt: 0,
		}, nil
	}

	credKey := m.credentialKey()
	if credKey == "" {
		return nil, fmt.Errorf("no active profile configured")
	}

	return m.store.Load(credKey)
}

// StoreCredentials stores credentials for the active profile.
func (m *Manager) StoreCredentials(creds *Credentials) error {
	credKey := m.credentialKey()
	if credKey == "" {
		return fmt.Errorf("no active profile configured")
	}

	return m.store.Save(credKey, creds)
}

// DeleteCredentials removes credentials for the active profile.
func (m *Manager) DeleteCredentials() error {
	credKey := m.credentialKey()
	if credKey == "" {
		return fmt.Errorf("no active profile configured")
	}

	return m.store.Delete(credKey)
}

// IsAuthenticated checks if there are valid credentials for the active profile.
func (m *Manager) IsAuthenticated() bool {
	// Check for SERVICENOW_TOKEN environment variable first
	if os.Getenv("SERVICENOW_TOKEN") != "" {
		return true
	}

	credKey := m.credentialKey()
	if credKey == "" {
		return false
	}

	creds, err := m.store.Load(credKey)
	if err != nil {
		return false
	}
	return creds.Token != ""
}

// GetStore returns the credential store.
func (m *Manager) GetStore() *Store {
	return m.store
}

// Credentials holds authentication tokens.
type Credentials struct {
	Token     string `json:"token"`
	Username  string `json:"username,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	CreatedAt int64  `json:"created_at"`
}
