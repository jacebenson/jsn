// Session resolver — one module owns the answer to "which instance am I
// talking to, as whom, with what profile flags?"
//
// Before this module existed, that composite answer was assembled across
// four files with shared mutable state:
//   - cli.js middleware resolved --profile by mutating cfg.activeProfile as
//     a side effect, and poked BOTH app._overrideInstance and
//     argv._overrideInstance (the --instance branch duplicated across two
//     adjacent middlewares);
//   - app.js carried _overrideInstance + getEffectiveInstance +
//     setEffectiveInstance, re-deriving the active profile three ways;
//   - auth.js reached into configProvider.config.profiles to re-derive the
//     username for credential keying;
//   - config.js's getEffectiveInstance duplicated the
//     activeProfile || defaultProfile incantation.
//
// Now: resolveSession({argv-ish}, config) → a session object (pure — no
// mutation of argv OR config), applySession(app, session) is the SINGLE
// point where a flag override changes app/config state, and App keeps the
// resolved session on app.session for anything that needs identity
// (AuthManager is handed a provider over it, so it no longer spelunks
// config internals).
//
// Precedence (pinned by test/session.test.js — preserve exactly):
//   --instance flag > --profile reference > active profile >
//   default profile > legacy bare instanceURL
//
// When both explicit selectors are supplied, they must resolve to the same
// normalized instance; otherwise the command fails with a usage error.
//
// Deliberately NOT here: env var loading (loadConfig already folds
// SERVICENOW_INSTANCE_URL into cfg.instanceURL before the resolver runs)
// and credential storage I/O (auth.js owns the keyring/file stores).

import { normalizeInstanceURL } from './config.js';
import { extractProfileName } from './helpers.js';
import { errUsage } from './errors.js';

/**
 * Resolve the composite session from parsed argv flags + loaded config.
 * Pure: never mutates argv or config.
 *
 * @param {object} [argv] — anything with optional { instance, profile }
 *   (a yargs argv, or a hand-built { instance, profile } shape)
 * @param {object} config — the loaded config (from loadConfig())
 * @returns {{
 *   instance: string,        // effective instance URL ('' when unresolved)
 *   profileName: string|null,// active profile name after flags
 *   profile: object|null,    // the profile entry (instance_url, flags, ...)
 *   username: string|null,   // profile username for credential keying
 *   domain: string,          // domain-separation sys_id ('' = no scoping)
 *   readOnly: boolean,       // profile.read_only === true (the armed guard)
 *   override: string|null,   // normalized flag override URL, null when none
 *   profileExplicit: boolean,// true when --profile named the active profile
 *   unknownProfile: string|null, // set when --profile named no known profile
 * }}
 */
export function resolveSession(argv = {}, config) {
  const cfg = config || {};
  const profiles = cfg.profiles || {};

  // --profile selects the active profile for this run. Unknown names are
  // surfaced as data (unknownProfile) — the caller (cli.js middleware)
  // decides how to render the guard exit; resolving must not throw because
  // App is constructed before argv exists.
  let unknownProfile = null;
  let profileName = null;
  if (argv.profile) {
    if (profiles[argv.profile]) {
      profileName = argv.profile;
    } else {
      unknownProfile = argv.profile;
    }
  }
  if (!profileName) {
    const fallback = cfg.activeProfile || cfg.defaultProfile;
    if (fallback && profiles[fallback]) profileName = fallback;
  }

  const profile = profileName ? profiles[profileName] : null;

  // Explicit selectors must identify the same target. Without this guard,
  // --profile supplies the credentials while --instance silently points the
  // SDK at another identity's instance.
  if (argv.instance && argv.profile && profile?.instance_url) {
    const flagInstance = normalizeInstanceURL(argv.instance);
    const profileInstance = normalizeInstanceURL(profile.instance_url);
    if (flagInstance !== profileInstance) {
      throw errUsage(`Conflicting selectors: --profile "${argv.profile}" targets ${profileInstance}, but --instance targets ${flagInstance}.`);
    }
  }

  // Instance: --instance flag > profile reference > active/default
  // profile > legacy bare instanceURL. The override is normalized here so
  // every downstream consumer (SDK client, context header links) sees the
  // canonical form. --profile counts as an override too (the old code
  // poked the profile's URL into app._overrideInstance and rebuilt the SDK
  // via setEffectiveInstance's normalization) — session.instance is always
  // the normalized effective URL either way.
  let override = null;
  if (argv.instance) {
    override = normalizeInstanceURL(argv.instance) || null;
  } else if (argv.profile && profile?.instance_url) {
    override = normalizeInstanceURL(profile.instance_url) || null;
  }

  const instance = normalizeInstanceURL(override || (profile && profile.instance_url) || cfg.instanceURL || '');

  return {
    instance,
    profileName,
    profile,
    username: (profile && profile.username) || null,
    domain: (profile && profile.domain) || '',
    readOnly: profile?.read_only === true,
    override,
    profileExplicit: Boolean(argv.profile) && !unknownProfile,
    unknownProfile,
  };
}

