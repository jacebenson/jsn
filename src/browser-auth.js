import { errAuth, errUsage } from './errors.js';
import { normalizeInstanceURL } from './config.js';

export const DEFAULT_BROWSER_URL = 'http://127.0.0.1:9222';

// Browser access is opt-in and confined to a local debugging connection.
// Never inspect profile databases or enumerate cookies for unrelated sites.
function localEndpoint(value, protocol) {
  let url;
  try { url = new URL(value); } catch { throw errUsage('Invalid browser debugging URL.'); }
  if (url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw errUsage('Browser debugging must use a loopback URL without credentials, query, or fragment.');
  }
  return url;
}

function connect(url, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const fail = () => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(errAuth('Browser debugging connection closed. Retry the import.'));
      }
      pending.clear();
    };
    const timer = setTimeout(() => {
      reject(errAuth('Timed out connecting to the browser debugging port.'));
      socket.close();
    }, timeout);
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(errAuth('Could not connect to the browser debugging port.'));
      fail();
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(errAuth('Browser debugging connection closed. Retry the import.'));
      fail();
    });
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      // Provider errors can contain evaluated values; never echo them.
      if (message.error) request.reject(errAuth('The browser could not read the selected session.'));
      else request.resolve(message.result);
    });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(errAuth('Timed out reading the browser session.'));
            }, timeout);
            pending.set(id, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ id, method, params })); } catch {
              clearTimeout(timer);
              pending.delete(id);
              reject(errAuth('Browser debugging connection closed. Retry the import.'));
            }
          });
        },
        close: () => socket.close(),
      });
    });
  });
}

// Only read the token from the matching origin, including classic UI frames.
// This does not navigate, reload, or initiate requests in the user's browser.
const TOKEN_EXPRESSION = `(() => {
  const origin = location.origin;
  function read(win) {
    try {
      if (win.location.origin !== origin) return '';
      if (typeof win.g_ck === 'string' && win.g_ck) return win.g_ck;
      for (let i = 0; i < win.frames.length; i++) {
        const token = read(win.frames[i]);
        if (token) return token;
      }
    } catch {}
    return '';
  }
  return { origin, token: read(window) };
})()`;

export async function readBrowserSession(instance, { browserUrl = DEFAULT_BROWSER_URL, timeout = 10000 } = {}) {
  const origin = normalizeInstanceURL(instance);
  const endpoint = localEndpoint(browserUrl, 'http:');
  if (endpoint.pathname !== '/') throw errUsage('Browser debugging URL must be an origin, for example http://127.0.0.1:9222.');
  let tabs;
  try {
    const response = await fetch(new URL('/json/list', endpoint), {
      signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) throw new Error();
    tabs = await response.json();
  } catch {
    throw errAuth('Could not list browser tabs. Enable local Chromium remote debugging, then retry with --browser --browser-url http://127.0.0.1:9222.');
  }
  const matching = Array.isArray(tabs) ? tabs.filter(tab => {
    try { return tab.type === 'page' && new URL(tab.url).origin === origin; } catch { return false; }
  }) : [];
  if (!matching.length) throw errAuth('No matching ServiceNow tab. Open the selected instance in the connected browser and sign in first.');
  if (matching.length > 1) throw errAuth('Multiple tabs match this instance. Keep one tab open for the account to import, then retry.');
  const ws = localEndpoint(matching[0].webSocketDebuggerUrl, 'ws:');
  if (ws.hostname !== endpoint.hostname || ws.port !== endpoint.port) {
    throw errAuth('Browser returned a debugging connection outside the selected endpoint.');
  }
  const client = await connect(ws, timeout);
  try {
    const evaluated = await client.send('Runtime.evaluate', { expression: TOKEN_EXPRESSION, returnByValue: true });
    const session = evaluated?.result?.value;
    if (evaluated?.exceptionDetails || session?.origin !== origin || typeof session?.token !== 'string' || !session.token) {
      throw errAuth('No user token in the matching tab. Sign in and open a ServiceNow application page, then retry; pasted headers with --gck remain available.');
    }
    const result = await client.send('Network.getCookies', { urls: [`${origin}/api/now/table/sys_user`] });
    const cookies = result?.cookies;
    if (!Array.isArray(cookies) || !cookies.length) throw errAuth('No cookies available for the selected instance. Sign in and retry.');
    // Confirm the page did not navigate to another origin during the read.
    const location = await client.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    if (location?.result?.value !== origin) throw errAuth('The browser tab changed during import. Retry on the selected instance.');
    const cookieHeader = cookies.map(({ name, value }) => {
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)
        || typeof value !== 'string' || /[\r\n;]/.test(value)) throw errAuth('The browser returned invalid cookies.');
      return `${name}=${value}`;
    }).join('; ');
    if (/[\r\n]/.test(session.token)) throw errAuth('The browser returned an invalid user token.');
    return { auth_method: 'gck', access_token: session.token, cookies: cookieHeader, auth_source: 'gck' };
  } finally {
    client.close();
  }
}
