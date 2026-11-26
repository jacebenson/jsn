/**
 * Credential-storage preflight for setup and login.
 *
 * `jsn setup` used to ask for the instance, a profile name, an auth method, the
 * connection preferences, a username and a password, complete the network
 * login, and only then fail with "Secure credential storage unavailable" —
 * because nothing checked the store until the first save. On a headless host
 * that is every question wasted, after a live authentication.
 *
 * This runs the probe before the first question and gives the person one
 * decision instead: repair the store, opt into plaintext for this profile, or
 * cancel. Non-interactive callers fail before any network authentication with
 * the exact repair command.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AppError, CodeAuth } from '../errors.js';
import { canUsePicker } from '../helpers.js';
// Imported from the engine, not from prompts.js: test suites replace that
// module wholesale and would hide the error class.
import { PromptCancelled } from '../prompt-engine.js';
import { credentialStorageStatus, storageRepair, PLAINTEXT_ENV } from './credential-store.js';

const MAX_REPAIR_ATTEMPTS = 2;
const RC_MARKER = '# jsn: plaintext credential storage for this account';

function storageFailure(status) {
  const repair = status.repair || storageRepair(status.platform, status.reason);
  const lines = [
    repair.install ? `Repair: ${repair.install}` : null,
    // KEY=value is redacted by the output sanitizer; spell the assignment out.
    `Plaintext alternative (portable, less safe): set ${PLAINTEXT_ENV} to 1`,
    ...(repair.notes || []),
  ].filter(Boolean);
  const error = new AppError(CodeAuth,
    'Secure credential storage is not usable on this host, so the credential could not be stored. Nothing was sent to the instance.',
    lines.join(' '));
  error.context = { platform: status.platform, reason: status.reason, install: repair.install || null };
  return error;
}

/** Run the platform's package-manager line with the user's own terminal. */
function installKeyring(command, { run = spawnSync } = {}) {
  const parts = command.split(' ');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const argv = parts[0] === 'sudo' && isRoot ? parts.slice(1) : parts;
  const result = run(argv[0], argv.slice(1), { stdio: 'inherit' });
  return result.status === 0;
}

function shellExportLine(shell = process.env.SHELL || '') {
  const name = path.basename(shell || '');
  if (name === 'fish') return `set -gx ${PLAINTEXT_ENV} 1`;
  return `export ${PLAINTEXT_ENV}=1`;
}

function shellProfile(shell = process.env.SHELL || '') {
  const home = os.homedir();
  switch (path.basename(shell || '')) {
    case 'zsh': return path.join(home, '.zshrc');
    case 'bash': return path.join(home, '.bashrc');
    case 'fish': return path.join(home, '.config', 'fish', 'config.fish');
    default: return path.join(home, '.profile');
  }
}

/** Append the export line once, behind a marker, so it is visible and removable. */
function rememberExplicitly(profilePath = shellProfile()) {
  let existing = '';
  try { existing = fs.readFileSync(profilePath, 'utf8'); } catch { /* new file */ }
  if (existing.includes(RC_MARKER)) return { added: false, path: profilePath };
  fs.mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(profilePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${RC_MARKER}\n${shellExportLine()}\n`);
  return { added: true, path: profilePath };
}

/**
 * Ensure credentials can be stored before anything asks for them.
 *
 * @param {object} app
 * @param {object} [argv]
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<{available: boolean, plaintext_allowed: boolean}>}
 */
export async function ensureCredentialStorage(app, argv = {}, deps = {}) {
  const {
    status: check = () => credentialStorageStatus(),
    run = spawnSync,
    out = process.stdout,
    env = process.env,
    profilePath = shellProfile(),
    interactive = null,
  } = deps;

  let status = check();
  if (status.available) return status;
  // A prompt needs a terminal on both ends. Suites and CI mock interactivity
  // but have no TTY, and would otherwise sit on a storage question forever.
  const canPrompt = interactive ?? (canUsePicker(app, argv) && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  if (!canPrompt) throw storageFailure(status);
  // Prompts load lazily, like loginWizard: suites that replace prompts.js must
  // not break this module's import graph.
  const prompts = deps.ask && deps.askConfirm ? null : await import('../prompts.js');
  const ask = deps.ask || prompts.select;
  const askConfirm = deps.askConfirm || prompts.confirm;

  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
    const repair = status.repair || storageRepair(status.platform, status.reason);
    out.write(`\nSecure credential storage is not usable: ${status.reason}.\n`);
    for (const note of repair.notes || []) out.write(`  ${note}\n`);
    if (repair.install) out.write(`  Suggested repair: ${repair.install}\n`);
    const choices = [
      ...(repair.install ? [{ name: `Install / start the keyring now (${repair.install})`, value: 'install' }] : []),
      { name: `Store credentials in plaintext for this profile (export ${PLAINTEXT_ENV}=1)`, value: 'plaintext' },
      { name: 'Cancel', value: 'cancel' },
    ];
    const choice = await ask({ message: 'How do you want to store your ServiceNow credentials?', choices });

    if (choice === 'cancel') throw new PromptCancelled();
    if (choice === 'install') {
      out.write(`\nRunning: ${repair.install}\n`);
      const ok = installKeyring(repair.install, { run });
      status = check();
      if (status.available) { out.write('Secure credential storage is ready.\n'); return status; }
      out.write(ok
        ? 'The packages installed, but this session still cannot reach the keyring.\n'
        : 'The install command did not succeed.\n');
      continue;
    }
    // Plaintext: this process may store the credential now; the person decides
    // whether it survives into their shell.
    env[PLAINTEXT_ENV] = '1';
    const line = shellExportLine();
    out.write(`\nPlaintext storage enabled for this run. Credentials are written as private 0600 files.\n`
      + `Every later jsn process needs: ${line}\n`
      + 'Never commit or share those files; keep backups off shared storage.\n');
    if (await askConfirm({ message: `Add that line to ${profilePath} so later commands work?`, default: false })) {
      const { added } = rememberExplicitly(profilePath);
      out.write(added ? `Added to ${profilePath} (remove the "${RC_MARKER.trim()}" block to undo).\n` : `${profilePath} already has it.\n`);
    } else {
      out.write('Not added to your shell; export it yourself before the next command.\n');
    }
    return { ...status, available: false, plaintext_allowed: true };
  }

  throw storageFailure(check());
}
