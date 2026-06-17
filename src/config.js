// Layered configuration: flags > env > local > global > defaults

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_NAME = 'servicenow';

export function globalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), '.config', APP_NAME);
}

export function globalConfigPath() {
  return path.join(globalConfigDir(), 'config.json');
}

export function localConfigPath() {
  return path.join(process.cwd(), `.${APP_NAME}`, 'config.json');
}

export function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), '.cache', APP_NAME);
}

export function normalizeInstanceURL(url) {
  if (!url) return '';
  url = url.trim();
  url = url.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

function loadFromFile(cfg, filePath, source) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const fileCfg = JSON.parse(data);
    if (fileCfg.instance_url) {
      cfg.instanceURL = fileCfg.instance_url;
      cfg.sources.instance_url = source;
    }
    if (fileCfg.format) {
      cfg.format = fileCfg.format;
      cfg.sources.format = source;
    }
    if (fileCfg.default_profile) {
      cfg.defaultProfile = fileCfg.default_profile;
      cfg.activeProfile = fileCfg.default_profile;
      cfg.sources.default_profile = source;
    }
    if (fileCfg.profiles && typeof fileCfg.profiles === 'object') {
      cfg.profiles = { ...cfg.profiles, ...fileCfg.profiles };
      cfg.sources.profiles = source;
    }
  } catch {
    // File doesn't exist or is malformed — skip
  }
}

function loadFromEnv(cfg) {
  if (process.env.SERVICENOW_INSTANCE_URL) {
    cfg.instanceURL = process.env.SERVICENOW_INSTANCE_URL;
    cfg.sources.instance_url = 'env';
  }
  if (process.env.SERVICENOW_FORMAT) {
    cfg.format = process.env.SERVICENOW_FORMAT;
    cfg.sources.format = 'env';
  }
}

export function createConfig() {
  return {
    instanceURL: '',
    profiles: {},
    defaultProfile: '',
    activeProfile: '',
    format: 'auto',
    sources: {},
  };
}

export function loadConfig(overrides = {}) {
  const cfg = createConfig();

  loadFromFile(cfg, globalConfigPath(), 'global');
  loadFromFile(cfg, localConfigPath(), 'local');
  loadFromEnv(cfg);

  if (overrides.instance) {
    cfg.instanceURL = overrides.instance;
    cfg.sources.instance_url = 'flag';
  }
  if (overrides.format) {
    cfg.format = overrides.format;
    cfg.sources.format = 'flag';
  }
  if (overrides.profile) {
    cfg.activeProfile = overrides.profile;
    if (cfg.profiles[overrides.profile] && cfg.profiles[overrides.profile].instance_url) {
      cfg.instanceURL = cfg.profiles[overrides.profile].instance_url;
      cfg.sources.instance_url = 'profile';
    }
  }

  return cfg;
}

export function saveConfig(cfg) {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const payload = {
    instance_url: cfg.instanceURL || undefined,
    profiles: Object.keys(cfg.profiles).length > 0 ? cfg.profiles : undefined,
    default_profile: cfg.defaultProfile || undefined,
    format: cfg.format || undefined,
  };
  fs.writeFileSync(globalConfigPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });

  // Sync managed fields to local config if it exists, so profile operations
  // (use, remove, create, auth login) aren't silently reverted on next load.
  if (fs.existsSync(localConfigPath())) {
    try {
      const localData = JSON.parse(fs.readFileSync(localConfigPath(), 'utf-8'));
      const merged = { ...localData };
      if (payload.profiles !== undefined) merged.profiles = payload.profiles;
      if (payload.default_profile !== undefined) merged.default_profile = payload.default_profile;
      if (payload.instance_url !== undefined) merged.instance_url = payload.instance_url;
      if (payload.format !== undefined) merged.format = payload.format;
      fs.writeFileSync(localConfigPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch {
      // Local config unreadable — skip sync, global save already succeeded
    }
  }
}

export function saveLocalConfig(cfg) {
  const dir = path.dirname(localConfigPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const payload = {
    instance_url: cfg.instanceURL || undefined,
    profiles: Object.keys(cfg.profiles).length > 0 ? cfg.profiles : undefined,
    default_profile: cfg.defaultProfile || undefined,
    format: cfg.format || undefined,
  };
  fs.writeFileSync(localConfigPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function getEffectiveInstance(cfg) {
  const name = cfg.activeProfile || cfg.defaultProfile;
  if (name && cfg.profiles[name] && cfg.profiles[name].instance_url) {
    return cfg.profiles[name].instance_url;
  }
  return cfg.instanceURL || '';
}

export function getActiveProfile(cfg) {
  const name = cfg.activeProfile || cfg.defaultProfile;
  if (!name) return null;
  return cfg.profiles[name] || null;
}

export function setProfile(cfg, name, profile) {
  cfg.profiles[name] = profile;
  return saveConfig(cfg);
}
