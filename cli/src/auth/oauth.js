import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globalConfigDir } from '../config.js';
import { credKey } from './credential-store.js';

// ─── PKCE state persistence (shared with Go version) ───

function pkceStatePath(instance, username) {
  const dir = path.join(globalConfigDir(), 'pkce');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A known profile identity gets its own pending-login slot. Keep the bare
  // instance slot for legacy/no-profile flows, where no identity exists yet.
  const filename = credKey(instance, username) + '.json';
  return path.join(dir, filename);
}

export function savePKCEState(instance, pkce, username) {
  const filePath = pkceStatePath(instance, username);
  fs.writeFileSync(filePath, JSON.stringify(pkce, null, 2), { mode: 0o600 });
}

export function loadPKCEState(instance, username) {
  try {
    const data = fs.readFileSync(pkceStatePath(instance, username), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function removePKCEState(instance, username) {
  try {
    fs.unlinkSync(pkceStatePath(instance, username));
  } catch {
    // ignore
  }
}

const DEFAULT_OAUTH_CLIENT_ID = '543e5655f77746a28228c6009a599dfb';
export const REDIRECT_URI = '/sdk-oauth.do';

export function getOAuthClientID() {
  return process.env.SERVICENOW_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
}

export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { code_verifier: verifier, code_challenge: challenge, state };
}

export function buildAuthURL(instanceURL, clientID, pkce) {
  const u = new URL('/oauth_auth.do', instanceURL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', pkce.state);
  u.searchParams.set('code_challenge', pkce.code_challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('scope', 'openid');
  u.searchParams.set('approval_prompt', 'force');
  return u.toString();
}

