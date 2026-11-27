// App context: bundles config, auth, SDK, output, and runtime context
//
// Identity ("which instance, as whom, with what profile flags") is owned by
// the SESSION (src/session.js): the constructor resolves one from the
// config, the cli.js middleware re-applies it once --instance/--profile are
// known (applySession), and getEffectiveInstance()/requireInstance()/
// setEffectiveInstance() are thin session-backed shims kept for the many
// command handlers that already call them.

import { AuthManager, credentialStoreFor } from './auth.js';
import { createAuthRecovery } from './auth-recovery.js';
import { SDKClient } from './sdk.js';
import { OutputWriter, FormatAuto, FormatJSON, FormatMarkdown, FormatQuiet, FormatStyled } from './output.js';
import { saveConfig, isTrustedCredentialDestination } from './config.js';
import { resolveSession, applySession, contextFromSession, requireSessionInstance } from './session.js';
import { errUsage, errAuth } from './errors.js';
import { canPrompt, canUsePicker } from './helpers.js';
import { queryDiagnostics, invalidateAfterMutation } from './query-validate.js';
import { guardMutationContext } from './mutation-context.js';


export class App {
  constructor(cfg) {
    this.config = cfg;
    this.output = new OutputWriter({ format: resolveFormat(cfg.format) });
    this.sdk = null;
    // Back-compat field: flag-provided instance override (--instance /
    // --profile). Written by applySession only; mirrored on argv no longer.
    this._overrideInstance = null;
    // Pinned argv flags for session re-resolution after config edits
    // (auth switch / login / remove change the config under a pinned
    // --profile). Set by applySession; {} means "no flags seen".
    this._sessionArgv = {};

    // Resolve the initial session from config alone (no argv yet — the
    // middleware re-applies with argv). AuthManager is TOLD the identity:
    // it reads username/instance through this provider over the session
    // instead of reaching into config.profiles itself.
    this.session = resolveSession({}, cfg);
    this.auth = new AuthManager({
      getUsername: () => this.session?.username || null,
      getEffectiveInstance: () => this.session?.instance || '',
      getAuthMethod: () => this.session?.profile?.auth_method || null,
      isTrustedCredentialDestination: instance => isTrustedCredentialDestination(this.config, instance,
        this._authArgv?.instance || this._sessionArgv?.instance || (this.session?.profileExplicit ? '' : this.session?.override),
        this.session?.profileExplicit ? this.session.profileName : ''),
    }, { credentialStore: credentialStoreFor(this.session?.profile) });

    if (this.session.instance) {
      this._buildSdk(this.session.instance, this.session);
    }

    this.context = { profileName: '', username: '', scope: '', updateSet: '' };
    this.loadContext();
  }

  /** Build (or rebuild) the SDK client for an instance + session. */
  _buildSdk(instance, session = this.session) {
    this.sdk = new SDKClient(instance, this.auth.createProfileProvider(instance, {
      username: session?.username, authMethod: session?.profile?.auth_method,
    }), {
      domain: session?.domain || '',
      includeReferenceLinks: this._authArgv?.includeReferenceLinks === true,
      username: session?.username || '',
      recovery: createAuthRecovery({ app: this, session }),
      canInteract: () => canUsePicker(this, this._authArgv || {}),
    });
    this.sdk.afterMetadataMutation = table => invalidateAfterMutation(this, table);
  }

  /** Build a profile-scoped SDK without leaking auth construction to commands. */
  getSDKForProfile(instance, options = {}) {
    const profile = options.profile || {};
    return new SDKClient(instance, this.auth.createProfileProvider(instance, options), {
      domain: options.domain ?? profile.domain ?? '',
      username: options.username || '',
      canInteract: () => canUsePicker(this, this._authArgv || {}),
    });
  }

  loadContext() {
    this.context = contextFromSession(this.session, this.config);
  }

  getEffectiveInstance() {
    return this.session?.instance || '';
  }

  // Retained for SDK consumers. Automatic context banners are retired.
  async printContextHeader() {}

  async guardMutationContext(argv) {
    this.mutationContext = await guardMutationContext(this, argv);
    if (this.sdk) this.sdk.mutationContext = this.mutationContext;
  }

  ok(data, opts = {}) {
    const diagnostics = queryDiagnostics(this.queryValidation);
    if (diagnostics.query_validation && data && typeof data === 'object' && !Array.isArray(data)) data = Object.assign(data, diagnostics);
    else if (diagnostics.query_validation) opts = { ...opts, meta: { ...opts.meta, ...diagnostics } };
    this.output.ok(data, this.mutationContext ? { ...opts, context: { ...opts.context, mutation: this.mutationContext } } : opts);
  }

  err(error) {
    this.output.err(error);
  }

  /**
   * True only when a human can actually answer a prompt. Delegates to
   * canPrompt() so the check is "both stdio descriptors are TTYs AND no
   * agent/CI/opt-out marker is set" — a PTY allocated for an agent
   * (stdout.isTTY true, JSN_NO_PROMPTS/CI set) is NOT interactive.
   */
  isInteractive() {
    return canPrompt();
  }

  requireInstance() {
    requireSessionInstance(this.session);
  }

  requireAuth() {
    if (!this.auth.isAuthenticated()) {
      throw errAuth('Not authenticated');
    }
  }

  /**
   * Back-compat shim: override the effective instance for this command run.
   * Routes through the session resolver (rebuilds the SDK client).
   */
  setEffectiveInstance(url) {
    applySession(this, { instance: url });
  }

  /** Set (or clear with '') the domain for the active profile. */
  setDomain(domain) {
    const name = this.config.activeProfile || this.config.defaultProfile;
    if (!name) throw errUsage('No active profile to set a domain on');
    if (!this.config.profiles[name]) this.config.profiles[name] = {};
    this.config.profiles[name].domain = domain || '';
    return saveConfig(this.config);
  }
}

function resolveFormat(fmt) {
  switch (fmt) {
    case 'json': return FormatJSON;
    case 'markdown':
    case 'md': return FormatMarkdown;
    case 'quiet': return FormatQuiet;
    case 'styled': return FormatStyled;
    default: return FormatAuto;
  }
}
