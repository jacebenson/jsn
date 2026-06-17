// App context: bundles config, auth, SDK, output, and runtime context

import { AuthManager } from './auth.js';
import { SDKClient } from './sdk.js';
import { OutputWriter, FormatAuto, FormatJSON, FormatMarkdown, FormatQuiet, FormatStyled } from './output.js';
import { getEffectiveInstance } from './config.js';
import { extractProfileName } from './helpers.js';
import { getCurrentUser, getCurrentApplication, getCurrentUpdateSet } from './context.js';
import { errUsage, errAuth } from './errors.js';
import process from 'node:process';


export class App {
  constructor(cfg) {
    this.config = cfg;
    this.auth = new AuthManager(this);
    this.output = new OutputWriter({ format: resolveFormat(cfg.format) });
    this.sdk = null;

    const instance = getEffectiveInstance(cfg);
    if (instance) {
      this.sdk = new SDKClient(instance, this.auth);
    }

    this.context = {
      profileName: '',
      username: '',
      scope: '',
      updateSet: '',
    };

    this.loadContext();
  }

  loadContext() {
    const activeName = this.config.activeProfile || this.config.defaultProfile;
    if (activeName && this.config.profiles[activeName]) {
      this.context.profileName = activeName;
      this.context.username = this.config.profiles[activeName].username || '';
      return;
    }

    // Fallback: no active profile name — find by instance URL (legacy config)
    const instance = getEffectiveInstance(this.config);
    if (!instance) return;
    this.context.profileName = extractProfileName(instance);
    for (const [name, profile] of Object.entries(this.config.profiles || {})) {
      if (profile.instance_url === instance) {
        this.context.profileName = name;
        this.context.username = profile.username || '';
        break;
      }
    }
  }

  getEffectiveInstance() {
    return getEffectiveInstance(this.config);
  }

  async printContextHeader() {
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

    process.stderr.write('# Use `jsn dev scopes` to change scope, `jsn dev updatesets set` to change updateset\n');
    process.stderr.write('PROFILE   USER      [SCOPE]           UPDATE SET\n');

    const profileStr = `]8;;${instanceLink}\x07${String(this.context.profileName).padEnd(9)}]8;;\x07`;
    const userStr = `]8;;${userLink}\x07${String(displayUserName).padEnd(9)}]8;;\x07`;
    const scopeStr = `]8;;${scopeLink}\x07${String(scopeFormatted).padEnd(17)}]8;;\x07`;
    const updateSetStr = `]8;;${updateSetLink}\x07${updateSet}]8;;\x07`;

    process.stderr.write(`${profileStr} ${userStr} ${scopeStr} ${updateSetStr}\n\n`);

    // ⚠️  Warning if in the Default update set
    if (updateSet && updateSet.toLowerCase().includes('default')) {
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
          '┃    jsn dev updatesets create --name "My Feature"       ┃\n' +
          '┃                                                        ┃\n' +
          '┃  Or switch to a scoped scope first:                    ┃\n' +
          '┃    jsn dev scopes list                                 ┃\n' +
          '┃                                                        ┃\n' +
          '┃  (Run jsn updatesets yolo to silence this check)       ┃\n' +
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
          '  (Run \x1b[1mjsn updatesets yolo\x1b[22m to silence this warning)\n' +
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
    if (!this.getEffectiveInstance()) {
      throw errUsage('Instance URL required. Set via --instance flag, SERVICENOW_INSTANCE_URL env, or config file.');
    }
  }

  requireAuth() {
    if (!this.auth.isAuthenticated()) {
      throw errAuth('Not authenticated');
    }
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
