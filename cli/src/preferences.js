// Configurable workflow preferences.
//
// Precedence: built-in defaults -> installation settings -> selected profile.
// Installation settings live in the GLOBAL config file (`preferences`), and a
// profile override lives at `profiles.<name>.preferences` in the same file.
// Project-local `.servicenow/config.json` is deliberately never consulted:
// these are installation-wide opinions, not per-project trust decisions.
//
// The merge is per leaf and uses Object.hasOwn, so an explicit `false`, an
// empty array, or the string "none" wins over a broader default instead of
// being treated as "unset".

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeInstanceURL, globalConfigDir, globalConfigPath } from './config.js';
import { errUsageHint } from './errors.js';
import { resolveSession } from './session.js';

export const TESTING_METHODS = ['atf', 'scan', 'fixscripts', 'backgroundscripts', 'none'];

export const DEFAULT_PREFERENCES = Object.freeze({
  operations: Object.freeze({ create: true, update: true, delete: true }),
  testing: Object.freeze({ recommend: true, methods: Object.freeze(['atf', 'scan']), suggestMissing: true,
    contextMethods: Object.freeze({ agent: Object.freeze(['atf', 'scan']), includes: Object.freeze(['scan']), updatesets: Object.freeze(['scan']) }) }),
  updatesets: Object.freeze({
    nameTemplate: '{{tracker}}-{{date}}-{{initials}}-{{scope}}',
    initials: '',
    dateFormat: 'YYYY-MM-DD',
  }),
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

function merge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(override)) {
    if (!Object.hasOwn(override, key)) continue;
    const value = override[key];
    out[key] = isPlainObject(value) ? merge(isPlainObject(base) ? base[key] : undefined, value) : clone(value);
  }
  return out;
}

/** Read the raw global config object, or {} when absent/unreadable. */
export function readGlobalPreferencesConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Effective preferences plus a per-leaf source map:
 * 'default' | 'installation' | 'profile'.
 */
export function resolvePreferences({ profile = '', globalConfig = readGlobalPreferencesConfig() } = {}) {
  const installation = isPlainObject(globalConfig?.preferences) ? globalConfig.preferences : undefined;
  const override = profile && isPlainObject(globalConfig?.profiles?.[profile]?.preferences)
    ? globalConfig.profiles[profile].preferences
    : undefined;
  validateStoredPreferences(globalConfig?.preferences);
  if (profile) {
    assertProfileExists(globalConfig, profile);
    validateStoredPreferences(globalConfig.profiles[profile].preferences);
  }
  const preferences = merge(merge(clone(DEFAULT_PREFERENCES), installation), override);
  const sources = {};
  markSources(sources, clone(DEFAULT_PREFERENCES), 'default');
  markSources(sources, installation, 'installation');
  markSources(sources, override, 'profile');
  const methods = preferences.testing.methods;
  preferences.testing.contextMethods = {
    agent: [...methods],
    includes: sources['testing.methods'] === 'default' ? ['scan'] : [...methods],
    updatesets: sources['testing.methods'] === 'default' ? ['scan'] : [...methods],
  };
  for (const context of Object.keys(preferences.testing.contextMethods)) {
    sources[`testing.contextMethods.${context}`] = sources['testing.methods'];
  }
  return { preferences, sources, profile: profile || '' };
}

// Bind policy to trusted identity and origin, never a project-selected name.
export function resolveRuntimePreferences(argv = {}, config = loadConfig()) {
  const globalConfig = readGlobalPreferencesConfig();
  const session = resolveSession(argv, config);
  if (session.unknownProfile) throw usage(`Unknown profile "${session.unknownProfile}"`);
  const profiles = globalConfig.profiles || {};
  const origin = session.instance;
  const matches = name => name && profiles[name] && normalizeInstanceURL(profiles[name].instance_url) === origin;
  let profile = '';
  if (argv.profile && matches(argv.profile)) profile = argv.profile;
  else if (matches(globalConfig.default_profile)) profile = globalConfig.default_profile;
  else if (!config.credentialTrust && matches(session.profileName)) profile = session.profileName;
  else {
    const candidates = Object.keys(profiles).filter(matches);
    if (candidates.length === 1) profile = candidates[0];
    else if (candidates.length > 1) throw usage('Multiple trusted profiles match this origin.', 'Select the intended trusted profile with --profile <name>.');
  }
  return resolvePreferences({ profile, globalConfig });
}

