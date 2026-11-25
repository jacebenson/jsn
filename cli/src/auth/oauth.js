import crypto from 'node:crypto';
import { credKey, writePrivateState, readPrivateState, removePrivateState } from './credential-store.js';

export function savePKCEState(instance, pkce, username) {
  writePrivateState('pkce', credKey(instance, username), pkce);
}

export function loadPKCEState(instance, username) {
  return readPrivateState('pkce', credKey(instance, username));
}

export function removePKCEState(instance, username) {
  removePrivateState('pkce', credKey(instance, username));
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

