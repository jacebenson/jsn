// Credential transport policy. Only process state can enable legacy HTTP;
// project configuration must never relax this boundary.
import { errAuth } from '../errors.js';

export function assertCredentialTransport(destination) {
  let url;
  try { url = new URL(destination); } catch { throw errAuth('Invalid credential destination'); }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw errAuth('Invalid credential destination');
  if (url.protocol !== 'https:' && !loopback && process.env.JSN_ALLOW_INSECURE_HTTP !== '1') {
    throw errAuth('HTTPS is required for credential destinations (except loopback development). Set JSN_ALLOW_INSECURE_HTTP=1 in this process only to explicitly allow legacy HTTP.');
  }
  return url;
}
