package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad_NoConfigFile(t *testing.T) {
	// Use a temp directory that doesn't have a config
	tmpDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmpDir)

	cfg, err := Load("", "")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg == nil {
		t.Fatal("Load() returned nil config")
	}

	// Should have empty profiles
	if len(cfg.Profiles) != 0 {
		t.Errorf("expected 0 profiles, got %d", len(cfg.Profiles))
	}
}

func TestGlobalConfigPath(t *testing.T) {
	// Test with XDG_CONFIG_HOME set
	tmpDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmpDir)

	path := GlobalConfigPath()
	expected := filepath.Join(tmpDir, "servicenow", "config.json")
	if path != expected {
		t.Errorf("GlobalConfigPath() = %v, want %v", path, expected)
	}
}

func TestGlobalConfigPath_HomeFallback(t *testing.T) {
	// Unset XDG_CONFIG_HOME to test fallback
	t.Setenv("XDG_CONFIG_HOME", "")

	path := GlobalConfigPath()

	// Should contain .config/servicenow/config.json
	if !contains(path, ".config") || !contains(path, "servicenow") {
		t.Errorf("GlobalConfigPath() = %v, should contain .config and servicenow", path)
	}
}

func TestConfig_SaveAndLoad(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmpDir)

	cfg := &Config{
		DefaultProfile: "test",
		Profiles: map[string]*Profile{
			"test": {
				InstanceURL: "https://test.service-now.com",
				Username:    "admin",
				AuthMethod:  "basic",
			},
		},
	}

	// Save
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	// Verify file exists
	path := GlobalConfigPath()
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("Config file was not created")
	}

	// Load
	loaded, err := Load("", "")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if loaded.DefaultProfile != "test" {
		t.Errorf("DefaultProfile = %v, want test", loaded.DefaultProfile)
	}

	profile, ok := loaded.Profiles["test"]
	if !ok {
		t.Fatal("test profile not found")
	}

	if profile.InstanceURL != "https://test.service-now.com" {
		t.Errorf("InstanceURL = %v, want https://test.service-now.com", profile.InstanceURL)
	}
}

func TestConfig_GetProfile(t *testing.T) {
	cfg := &Config{
		DefaultProfile: "prod",
		Profiles: map[string]*Profile{
			"prod": {InstanceURL: "https://prod.example.com"},
			"dev":  {InstanceURL: "https://dev.example.com"},
		},
	}

	// Get explicit profile
	profile, ok := cfg.GetProfile("dev")
	if !ok {
		t.Error("GetProfile(dev) returned false")
	}
	if profile.InstanceURL != "https://dev.example.com" {
		t.Errorf("wrong profile: %v", profile.InstanceURL)
	}

	// Get default profile (empty string)
	profile, ok = cfg.GetProfile("")
	if !ok {
		t.Error("GetProfile(\"\") returned false")
	}
	if profile.InstanceURL != "https://prod.example.com" {
		t.Errorf("wrong default profile: %v", profile.InstanceURL)
	}

	// Get non-existent profile
	_, ok = cfg.GetProfile("staging")
	if ok {
		t.Error("GetProfile(staging) should return false")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
