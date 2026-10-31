// Mock HTTP transport for testing service requests
// Replaces globalThis.fetch with a controllable mock

/**
 * Creates a mock fetch function for testing.
 *
 * @param {object[]} responses - Array of response configs, consumed in order
 *   Each response: { status, body, headers }
 * @param {object} captured - Object to capture request details into
 */
export function createMockFetch(responses = [], captured = {}) {
  let callCount = 0;
  const capturedRequests = [];

  const mockFetch = async (url, opts = {}) => {
    const req = {
      url: typeof url === 'string' ? url : url.url,
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.headers ? Object.fromEntries(opts.headers.entries?.() || []) : {},
      body: opts && opts.body ? opts.body.toString() : null,
    };
    capturedRequests.push(req);

    const respCfg = responses[callCount] || responses[responses.length - 1] || {};
    callCount++;

    // Build a mock Response object that acts like fetch's Response
    const bodyStr = typeof respCfg.body === 'string' ? respCfg.body : JSON.stringify(respCfg.body || {});
    const status = respCfg.status || 200;
    const respHeaders = {
      'content-type': 'application/json',
      ...(respCfg.headers || {}),
    };

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => respHeaders[name.toLowerCase()] || null,
        getSetCookie: () => null,
        forEach: (fn) => Object.entries(respHeaders).forEach(([k, v]) => fn(v, k)),
      },
      json: async () => {
        try { return JSON.parse(bodyStr); }
        catch { return { result: [] }; }
      },
      text: async () => bodyStr,
    };
  };

  Object.defineProperty(captured, 'requests', { get: () => capturedRequests });
  Object.defineProperty(captured, 'callCount', { get: () => callCount });

  return mockFetch;
}

/**
 * Install a mock fetch globally and return the cleanup function.
 */
export function withMockFetch(responses) {
  const captured = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(responses, captured);

  return {
    captured,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
