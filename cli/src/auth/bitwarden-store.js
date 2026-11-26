/**
 * Bitwarden CLI credential backend.
 *
 * For people who already keep their passwords in a Bitwarden vault, the OS
 * keyring is a second place to keep the same secret. This backend reads and
 * writes the credential JSON as a Bitwarden item, using the `bw` CLI and the
 * session the vault is already unlocked with.
 *
 * Session handling: `BW_SESSION` (from `bw unlock --raw`) is used when present.
 * Without it, reads fail with an actionable error instead of prompting from a
 * non-interactive command — the same posture as the keyring preflight: decide
 * before you need it.
 *
 * Item layout: one login-free secure note per credential, named
 * `servicenow-cli:<username>@<instance>`, whose notes field holds the same JSON
 * the other backends store. Nothing about the item is password-shaped, because
 * what is stored is a token bundle, not a password.
 */
import { execFileSync } from 'node:child_process';

const PREFIX = 'servicenow-cli:';
const TIMEOUT_MS = 20000;

/** The item name for one credential. Same key parts as the other backends. */
export function bitwardenItemName(instance, username) {
  const normalised = String(instance || '').replace(/\/+$/, '');
  return `${PREFIX}${username ? `${username}@` : ''}${normalised}`;
}

function binary() {
  return process.env.JSN_BW_BIN || 'bw';
}

function session() {
  const value = process.env.BW_SESSION;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function run(args, { input, session: token } = {}) {
  const full = token ? [...args, '--session', token] : args;
  return execFileSync(binary(), full, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * @returns {{state: 'unlocked'|'locked'|'unauthenticated'|'unavailable'|'not_installed', detail?: string}}
 */
export function bitwardenStatus() {
  try {
    const parsed = JSON.parse(run(['status']));
    const state = parsed?.status || parsed?.template?.status || 'unavailable';
    if (state === 'unlocked' && !session()) return { state: 'locked', detail: 'No BW_SESSION in this process; run: export BW_SESSION="$(bw unlock --raw)"' };
    return { state, detail: parsed?.serverUrl || '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'not_installed', detail: 'The `bw` CLI is not on PATH.' };
    return { state: 'unavailable', detail: String(error?.message || error).split('\n')[0] };
  }
}

function ensureSession() {
  const token = session();
  if (!token) {
    const error = new Error('Bitwarden is not unlocked for this process. Run: export BW_SESSION="$(bw unlock --raw)"');
    error.code = 'credential_storage_error';
    throw error;
  }
  return token;
}

function findItem(name, token) {
  // `bw get item <name>` matches by exact name first; a JSON body means it found
  // an item and a plain message means it did not.
  try {
    const output = run(['get', 'item', name], { session: token });
    const parsed = JSON.parse(output);
    return parsed?.id ? parsed : null;
  } catch (error) {
    const text = `${error?.stderr || ''}${error?.stdout || ''}${error?.message || ''}`;
    if (/not found|more than one/i.test(text)) return null;
    throw error;
  }
}

/** The JSON the other backends store, read from the item's notes field. */
export function parseCredentialNotes(item) {
  const notes = item?.notes;
  if (typeof notes !== 'string' || !notes.trim()) return null;
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function encodeItem(item, token) {
  // `bw encode` is the documented way to pass an item document without shell
  // quoting hazards; the JSON never appears in this process's arguments.
  return run(['encode'], { input: JSON.stringify(item), session: token }).trim();
}

function noteTemplate(name, notes) {
  return { type: 2, secureNote: { type: 0 }, name, notes, favorite: false };
}

export const bitwardenCredentialStore = {
  load(instance, username) {
    const token = ensureSession();
    const item = findItem(bitwardenItemName(instance, username), token);
    return item ? parseCredentialNotes(item) : null;
  },

  save(instance, credentials, username) {
    const token = ensureSession();
    const name = bitwardenItemName(instance, username);
    const notes = JSON.stringify(credentials);
    const existing = findItem(name, token);
    if (existing) {
      const updated = { ...existing, notes };
      run(['edit', 'item', existing.id, encodeItem(updated, token)], { session: token });
      return;
    }
    run(['create', 'item', encodeItem(noteTemplate(name, notes), token)], { session: token });
  },

  delete(instance, username) {
    const token = ensureSession();
    const item = findItem(bitwardenItemName(instance, username), token);
    if (item) run(['delete', 'item', item.id], { session: token });
  },
};
