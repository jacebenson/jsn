// ServiceNow AMB (Asynchronous Message Bus) client.
//
// AMB is ServiceNow's real-time channel service. It is a Bayeux / CometD
// long-polling endpoint at `/amb`: you POST JSON message arrays to
// `/amb/handshake` (once) and `/amb/connect` (everything else), and the
// server holds the connect request until it has an event or its hold timer
// expires. It is NOT socket.io — the wire format is Bayeux, so no socket.io
// or WebSocket runtime dependency is needed here.
//
// Authorization is the part that surprises people: AMB authorizes like a
// browser session, not like a REST request. A bearer token or Basic header
// is not enough; the server wants the session cookies (glide_session_store,
// JSESSIONID, BAYEUX_BROWSER) plus X-UserToken that a logged-in UI session
// carries. `SDKClient.ambSession()` supplies that material from the active
// JSN credential; when it cannot, this module raises an actionable error
// instead of guessing.
//
// This module owns protocol framing, cookie/token handling and event
// normalization. Reconnect policy, gap reporting and duration bounds live in
// src/record-watch.js.

import { AppError, CodeAPI, CodeAuth, CodeNetwork, CodeUsage } from './errors.js';

const BAYEUX_VERSION = '1.0';
const DEFAULT_CONNECT_TIMEOUT = 60000;
const DEFAULT_REQUEST_TIMEOUT = 30000;

// AMB's subscribe step is tied to a browser session. These are the cookies
// that carry it, plus node affinity (BAYEUX_BROWSER) which subscribe needs
// when the instance sits behind a load balancer.
const SESSION_COOKIE = /^(glide_|JSESSIONID|BIGipServer|XSRF-TOKEN|BAYEUX_BROWSER)/i;

export class AmbError extends AppError {
  constructor(code, message, hint = '', status = 0, cause = null) {
    super(code, message, hint, status, cause);
    // Auth/usage rejections cannot be fixed by reconnecting; transport and
    // 5xx failures can. The watch loop reads this to decide.
    this.fatal = code === CodeAuth || code === CodeUsage
      || (code === CodeAPI && status > 0 && status < 500);
  }
}

function ambAuthError(message, hint) {
  return new AmbError(CodeAuth, message, hint);
}

/**
 * The channel name for a record-watcher subscription.
 *
 * Encoding is ServiceNow's: standard base64 of the encoded query with `=`
 * replaced by `-` (a channel segment cannot contain `=`). The action prefix
 * defaults to `default`.
 */
export function recordWatcherChannel(table, query, actionPrefix = 'default') {
  if (typeof table !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new AmbError(CodeUsage, `Invalid table name for record watch: ${table}`);
  }
  if (typeof query !== 'string' || !query.trim()) {
    throw new AmbError(CodeUsage, 'A record watcher needs a non-empty encoded query.');
  }
  const encoded = Buffer.from(query, 'utf8').toString('base64').replace(/=/g, '-');
  return `/rw/${actionPrefix || 'default'}/${table}/${encoded}`;
}

const OPERATION_NAMES = {
  insert: 'created', entry: 'created', add: 'created', created: 'created',
  update: 'updated', change: 'updated', modify: 'updated', updated: 'updated',
  delete: 'deleted', removed: 'deleted', deleted: 'deleted',
};

/** Normalize one raw change entry; the platform has used several shapes. */
function normalizeChange(change) {
  if (Array.isArray(change)) {
    const [field, previous, value] = change;
    return { field: String(field ?? ''), previous_value: previous ?? null, value: value ?? null };
  }
  if (!change || typeof change !== 'object') return null;
  const field = change.field ?? change.name ?? change.key;
  if (!field) return null;
  const value = change.value ?? change.new_value ?? change.newValue;
  const previous = change.previous_value ?? change.old_value ?? change.oldValue;
  const out = { field: String(field) };
  if (value !== undefined) out.value = value;
  if (change.display_value !== undefined) out.display_value = change.display_value;
  if (previous !== undefined) out.previous_value = previous;
  return out;
}

/**
 * Turn a Bayeux event message on a record-watcher channel into the stable
 * event shape JSN emits. Notification data is kept separate from any record
 * state fetched later (see record-watch.js) — this object is only what the
 * notification itself carried.
 *
 * @param {object} message — { channel, data, id }
 * @param {{table?: string, sysID?: string}} expected — the watched record
 * @param {string} [receivedAt] — ISO timestamp
 */
