package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	appName = "servicenow"
)

type Config struct {
	InstanceURL    string                 `json:"instance_url,omitempty"`
	DefaultProfile string                 `json:"default_profile,omitempty"`
	Profiles       map[string]*Profile    `json:"profiles,omitempty"`
	Raw            map[string]interface{} `json:"-"`
	Source         map[string]Source      `json:"-"`
}

type Profile struct {
	InstanceURL string `json:"instance_url"`
	Username    string `json:"username,omitempty"`
	AuthMethod  string `json:"auth_method,omitempty"`
}

type Source int

const (
	SourceDefault Source = iota
	SourceSystem
	SourceGlobal
	SourceRepo
	SourceLocal
	SourceEnv
	SourceFlag
)

func (s Source) String() string {
	switch s {
	case SourceDefault:
		return "default"
	case SourceSystem:
		return "system"
	case SourceGlobal:
		return "global"
	case SourceRepo:
		return "repo"
	case SourceLocal:
		return "local"
	case SourceEnv:
		return "env"
	case SourceFlag:
		return "flag"
	default:
		return "unknown"
	}
}

func Load(cfgFile, profileName string) (*Config, error) {
	cfg := &Config{
		Profiles: make(map[string]*Profile),
		Source:   make(map[string]Source),
	}

	globalPath := GlobalConfigPath()
	if _, err := os.Stat(globalPath); err == nil {
		if err := loadFromFile(cfg, globalPath); err != nil {
			return nil, fmt.Errorf("loading global config: %w", err)
		}
	}

	if profileName != "" {
		cfg.DefaultProfile = profileName
	}

	return cfg, nil
}

func loadFromFile(cfg *Config, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return err
	}

	cfg.Raw = raw
	return nil
}

func (c *Config) Save() error {
	path := GlobalConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func (c *Config) SaveLocal() error {
	path := LocalConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func (c *Config) AddProfile(name string, profile *Profile) error {
	c.Profiles[name] = profile
	return c.Save()
}

func (c *Config) GetProfile(name string) (*Profile, bool) {
	if name == "" {
		name = c.DefaultProfile
	}
	p, ok := c.Profiles[name]
	return p, ok
}

func (c *Config) GetActiveProfile() *Profile {
	if c.DefaultProfile == "" {
		return nil
	}
	if p, ok := c.Profiles[c.DefaultProfile]; ok {
		return p
	}
	return nil
}

func GlobalConfigPath() string {
	return filepath.Join(GlobalConfigDir(), "config.json")
}

func GlobalConfigDir() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, appName)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".config", appName)
	}

	return filepath.Join(home, ".config", appName)
}

func LocalConfigPath() string {
	return filepath.Join(".", "."+appName, "config.json")
}

func CacheDir() string {
	if xdg := os.Getenv("XDG_CACHE_HOME"); xdg != "" {
		return filepath.Join(xdg, appName)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".cache", appName)
	}

	return filepath.Join(home, ".cache", appName)
}
