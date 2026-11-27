// Layered configuration: flags > env > local > global > defaults

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_NAME = 'servicenow';
// Persistence provenance is private: project JSON cannot forge it.
const persistence = new WeakMap();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fields = ['instanceURL', 'defaultProfile', 'format', 'connectionDefaults', 'docs', 'preferences'];
function snapshot(cfg) {
  return structuredClone(Object.fromEntries([...fields, 'profiles'].map(key => [key, cfg[key]])));
}

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
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  try {
    // Profiles store the instance origin, never a page, API route, query, or
    // fragment pasted from the browser.
    return new URL(url).origin;
  } catch {
    // Preserve the old permissive behavior for non-standard local endpoints.
    return url.replace(/\/$/, '');
  }
}

function loadFromFile(cfg, filePath, source) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const fileCfg = JSON.parse(data);
    // Installation-wide preferences are never taken from a project config.
    if (source === 'global') {
      if (Object.hasOwn(fileCfg, 'preferences')) cfg.preferences = fileCfg.preferences;
      if (fileCfg.connection_defaults && typeof fileCfg.connection_defaults === 'object') cfg.connectionDefaults = fileCfg.connection_defaults;
      if (fileCfg.docs && typeof fileCfg.docs === 'object') cfg.docs = fileCfg.docs;
    }
    if (source === 'local' && Object.hasOwn(fileCfg, 'write_context')) cfg.writeContext = fileCfg.write_context;
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
    connectionDefaults: null,
    docs: null,
    preferences: null,
  };
}

export function loadConfig(overrides = {}) {
  const cfg = createConfig();

  loadFromFile(cfg, globalConfigPath(), 'global');
  const global = snapshot(cfg);
  // Preserve provenance outside the serializable/user-controlled config shape.
  // A project can select an origin, but cannot authorize ambient secrets for it.
  Object.defineProperty(cfg, 'credentialTrust', { value: {
    profiles: structuredClone(cfg.profiles),
    origin: normalizeInstanceURL(getEffectiveInstance(cfg)),
  } });
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

  persistence.set(cfg, { global, effective: snapshot(cfg) });
  return cfg;
}

export function isTrustedCredentialDestination(cfg, instance, explicitInstance = '', explicitProfile = '') {
  const origin = normalizeInstanceURL(instance);
  // Hand-built configs are a programmatic API, not project-file input.
  if (!cfg?.credentialTrust) return true;
  const selectedProfile = explicitProfile && Object.hasOwn(cfg.credentialTrust.profiles, explicitProfile)
    ? cfg.credentialTrust.profiles[explicitProfile]?.instance_url : '';
  // Bind ambient secrets to the global default, not every saved account.
  // Only explicit process selectors may opt into another saved origin.
  const binding = explicitInstance || selectedProfile || process.env.SERVICENOW_INSTANCE_URL || cfg.credentialTrust.origin;
  return Boolean(binding) && normalizeInstanceURL(binding) === origin;
}

export function saveConfig(cfg, { approvedProfile = '', approveDefault = false } = {}) {
  const state = persistence.get(cfg);
  const next = state ? structuredClone(state.global) : snapshot(cfg);
  const changedProfiles = new Set();
  const changedFields = new Set();
  const refuse = () => {
    const error = new Error('Project configuration cannot be promoted to global trust. Edit the global profile outside this project, or explicitly approve the destination with auth login <URL>.');
    error.code = 'usage_error';
    throw error;
  };
  if (state) {
    for (const name of new Set([...Object.keys(state.effective.profiles), ...Object.keys(cfg.profiles)])) {
      if (name !== approvedProfile && same(cfg.profiles[name], state.effective.profiles[name])) continue;
      // A changed project-derived profile must not be copied wholesale, even
      // when the user only changed an innocuous preference on that profile.
      if (name !== approvedProfile && cfg.profiles[name] !== undefined
        && !same(state.effective.profiles[name], state.global.profiles[name])) refuse();
      if (cfg.profiles[name] === undefined) delete next.profiles[name];
      else next.profiles[name] = structuredClone(cfg.profiles[name]);
      changedProfiles.add(name);
    }
    for (const key of fields) {
      if (same(cfg[key], state.effective[key]) && !(approveDefault && ['instanceURL', 'defaultProfile'].includes(key))) continue;
      // Removing a locally selected profile must not clear an unrelated global
      // default. The caller explicitly removed that profile, not this one.
      if (key === 'defaultProfile' && !cfg[key] && !approveDefault
        && state.effective.defaultProfile !== state.global.defaultProfile) {
        changedFields.add(key);
        continue;
      }
      if (key === 'instanceURL' && !approveDefault && cfg[key]) {
        // Switching is selection, not authorization of a project origin.
        const name = cfg.defaultProfile;
        if (name && (!same(cfg.profiles[name], next.profiles[name]) || !next.profiles[name])) refuse();
      }
      if (key === 'defaultProfile' && cfg[key] && !approveDefault
        && (!next.profiles[cfg[key]] || !same(cfg.profiles[cfg[key]], next.profiles[cfg[key]]))) refuse();
      next[key] = structuredClone(cfg[key]);
      changedFields.add(key);
    }
  }
  // Preserve unrelated global keys and preferences written through the
  // preference setter since this config snapshot was loaded. Never read local.
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8')); } catch { /* absent */ }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  if (state && same(cfg.preferences, state.effective.preferences)) next.preferences = structuredClone(stored.preferences);
  if (state) for (const [name, profile] of Object.entries(next.profiles)) {
    if (same(cfg.profiles[name]?.preferences, state.effective.profiles[name]?.preferences)) {
      const preferences = stored.profiles?.[name]?.preferences;
      if (preferences === undefined) delete profile.preferences;
      else profile.preferences = structuredClone(preferences);
    }
  }
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const payload = {
    ...stored,
    connection_defaults: next.connectionDefaults || undefined,
    docs: next.docs || undefined,
    preferences: next.preferences ?? undefined,
    instance_url: next.instanceURL || undefined,
    profiles: Object.keys(next.profiles).length > 0 ? next.profiles : undefined,
    default_profile: next.defaultProfile || undefined,
    format: next.format || undefined,
  };
  fs.writeFileSync(globalConfigPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });

  // Synchronize only authored changes. Never replace the project's entire
  // profile map with the effective (or global) map.
  if (state && fs.existsSync(localConfigPath())) {
    try {
      const local = JSON.parse(fs.readFileSync(localConfigPath(), 'utf-8'));
      for (const name of changedProfiles) {
        local.profiles ||= {};
        if (next.profiles[name] === undefined) delete local.profiles[name];
        else local.profiles[name] = next.profiles[name];
      }
      const keys = { instanceURL: 'instance_url', defaultProfile: 'default_profile', format: 'format' };
      for (const key of changedFields) if (keys[key]) {
        if (next[key]) local[keys[key]] = next[key];
        else delete local[keys[key]];
      }
      if (changedProfiles.size || [...changedFields].some(key => keys[key])) {
        fs.writeFileSync(localConfigPath(), JSON.stringify(local, null, 2), { mode: 0o600 });
      }
    } catch {
      // Local config unreadable — skip sync, global save already succeeded.
    }
  }
  if (state) persistence.set(cfg, { global: next, effective: snapshot(cfg) });
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

export function setActiveProfile(cfg, name) {
  if (!cfg.profiles || !cfg.profiles[name]) {
    throw new Error(`Profile not found: ${name}`);
  }
  cfg.defaultProfile = name;
  cfg.activeProfile = name;
  return saveConfig(cfg);
}
