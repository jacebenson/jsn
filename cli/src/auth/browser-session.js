import { errAuth } from '../errors.js';

/**
 * Extract the browser session token and cookies from pasted DevTools headers
 * or a "Copy as cURL" command. Only these two values are retained.
 */
export function parseBrowserSessionInput(input) {
  const text = String(input || '');
  const tokenMatch = text.match(/(?:x-usertoken|x-user-token)\s*:\s*([^\s'";,]+)/i);
  const cookieArgMatch = text.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])(.*?)\1/s);
  const quotedCookieMatch = text.match(/cookie\s*:\s*(['"])(.*?)\1/i);
  const plainCookieMatch = text.match(/cookie\s*:\s*([^\r\n]+)/i);
  const token = tokenMatch?.[1]?.trim() || '';
  const cookies = (cookieArgMatch?.[2] || quotedCookieMatch?.[2] || plainCookieMatch?.[1] || '')
    .trim()
    .replace(/['"`]\s*(?:\\\s*)?$/, '');
  if (!token) throw errAuth('No X-UserToken header found');
  if (!cookies) throw errAuth('No Cookie header found. Paste the complete request headers or cURL command.');
  return { auth_method: 'gck', access_token: token, cookies, auth_source: 'gck' };
}