export function normalizeRecordWatcherEvent(message, expected = {}, receivedAt = new Date().toISOString()) {
  const channel = message?.channel || '';
  let data = message?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') data = {};
  const record = data.record && typeof data.record === 'object' ? data.record : null;
  const channelTable = channel.split('/')[3] || null;
  const table = data.table || record?.table || expected.table || channelTable;
  const sysID = data.sys_id || record?.sys_id || expected.sysID || null;
  const rawOperation = String(data.operation || data.op || data.action || '').toLowerCase();
  const operation = OPERATION_NAMES[rawOperation] || (rawOperation ? 'changed' : 'unknown');
  const changes = Array.isArray(data.changes)
    ? data.changes.map(normalizeChange).filter(Boolean)
    : [];
  const displayValue = data.display_value ?? data.displayValue
    ?? record?.number ?? record?.display_value ?? null;

  const event = {
    type: 'record_change',
    channel,
    table,
    sys_id: sysID,
    operation,
    received_at: receivedAt,
  };
  if (rawOperation) event.action = rawOperation;
  if (displayValue != null) event.display_value = displayValue;
  if (message?.id != null) event.event_id = message.id;
  if (changes.length) event.changes = changes;
  if (record) event.record = record;
  return event;
}

/** Seed a cookie jar from a `a=1; b=2` header value. */
function seedCookies(jar, header) {
  for (const part of String(header || '').split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function serializeCookies(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Minimal Bayeux client for ServiceNow's /amb endpoint.
 *
 * `session()` returns `{ cookies, userToken }` and is called again on every
 * reconnect so an expired session can be refreshed instead of replaying a
 * dead cookie.
 */
export class AmbClient {
  constructor({
    baseUrl,
    session,
    fetchImpl = globalThis.fetch,
    path = '/amb',
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT,
  }) {
    if (!baseUrl) throw new AmbError(CodeUsage, 'AMB needs an instance URL.');
    if (typeof session !== 'function') throw new AmbError(CodeUsage, 'AMB needs a session provider.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.session = session;
    this.fetchImpl = fetchImpl;
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientId = null;
    this.sessionStatus = null;
    this.cookieJar = new Map();
    this.userToken = '';
    this.messageCounter = 0;
  }

  /** POST a Bayeux message array to /amb/handshake or /amb/connect. */
  async _send(messages, { op, timeoutMs, signal }) {
    const endpoint = op === 'handshake' ? 'handshake' : 'connect';
    const url = `${this.baseUrl}${this.path}/${endpoint}`;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const cookies = serializeCookies(this.cookieJar);
    if (cookies) headers.Cookie = cookies;
    if (this.userToken) headers['X-UserToken'] = this.userToken;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(messages),
        signal: controller.signal,
      });
      this._captureSession(response);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const status = response.status;
        if (status === 401) {
          throw new AmbError(CodeAuth, 'AMB rejected the active session (HTTP 401).',
            'Run "jsn auth login --browser" (or reauthenticate the profile), then retry the watch.', 401);
        }
        if (status === 403) {
          throw new AmbError(CodeAPI,
            'AMB access forbidden (HTTP 403).',
            'Record watching requires an interactive user session; check the role/ACL that governs AMB channels on this instance.',
            403);
        }
        if (status === 404) {
          throw new AmbError(CodeAPI,
            'AMB endpoint not found (HTTP 404).',
            'This instance does not expose /amb, or the instance URL is wrong. Record watching is supported on ServiceNow instances with the AMB service enabled.',
            404);
        }
        const summary = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new AmbError(CodeAPI, `AMB ${op} failed (HTTP ${status})${summary ? `: ${summary}` : '.'}`,
          status >= 500 ? 'The instance may be unavailable or the AMB service restarting; retry shortly.' : 'Check the AMB service on this instance.',
          status);
      }
      const json = await response.json();
      if (!Array.isArray(json)) {
        throw new AmbError(CodeAPI, `AMB ${op} returned an unexpected response.`, 'Expected a Bayeux message array; the instance may be proxying /amb to something else.');
      }
      return json;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const abortedByCaller = signal?.aborted === true;
      if (timedOut && !abortedByCaller) {
        const timeout = new AmbError(CodeNetwork, `AMB ${op} timed out after ${timeoutMs}ms.`,
          'The instance did not answer the AMB request. Check connectivity, then retry.');
        timeout.timedOut = true;
        throw timeout;
      }
      if (abortedByCaller) {
        const aborted = new AmbError(CodeNetwork, 'AMB request cancelled.');
        aborted.cancelled = true;
        throw aborted;
      }
      const network = new AmbError(CodeNetwork, `Network error talking to AMB: ${error.message || error}`,
        'Check your internet connection and instance URL.');
      network.cause = error;
      throw network;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  /** Keep session cookies and X-UserToken from any AMB response. */
  _captureSession(response) {
    const setCookies = response.headers?.getSetCookie?.() || [];
    const raw = setCookies.length
      ? setCookies
      : [response.headers?.get?.('set-cookie')].filter(Boolean);
    for (const value of raw) {
      const pair = value.split(';', 1)[0].trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      if (SESSION_COOKIE.test(name)) this.cookieJar.set(name, pair.slice(eq + 1));
    }
    const token = response.headers?.get?.('x-usertoken');
    if (token) this.userToken = token;
  }

  _message(channel, fields = {}) {
    if (!this.clientId) throw new AmbError(CodeUsage, 'AMB client has no clientId; handshake first.');
    return { channel, clientId: this.clientId, id: String(++this.messageCounter), ...fields };
  }

  /**
   * Refresh session material, handshake, and subscribe to every channel.
   * Re-run this after a dropped connection: re-subscribing is what restores
   * delivery, and the gap is reported by the caller.
   */
  async start(channels = []) {
    const session = await this.session();
    if (!session?.cookies) {
      throw ambAuthError('AMB needs a browser session and the active profile has none.',
        'Log in with a UI session ("jsn auth login --browser") or use a profile that stores gck cookies. Bearer-token-only profiles cannot open AMB channels.');
    }
    this.cookieJar.clear();
    seedCookies(this.cookieJar, session.cookies);
    this.userToken = session.userToken || '';
    this.clientId = null;

    const [handshake] = await this._send([{
      channel: '/meta/handshake',
      version: BAYEUX_VERSION,
      supportedConnectionTypes: ['long-polling'],
      id: String(++this.messageCounter),
    }], { op: 'handshake', timeoutMs: this.requestTimeoutMs });
    if (!handshake?.successful || !handshake?.clientId) {
      throw new AmbError(CodeAuth,
        `AMB handshake was rejected${handshake?.error ? `: ${handshake.error}` : '.'}`,
        'The active session is not accepted by AMB. Reauthenticate with "jsn auth login --browser"; basic/OAuth-only logins often cannot open a UI session.');
    }
    this.clientId = handshake.clientId;
    this.sessionStatus = handshake.ext?.['glide.session.status'] ?? null;

    for (const channel of channels) {
      const [reply] = await this._send([this._message('/meta/subscribe', { subscription: channel })],
        { op: 'subscribe', timeoutMs: this.requestTimeoutMs });
      if (!reply?.successful) {
        throw new AmbError(CodeAPI,
          `AMB subscribe failed for ${channel}${reply?.error ? `: ${reply.error}` : '.'}`,
          'The record watcher channel was refused. Check that the record is accessible to this user and that AMB record watchers are enabled on the instance.');
      }
    }
    return { clientId: this.clientId, sessionStatus: this.sessionStatus, channels: [...channels] };
  }

  /**
   * One long-poll: returns the non-meta Bayeux messages it received. A local
   * timeout returns an empty array (the loop just polls again) unless the
   * caller's signal aborted, which throws with `cancelled`.
   */
  async next({ timeoutMs = this.connectTimeoutMs, signal } = {}) {
    let messages;
    try {
      messages = await this._send([this._message('/meta/connect', { connectionType: 'long-polling' })],
        { op: 'connect', timeoutMs, signal });
    } catch (error) {
      if (error.timedOut) return [];
      throw error;
    }
    const events = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      if (message.channel?.startsWith('/meta/')) {
        // Server advised a fresh handshake (session moved nodes, restarted).
        if (message.advice?.reconnect === 'handshake' || (message.error && !message.successful)) {
          this.clientId = null;
          throw new AmbError(CodeNetwork, `AMB connection lost${message.error ? `: ${message.error}` : '.'}`,
            'Reconnecting re-subscribes the record watcher; events sent while disconnected are not replayed.');
        }
        continue;
      }
      events.push(message);
    }
    return events;
  }

  /** Best-effort unsubscribe + disconnect. Never throws. */
  async stop(channels = []) {
    if (!this.clientId) return;
    for (const channel of channels) {
      try {
        await this._send([this._message('/meta/unsubscribe', { subscription: channel })],
          { op: 'unsubscribe', timeoutMs: 5000 });
      } catch { /* best effort; the connect loop is already stopping */ }
    }
    try {
      await this._send([this._message('/meta/disconnect', {})], { op: 'disconnect', timeoutMs: 5000 });
    } catch { /* best effort */ }
    this.clientId = null;
  }
}

export function createAmbClient(options) {
  return new AmbClient(options);
}