function validateStoredPreferences(value, prefix = '') {
  if (value === undefined || value === null && !prefix) {
    if (value === null) throw usage('Stored preferences must be an object');
    return;
  }
  if (!isPlainObject(value)) throw usage(`Stored ${prefix || 'preferences'} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (PREFERENCE_KEYS.includes(name)) {
      const type = KEY_TYPES[name];
      if (type === 'boolean' && typeof entry !== 'boolean'
        || type === 'methods' && (!Array.isArray(entry) || entry.some(item => typeof item !== 'string'))
        || !['boolean', 'methods'].includes(type) && typeof entry !== 'string') throw usage(`Invalid stored preference ${name}`);
      const canonical = coercePreferenceValue(name, entry);
      if (type === 'methods' && JSON.stringify(canonical) !== JSON.stringify(entry)) throw usage(`Invalid stored preference ${name}`);
    } else if (PREFERENCE_KEYS.some(key => key.startsWith(name + '.'))) validateStoredPreferences(entry, name);
    else throw usage(`Unknown preference key "${name}"`);
  }
}

function markSources(sources, value, source, prefix = '') {
  if (!isPlainObject(value)) {
    if (prefix) sources[prefix] = source;
    return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(value, key)) continue;
    markSources(sources, value[key], source, prefix ? `${prefix}.${key}` : key);
  }
}

const KEY_TYPES = {
  'operations.create': 'boolean',
  'operations.update': 'boolean',
  'operations.delete': 'boolean',
  'testing.recommend': 'boolean',
  'testing.methods': 'methods',
  'testing.suggestMissing': 'boolean',
  'updatesets.nameTemplate': 'template',
  'updatesets.initials': 'string',
  'updatesets.dateFormat': 'dateformat',
};

export const PREFERENCE_KEYS = Object.keys(KEY_TYPES);

function usage(message, hint) {
  return errUsageHint(message, hint || `Valid keys: ${PREFERENCE_KEYS.join(', ')}`);
}

function coerceMethods(value) {
  let items;
  if (Array.isArray(value)) items = value;
  else {
    const text = String(value).trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        items = parsed;
      } catch {
        throw usage(`Invalid value for testing.methods: ${text}`, 'Use a comma-separated list, e.g. --value atf,scan');
      }
    } else items = text.split(',');
  }
  const methods = items.map(item => String(item).trim().toLowerCase()).filter(Boolean);
  for (const method of methods) {
    if (!TESTING_METHODS.includes(method)) {
      throw usage(`Unknown testing method "${method}"`, `Choose from: ${TESTING_METHODS.join(', ')}`);
    }
  }
  if (methods.includes('none') && methods.length > 1) {
    throw usage('testing.methods cannot combine "none" with another method', 'Use --value none to disable testing methods.');
  }
  return methods;
}

const TEMPLATE_TOKENS = ['tracker', 'date', 'initials', 'scope'];

function validateTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) throw usage('updatesets.nameTemplate must be a non-empty string');
  const stripped = template.replace(/\{\{([a-z]+)\}\}/gi, (_, token) => {
    if (!TEMPLATE_TOKENS.includes(token.toLowerCase())) {
      throw usage(`Unknown template token "{{${token}}}"`, `Use only: ${TEMPLATE_TOKENS.map(t => `{{${t}}}`).join(', ')}`);
    }
    return '';
  });
  if (stripped.includes('{{') || stripped.includes('}}')) {
    throw usage('Malformed updatesets.nameTemplate', 'Use {{tracker}}, {{date}}, {{initials}} and {{scope}} tokens.');
  }
  return template;
}

function validateDateFormat(format) {
  if (typeof format !== 'string' || !/^(YYYY|MM|DD)([-_.](YYYY|MM|DD))*$/.test(format)) {
    throw usage(`Invalid updatesets.dateFormat "${format}"`, 'Use YYYY, MM and DD, e.g. YYYY-MM-DD');
  }
  return format;
}

/** Coerce and validate one dot-key value. Throws a usage error when invalid. */
export function coercePreferenceValue(key, value) {
  if (!PREFERENCE_KEYS.includes(key)) {
    throw usage(`Unknown preference key "${key}"`);
  }
  const type = KEY_TYPES[key];
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    throw usage(`Invalid boolean for ${key}: ${value}`, 'Use --value true or --value false.');
  }
  if (type === 'methods') return coerceMethods(value);
  if (type === 'template') return validateTemplate(String(value));
  if (type === 'dateformat') return validateDateFormat(String(value));
  return String(value);
}

function setPath(target, key, value) {
  const parts = key.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function deletePath(target, key) {
  const parts = key.split('.');
  const stack = [];
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) return;
    stack.push([cursor, part]);
    cursor = cursor[part];
  }
  if (!Object.hasOwn(cursor, parts.at(-1))) return;
  delete cursor[parts.at(-1)];
  // Do not leave empty `{"operations":{}}` scaffolding behind.
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, part] = stack[i];
    if (isPlainObject(parent[part]) && Object.keys(parent[part]).length === 0) delete parent[part];
    else break;
  }
}

function readForWrite() {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw usage('Global config is not a JSON object; refusing to modify it.', `Fix ${file} first.`);
  }
}

function writeGlobalAtomic(config) {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const file = globalConfigPath();
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  // Preserve every unrelated key: only the preferences path is mutated.
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function assertProfileExists(config, profile) {
  if (!profile) return;
  if (!isPlainObject(config.profiles?.[profile])) {
    throw usage(`Unknown profile "${profile}"`, 'Run "jsn auth status" to list profiles.');
  }
}

/**
 * Write one preference. Installation-wide unless `profile` is given.
 * Returns the updated effective preferences.
 */
export function setPreference({ key, value, profile = '' }) {
  const coerced = coercePreferenceValue(key, value);
  const config = readForWrite();
  assertProfileExists(config, profile);
  if (profile) {
    config.profiles[profile].preferences ||= {};
    setPath(config.profiles[profile].preferences, key, coerced);
  } else {
    config.preferences ||= {};
    setPath(config.preferences, key, coerced);
  }
  const result = resolvePreferences({ profile, globalConfig: config });
  writeGlobalAtomic(config);
  return result;
}

/** Remove one preference override. Returns the updated effective preferences. */
export function unsetPreference({ key, profile = '' }) {
  if (!PREFERENCE_KEYS.includes(key)) throw usage(`Unknown preference key "${key}"`);
  const config = readForWrite();
  assertProfileExists(config, profile);
  if (profile) {
    if (isPlainObject(config.profiles[profile].preferences)) deletePath(config.profiles[profile].preferences, key);
    if (config.profiles[profile].preferences && Object.keys(config.profiles[profile].preferences).length === 0) {
      delete config.profiles[profile].preferences;
    }
  } else {
    if (isPlainObject(config.preferences)) deletePath(config.preferences, key);
    if (config.preferences && Object.keys(config.preferences).length === 0) delete config.preferences;
  }
  const result = resolvePreferences({ profile, globalConfig: config });
  writeGlobalAtomic(config);
  return result;
}

function formatDate(date, dateFormat) {
  const pad = value => String(value).padStart(2, '0');
  const parts = {
    YYYY: String(date.getUTCFullYear()),
    MM: pad(date.getUTCMonth() + 1),
    DD: pad(date.getUTCDate()),
  };
  return dateFormat.replace(/YYYY|MM|DD/g, token => parts[token]);
}

/**
 * Render the configured update-set name template locally. No network access.
 * Missing values for tokens present in the template are usage errors, so a
 * create never runs with a half-rendered or empty name.
 */
export function renderUpdateSetName({
  preferences = DEFAULT_PREFERENCES,
  tracker = '',
  initials = '',
  scope = '',
  date = new Date(),
} = {}) {
  const updatesets = preferences.updatesets || {};
  const template = validateTemplate(updatesets.nameTemplate ?? DEFAULT_PREFERENCES.updatesets.nameTemplate);
  const dateFormat = validateDateFormat(updatesets.dateFormat ?? DEFAULT_PREFERENCES.updatesets.dateFormat);
  const resolvedInitials = String(initials || updatesets.initials || '').trim();
  const values = {
    tracker: String(tracker || '').trim(),
    date: formatDate(date, dateFormat),
    initials: resolvedInitials,
    scope: String(scope || '').trim(),
  };
  const used = [...template.matchAll(/\{\{([a-z]+)\}\}/gi)].map(match => match[1].toLowerCase());
  const missing = [];
  if (used.includes('tracker') && !values.tracker) missing.push('tracker');
  if (used.includes('initials') && !values.initials) missing.push('initials');
  if (used.includes('scope') && !values.scope) missing.push('scope');
  if (missing.length) {
    const hints = missing.map(field => field === 'tracker'
      ? 'Pass --tracker <id>'
      : field === 'initials'
        ? 'Set it once with: jsn preferences set updatesets.initials <initials>'
        : 'Run inside a known scope, or pass --scope <scope>');
    throw errUsageHint(
      `Cannot render update set name: missing ${missing.join(', ')} for template "${template}".`,
      `${hints.join('\n')} Or pass an explicit --name.`,
    );
  }
  return template.replace(/\{\{([a-z]+)\}\}/gi, (_, token) => values[token.toLowerCase()]);
}

export const TESTING_METHOD_LABELS = {
  atf: 'ATF tests',
  scan: 'instance scans',
  fixscripts: 'fix scripts',
  backgroundscripts: 'background scripts',
};

export const TESTING_METHOD_HINTS = {
  atf: { action: 'atf', cmd: 'jsn atf run --help', description: 'Offer an explicit ATF run for relevant tests' },
  scan: { action: 'scan', cmd: 'jsn scan run --help', description: 'Offer an explicit scan of current records' },
  fixscripts: { action: 'fixscripts', cmd: 'jsn records create --table sys_script_fix --help', description: 'Verify with a fix script only after explicit approval' },
  backgroundscripts: { action: 'backgroundscripts', cmd: 'jsn eval --help', description: 'Verify with a background script only after explicit approval' },
};

/**
 * Testing guidance derived from effective preferences. Returns null when the
 * user turned recommendations off (or configured "none"): callers then emit
 * no recommendation at all. Explicit `jsn atf` / `jsn scan` commands remain
 * available; this never auto-creates or auto-runs tests.
 */
export function testingGuidance(preferences = DEFAULT_PREFERENCES, context = 'agent') {
  const testing = preferences.testing || DEFAULT_PREFERENCES.testing;
  if (testing.recommend !== true) return null;
  const methods = (testing.contextMethods?.[context] || testing.methods || []).filter(method => method !== 'none' && TESTING_METHOD_LABELS[method]);
  if (!methods.length) return null;
  const labels = methods.map(method => TESTING_METHOD_LABELS[method]);
  const suggestMissing = testing.suggestMissing === true;
  const text = `Offer to run relevant existing ${labels.join(' and ')}${suggestMissing ? ', or create missing checks' : ''}.`;
  return {
    methods,
    suggestMissing,
    text,
    hints: [
      ...(context === 'includes' && methods.includes('scan') && suggestMissing
        ? [{ action: 'check-help', cmd: 'jsn scan checks create --help', description: 'Behavior is untested until the intended check runs. Review a suitable check.' }] : []),
      ...methods.map(method => context === 'includes' && method === 'scan'
        ? { action: 'scan-help', cmd: 'jsn scan run --help', description: 'Choose an explicit target; verify intended-check execution and its assertion.' }
        : { ...TESTING_METHOD_HINTS[method] }),
    ],
  };
}

/** Convenience for command builders: current guidance, or null. */
export function currentTestingGuidance({ profile = '', globalConfig, argv, config, context = 'agent' } = {}) {
  const result = argv ? resolveRuntimePreferences(argv, config) : resolvePreferences({ profile, globalConfig });
  return testingGuidance(result.preferences, context);
}
