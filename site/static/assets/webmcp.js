// Public, tab-bound documentation guidance only. No CLI or instance access.
// API: https://developer.chrome.com/docs/ai/webmcp/imperative-api
(() => {
  if (!window.isSecureContext || !document.modelContext?.registerTool) return;
  const origin = 'https://jsn.jace.pro';
  const guide = `${origin}/docs/install/`;
  const repository = 'https://github.com/jacebenson/jsn';
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const channel = { type: 'string', enum: ['stable', 'dev'] };
  const validate = (input, schema) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object.');
    for (const key of Object.keys(input)) {
      const rule = schema.properties[key];
      if (!rule) throw new Error(`Unexpected input: ${key}`);
      const value = input[key];
      if (typeof value !== rule.type || (rule.enum && !rule.enum.includes(value)) ||
          (rule.minLength && value.trim().length < rule.minLength) ||
          (rule.maxLength && value.length > rule.maxLength)) throw new Error(`Invalid ${key}.`);
    }
    for (const key of schema.required || []) if (!(key in input)) throw new Error(`Missing ${key}.`);
  };
  const register = (name, description, inputSchema, handler) => {
    try {
      Promise.resolve(document.modelContext.registerTool({
        name, description, inputSchema,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input = {}, { signal } = {}) => {
          try {
            validate(input, inputSchema);
            const result = await handler(input, signal);
            while (JSON.stringify(result).length > 1800 && result.results?.length) result.results.pop();
            return JSON.stringify(result);
          }
          catch (error) { return JSON.stringify({ error: error.name === 'AbortError' ? 'Cancelled.' : String(error.message).slice(0, 180) }); }
        },
      })).catch(() => {}); // Experimental API failures must not affect ordinary browsing.
    } catch { /* Unsupported or policy-disabled API: leave the ordinary UI alone. */ }
  };
  const channelSchema = { ...empty, properties: { channel }, required: ['channel'] };
  const install = selected => `npm install -g @jacebenson/jsn${selected === 'dev' ? '@dev' : ''}`;
  register('jsn_install_guidance', 'How to install JSN. Instructions only; never executes commands. Choose stable/dev explicitly.', channelSchema,
    ({ channel: selected }) => ({ commands: [install(selected), 'jsn version'], channel: selected,
      note: 'Use current Node.js LTS and npm on Windows, macOS, or Linux. No connection or credentials needed for public documentation.', sources: [guide] }));
  register('jsn_update_guidance', 'How to update JSN preserving stable/dev channel. Instructions only; cannot inspect local installation. Choose the installed channel unless intentionally switching.', channelSchema,
    ({ channel: selected }) => ({ commands: ['jsn version --check', install(selected), 'jsn version'], channel: selected,
      note: 'Check your installed version first: -dev. versions use @dev; stable uses npm latest. Choose the matching channel unless intentionally switching. No pinned version supplied.',
      sources: [guide, `${repository}/blob/main/cli/src/commands/version.js`, 'https://www.npmjs.com/package/@jacebenson/jsn'] }));
  register('jsn_remove_guidance', 'How to uninstall global npm JSN. Instructions only; never deletes profiles, credentials, caches, or agent skills.', empty,
    () => ({ commands: ['npm uninstall -g @jacebenson/jsn'], note: 'Removes the npm-installed global package and command link, not user-created JSN profiles, credentials, documentation caches, or separately installed agent skills. This tool performs no removal. Manage retained data separately with explicit human review.',
      sources: [guide, 'https://docs.npmjs.com/cli/commands/npm-uninstall'] }));
  for (const [kind, name] of [['bug', 'jsn_bug_guidance'], ['feature', 'jsn_feature_request_guidance']]) {
    register(name, `How to ${kind === 'bug' ? 'file a JSN bug' : 'request a JSN feature'}. Returns existing GitHub issue chooser; never creates or posts an issue.`, empty,
      () => ({ url: `${repository}/issues/new/choose`, existing: `${repository}/issues`,
        note: `Search existing issues first. ${kind === 'bug' ? 'Include JSN version/channel, OS/Node version, reproduction steps, expected and actual behavior.' : 'Describe use case, desired behavior, alternatives, and acceptance criteria.'} Redact credentials, instance URLs and private records. No repository-specific issue templates currently exist; use the chooser or blank issue. Human review and GitHub sign-in/submission required.` }));
  }
  register('jsn_docs_search', 'Search public guidance. source=jsn searches existing JSN feature catalog (not ServiceNow reference); source=servicenow uses hosted public ServiceNow docs API. No instance access.', {
    ...empty, properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, source: { type: 'string', enum: ['jsn', 'servicenow'] } }, required: ['query', 'source'],
  }, async ({ query, source }, signal) => {
    if (source === 'jsn') {
      const response = await fetch('/features', { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`JSN catalog unavailable (HTTP ${response.status}).`);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      // Same cards and case-insensitive substring predicate as the feature UI.
      const results = [...doc.querySelectorAll('.feature-card')]
        .filter(card => card.textContent.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 4).flatMap(card => {
          const url = new URL(card.getAttribute('href'), origin);
          if (url.origin !== origin || !/^\/features\/[a-z0-9-]+\/?$/.test(url.pathname)) return [];
          return [{ title: card.querySelector('h3')?.textContent.trim().slice(0, 90), url: url.href }];
        });
      return { source: 'JSN public feature guidance', results, install: guide, browse: `${origin}/#features`, note: 'Feature catalog only; use dedicated tools for installation/update/removal.' };
    }
    const response = await fetch(`/api/docs/search?${new URLSearchParams({ q: query, limit: '4' })}`, { signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error(`ServiceNow documentation unavailable (HTTP ${response.status}). Retry at ${origin}/documentation.`);
    const data = await response.json();
    const results = (data.results || []).slice(0, 4).map(item => ({
      title: String(item.title || '').slice(0, 90), excerpt: String(item.summary || item.snippet || '').replace(/<[^>]*>/g, '').slice(0, 140),
      url: `${origin}/documentation/read?${new URLSearchParams({ path: String(item.path || ''), ...(data.release ? { release: data.release } : {}) })}`,
    }));
    return { source: 'ServiceNow documentation hosted by JSN (not JSN CLI guidance)', release: data.release, results,
      browse: `${origin}/documentation?${new URLSearchParams({ q: query })}` };
  });
})();
