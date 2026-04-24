// Package config provides layered configuration loading.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const appName = "servicenow"

// Config holds the resolved configuration.
type Config struct {
	// Instance settings
	InstanceURL string `json:"instance_url,omitempty"`

	// Profile settings (named identity+environment bundles)
	Profiles       map[string]*Profile `json:"profiles,omitempty"`
	DefaultProfile string              `json:"default_profile,omitempty"`
	ActiveProfile  string              `json:"-"` // Set at runtime, not persisted

	// Output settings
	Format string `json:"format,omitempty"`

	// Sources tracks where each value came from (for debugging).
	Sources map[string]string `json:"-"`
}

// Profile holds configuration for a named profile.
type Profile struct {
	InstanceURL string `json:"instance_url"`
	AuthMethod  string `json:"auth_method,omitempty"`
	Username    string `json:"username,omitempty"`
}

// Source indicates where a config value came from.
type Source string

const (
	SourceDefault Source = "default"
	SourceSystem  Source = "system"
	SourceGlobal  Source = "global"
	SourceLocal   Source = "local"
	SourceEnv     Source = "env"
	SourceFlag    Source = "flag"
)

func (s Source) String() string {
	return string(s)
}

// FlagOverrides holds command-line flag values.
type FlagOverrides struct {
	Instance string
	Profile  string
	Format   string
}

// Default returns the default configuration.
func Default() *Config {
	return &Config{
		Format:  "auto",
		Sources: make(map[string]string),
	}
}

// Load loads configuration from all sources with proper precedence.
// Precedence: flags > env > local > global > defaults
func Load(overrides FlagOverrides) (*Config, error) {
	cfg := Default()

	// Load from file layers (global -> local)
	loadFromFile(cfg, GlobalConfigPath(), SourceGlobal)
	loadFromFile(cfg, LocalConfigPath(), SourceLocal)

	// Load from environment
	LoadFromEnv(cfg)

	// Apply flag overrides
	ApplyOverrides(cfg, overrides)

	return cfg, nil
}

func loadFromFile(cfg *Config, path string, source Source) {
	data, err := os.ReadFile(path) //nolint:gosec // G304: Path is from trusted config locations
	if err != nil {
		return // File doesn't exist, skip
	}

	var fileCfg Config
	if err := json.Unmarshal(data, &fileCfg); err != nil {
		fmt.Fprintf(os.Stderr, "warning: skipping malformed config at %s: %v\n", path, err)
		return
	}

	if fileCfg.InstanceURL != "" {
		cfg.InstanceURL = fileCfg.InstanceURL
		cfg.Sources["instance_url"] = string(source)
	}
	if fileCfg.Format != "" {
		cfg.Format = fileCfg.Format
		cfg.Sources["format"] = string(source)
	}
	if fileCfg.DefaultProfile != "" {
		cfg.DefaultProfile = fileCfg.DefaultProfile
		cfg.Sources["default_profile"] = string(source)
	}
	if len(fileCfg.Profiles) > 0 {
		if cfg.Profiles == nil {
			cfg.Profiles = make(map[string]*Profile)
		}
		for name, profile := range fileCfg.Profiles {
			cfg.Profiles[name] = profile
		}
		cfg.Sources["profiles"] = string(source)
	}
}

// LoadFromEnv loads configuration from environment variables.
func LoadFromEnv(cfg *Config) {
	if v := os.Getenv("SERVICENOW_INSTANCE_URL"); v != "" {
		cfg.InstanceURL = v
		cfg.Sources["instance_url"] = string(SourceEnv)
	}
	if v := os.Getenv("SERVICENOW_FORMAT"); v != "" {
		cfg.Format = v
		cfg.Sources["format"] = string(SourceEnv)
	}
}

// ApplyOverrides applies non-empty flag overrides to cfg.
func ApplyOverrides(cfg *Config, o FlagOverrides) {
	if o.Instance != "" {
		cfg.InstanceURL = o.Instance
		cfg.Sources["instance_url"] = string(SourceFlag)
	}
	if o.Format != "" {
		cfg.Format = o.Format
		cfg.Sources["format"] = string(SourceFlag)
	}
	if o.Profile != "" {
		cfg.ActiveProfile = o.Profile
		// Apply profile values
		if cfg.Profiles != nil {
			if p, ok := cfg.Profiles[o.Profile]; ok {
				if p.InstanceURL != "" {
					cfg.InstanceURL = p.InstanceURL
					cfg.Sources["instance_url"] = "profile"
				}
			}
		}
	}
}

// GetEffectiveInstance returns the instance URL to use.
func (c *Config) GetEffectiveInstance() string {
	if c.ActiveProfile != "" && c.Profiles != nil {
		if p, ok := c.Profiles[c.ActiveProfile]; ok && p.InstanceURL != "" {
			return p.InstanceURL
		}
	}
	return c.InstanceURL
}

// Save saves the configuration to the global config file.
func (c *Config) Save() error {
	path := GlobalConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// SaveLocal saves the configuration to the local config file.
func (c *Config) SaveLocal() error {
	path := LocalConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// Path helpers

// GlobalConfigPath returns the path to the global config file.
func GlobalConfigPath() string {
	return filepath.Join(GlobalConfigDir(), "config.json")
}

// LocalConfigPath returns the path to the local config file.
func LocalConfigPath() string {
	return filepath.Join(".", "."+appName, "config.json")
}

// GlobalConfigDir returns the global config directory path.
func GlobalConfigDir() string {
	configDir := os.Getenv("XDG_CONFIG_HOME")
	if configDir == "" {
		if home, _ := os.UserHomeDir(); home != "" {
			configDir = filepath.Join(filepath.Clean(home), ".config")
		} else {
			configDir = os.TempDir()
		}
	} else {
		configDir = filepath.Clean(configDir)
	}
	return filepath.Join(configDir, appName)
}

// CacheDir returns the cache directory path.
func CacheDir() string {
	cacheDir := os.Getenv("XDG_CACHE_HOME")
	if cacheDir == "" {
		if home, _ := os.UserHomeDir(); home != "" {
			cacheDir = filepath.Join(filepath.Clean(home), ".cache")
		} else {
			cacheDir = os.TempDir()
		}
	} else {
		cacheDir = filepath.Clean(cacheDir)
	}
	return filepath.Join(cacheDir, appName)
}

// NormalizeInstanceURL ensures consistent URL format (no trailing slash).
func NormalizeInstanceURL(url string) string {
	url = strings.TrimSuffix(url, "/")
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		url = "https://" + url
	}
	return url
}

// GetActiveProfile returns the active profile or nil if none.
func (c *Config) GetActiveProfile() *Profile {
	name := c.ActiveProfile
	if name == "" {
		name = c.DefaultProfile
	}
	if name == "" || c.Profiles == nil {
		return nil
	}
	return c.Profiles[name]
}

// SetProfile sets a profile and saves the config.
func (c *Config) SetProfile(name string, profile *Profile) error {
	if c.Profiles == nil {
		c.Profiles = make(map[string]*Profile)
	}
	c.Profiles[name] = profile
	return c.Save()
}
