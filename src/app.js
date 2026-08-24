// App context: bundles config, auth, SDK, output, and runtime context
//
// Identity ("which instance, as whom, with what profile flags") is owned by
// the SESSION (src/session.js): the constructor resolves one from the
// config, the cli.js middleware re-applies it once --instance/--profile are
// known (applySession), and getEffectiveInstance()/requireInstance()/
// setEffectiveInstance() are thin session-backed shims kept for the many
// command handlers that already call them.

import { AuthManager } from './auth.js';
import { SDKClient } from './sdk.js';
import { OutputWriter, FormatAuto, FormatJSON, FormatMarkdown, FormatQuiet, FormatStyled, hyperlink } from './output.js';
import { saveConfig } from './config.js';
import { resolveSession, applySession, contextFromSession, requireSessionInstance } from './session.js';
import { getCurrentUser, getCurrentApplication, getCurrentUpdateSet } from './context.js';
import { errUsage, errAuth } from './errors.js';
import { isMutationCommand } from './mutations.js';
import process from 'node:process';


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
    });

    if (this.session.instance) {
      this._buildSdk(this.session.instance, this.session);
    }

    this.context = { profileName: '', username: '', scope: '', updateSet: '' };
    this.loadContext();
  }

  /** Build (or rebuild) the SDK client for an instance + session. */
  _buildSdk(instance, session = this.session) {
    this.sdk = new SDKClient(instance, this.auth, {
      domain: session?.domain || '',
    });
  }

  loadContext() {
    this.context = contextFromSession(this.session, this.config);
  }

  getEffectiveInstance() {
    return this.session?.instance || '';
  }

  async printContextHeader(argv = {}) {
    if (!this.getEffectiveInstance() || !this.sdk) return;
    if (process.env.JSN_NO_HEADER) return;
    if (this.output.getFormat() === FormatJSON || this.output.getFormat() === FormatQuiet) return;

    let userDisplayName = 'Unknown';
    let userSysID = '';

    try {
      const user = await getCurrentUser(this.sdk);
      if (user) {
        userDisplayName = user.name || user.user_name;
        userSysID = user.sys_id;
        this.context.username = userDisplayName;
      }
    } catch {
      // ignore
    }

    let displayUserName = userDisplayName;
    if (displayUserName.length > 10) {
      displayUserName = displayUserName.slice(0, 6) + '...';
    }

    let scope = 'global';
    if (userSysID) {
      try {
        const app = await getCurrentApplication(this.sdk, userSysID);
        if (app && app.scope) scope = app.scope;
      } catch {
        // ignore
      }
    }
    this.context.scope = scope;

    let updateSet = 'Default';
    let updateSetSysID = '';
    if (userSysID) {
      try {
        const us = await getCurrentUpdateSet(this.sdk, userSysID);
        if (us && us.name && us.name !== '-') {
          updateSet = us.name;
          updateSetSysID = us.sys_id;
        }
      } catch {
        // ignore
      }
    }
    this.context.updateSet = updateSet;

    const instance = this.getEffectiveInstance();
    const instanceLink = instance;
    const userLink = `${instance}/sys_user_list.do?sysparm_query=sys_id=${userSysID}`;
    const scopeLink = `${instance}/sys_scope.do?sysparm_query=scope=${scope}`;
    const updateSetLink = updateSetSysID
      ? `${instance}/sys_update_set.do?sys_id=${updateSetSysID}`
      : `${instance}/sys_update_set_list.do`;

    const scopeFormatted = `[${scope}]`;

    // Read-only profiles get a lock badge on every command run, so the
    // armed safety is always visible (not just in `auth status`).
    const roBadge = this.session?.readOnly === true ? ' 🔒' : '';

    process.stderr.write('# Use `jsn scopes` to change scope, `jsn updatesets set` to change updateset\n');
    process.stderr.write('PROFILE   USER      [SCOPE]           UPDATE SET\n');

    const profileStr = hyperlink(`${String(this.context.profileName).padEnd(9)}${roBadge}`, instanceLink);
    const userStr = hyperlink(String(displayUserName).padEnd(9), userLink);
    const scopeStr = hyperlink(String(scopeFormatted).padEnd(17), scopeLink);
    const updateSetStr = hyperlink(updateSet, updateSetLink);

    process.stderr.write(`${profileStr} ${userStr} ${scopeStr} ${updateSetStr}\n\n`);

    // ⚠️  Warning if in the Default update set (mutation commands only)
    if (isMutationCommand(argv) && updateSet && updateSet.toLowerCase().includes('default')) {
      const isGlobal = scope === 'global';
      if (isGlobal) {
        // 🔴 HARD WARNING — Global + Default
        process.stderr.write(
          '\x1b[31m' + // red
          '┏━ GLOBAL + DEFAULT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n' +
          '┃  You are in Global scope with the Default update set.  ┃\n' +
          '┃  Changes ARE captured — in the Default update set.     ┃\n' +
          '┃  Moving them to a named update set later requires      ┃\n' +
          '┃  manual surgery, one change at a time. Avoid the mess. ┃\n' +
          '┃                                                        ┃\n' +
          '┃  Create a named update set now:                        ┃\n' +
          '┃    jsn updatesets create --name "My Feature"       ┃\n' +
          '┃                                                        ┃\n' +
          '┃  Or switch to a scoped scope first:                    ┃\n' +
          '┃    jsn scopes list                                 ┃\n' +
          '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\x1b[0m\n'
        );
      } else {
        // 🟡 SOFT WARNING — Scope + Default
        process.stderr.write(
          '\x1b[33m' + // yellow
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
          '  ⚠  Default update set in scope [' + scope + ']\n' +
          '  Changes are contained to this scope, but a named\n' +
          '  update set is still recommended for tracking.\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
          '\x1b[0m' // reset
        );
      }
    }
  }

  ok(data, opts = {}) {
    this.output.ok(data, opts);
  }

  err(error) {
    this.output.err(error);
  }

  isInteractive() {
    return process.stdout.isTTY === true;
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