/**
 * Derive the legacy context block (profileName + username for the context
 * header) from a session. Kept separate from the session itself because
 * printContextHeader() enriches it with live instance data (scope, update
 * set) — the session stays a snapshot of resolution-time truth.
 *
 * Legacy fallback preserved: with no active profile NAME, find the profile
 * whose instance_url matches the effective instance (legacy configs that
 * predate named profiles), else derive a display name from the URL host.
 */
export function contextFromSession(session, config) {
  const context = { profileName: '', username: '', scope: '', updateSet: '' };
  if (!session) return context;

  if (session.profileName) {
    context.profileName = session.profileName;
    context.username = session.username || '';
    return context;
  }

  if (!session.instance) return context;
  context.profileName = extractProfileName(session.instance);
  for (const [name, profile] of Object.entries(config?.profiles || {})) {
    if (profile.instance_url === session.instance) {
      context.profileName = name;
      context.username = profile.username || '';
      break;
    }
  }
  return context;
}

/**
 * Apply a resolved session to the App — the ONLY place flag overrides
 * change app/config state. Explicit, greppable, and called from exactly
 * one middleware (cli.js). Replaces the old scattered trio:
 *   cfg.activeProfile = argv.profile  (buried side effect)
 *   app._overrideInstance = url; argv._overrideInstance = url  (mirrored)
 *
 * @param {import('./app.js').App} app
 * @param {object} sessionOrArgv — a resolveSession() result, or a bare
 *   { instance, profile } argv shape (resolved here for convenience)
 * @returns {object} the applied session
 */
export function applySession(app, sessionOrArgv) {
  // A resolved session carries `override` (null when no flag); bare argv
  // ({ instance, profile }) does not. (Object.hasOwn, not `in` — plain
  // objects inherit Object.prototype, which has neither, but hasOwn is the
  // intent-precise check.)
  const isResolved = sessionOrArgv != null && Object.hasOwn(sessionOrArgv, 'override');
  const session = isResolved
    ? sessionOrArgv
    : resolveSession(sessionOrArgv, app.config);

  // --profile: switch the active profile on the config so anything still
  // reading config directly (legacy callers, help rendering) sees the same
  // answer the session computed. Flag args are pinned on _sessionArgv so
  // refreshSession() (after config edits) keeps the same flags in force.
  if (session.profileExplicit) {
    app.config.activeProfile = session.profileName;
    app._sessionArgv = { ...(app._sessionArgv || {}), profile: session.profileName };
  }
  if (!isResolved && sessionOrArgv?.instance !== undefined) {
    app._sessionArgv = { ...(app._sessionArgv || {}), instance: sessionOrArgv.instance };
  }

  // Flag overrides (--instance, --profile) pin the effective instance for
  // this run and rebuild the SDK client against it. No flags → clear any
  // stale override so the config-sourced instance is authoritative. (The
  // SDK must be rebuilt even at the same URL: the domain scope comes from
  // the newly-active profile.)
  app._overrideInstance = session.override;
  if (session.instance) {
    app._buildSdk(session.instance, session);
  } else {
    app.sdk = null;
  }

  app.session = session;
  app.loadContext();
  return session;
}

/**
 * Re-resolve the session after config edits (profile switched, created,
 * or removed by auth/setup commands). Explicit flag overrides are pinned
 * by re-resolving against the pinned argv; without them the config is
 * authoritative.
 *
 * @param {import('./app.js').App} app
 * @returns {object} the refreshed session
 */
export function refreshSession(app) {
  return applySession(app, app._sessionArgv || {});
}

/**
 * The missing-instance guard, backed by the session. The message and code
 * (usage → exit 2 via the unified renderer) are observable behavior pinned
 * by test/core.test.js — do not reword.
 */
export function requireSessionInstance(session) {
  if (!session || !session.instance) {
    throw errUsage('Instance URL required. Set via --instance flag, SERVICENOW_INSTANCE_URL env, or config file.');
  }
  return session.instance;
}
