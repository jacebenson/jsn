# Public website WebMCP guidance

The shared `/assets/webmcp.js?v=2` asset is loaded by the shared Rails layout, including Markdown guides. It progressively enhances the page only in secure contexts with
`document.modelContext.registerTool`. Ordinary browsing, authorization, and the
existing documentation API do not change. Tools are tab-bound, not a server MCP
endpoint, local CLI bridge, or ServiceNow connection.

## Tools

All six tools have closed JSON schemas and `readOnlyHint: true`. They return
JSON strings; errors are explicit `{ "error": "…" }` results.

| Tool | Input | Result |
| --- | --- | --- |
| `jsn_install_guidance` | `channel`: `stable` or `dev` | npm install command and verified install guide |
| `jsn_update_guidance` | `channel`: `stable` or `dev` | version check and channel-preserving npm install command |
| `jsn_remove_guidance` | `{}` | global npm uninstall instructions; retained profiles/credentials/caches/skills are not deleted |
| `jsn_docs_search` | `query`: 1–200 characters; `source`: `jsn` or `servicenow` | up to four bounded, source-labelled results |
| `jsn_bug_guidance` | `{}` | existing issue search/chooser and reproduction checklist |
| `jsn_feature_request_guidance` | `{}` | existing issue search/chooser and use-case checklist |

No commands execute and no GitHub issues are created. There are no repository
issue templates at implementation time, so both contribution tools use the
existing canonical chooser rather than inventing template links. Humans review
and submit on GitHub. No arbitrary URL, code, instance, or credentials input is
accepted. Search uses GET only, omits cookies, rejects redirects, and propagates
cancellation. API errors never become fabricated search results.

The JSN search source reuses the existing rendered feature catalog and its
case-insensitive substring filter; it is not a full-text index of all JSN pages.
Install/update/removal use dedicated tools. ServiceNow search uses the existing
`/api/docs/search` endpoint and echoes the served release into document links;
no family or package version is pinned. Results are external/untrusted content.

Install/update semantics are checked against `cli/src/commands/version.js`:
stable installs `@jacebenson/jsn`, dev installs `@jacebenson/jsn@dev`. The website
cannot inspect the user's installed version and requires an explicit channel.
Removal follows npm global uninstall behavior, not a config purge.

## Verification

Current API reference (reviewed for this change):
https://developer.chrome.com/docs/ai/webmcp/imperative-api (updated 2026-10-16).
It documents `document.modelContext.registerTool`, `getTools`, and `executeTool`.

After `node scripts/build-docs-site.mjs`, run:

```sh
node --check site/static/assets/webmcp.js
node --test site/test/*.test.mjs
npm test
npm run lint
```

The website workflow includes the new Node tests inside the built image.
Mock-capability tests cover six registrations, schema validation, handlers,
source separation, result bounds, failure/cancellation, unsupported browsers,
and the served asset/layout contract. They do not establish native discovery.

For native verification, serve the built Rails site, launch an isolated Chromium
with `--enable-features=WebMCPTesting`, open its localhost URL, and call:

```js
const tools = await document.modelContext.getTools();
const tool = tools.find(t => t.name === 'jsn_install_guidance');
await document.modelContext.executeTool(tool, { channel: 'stable' });
```

Repeat all six tools and both search sources, plus invalid input; check the
ordinary feature filter in a browser without the capability. A local unseeded
ServiceNow index returns 503. Native execution can separately be checked against
the live public search API using a test-only forwarding transport, clearly
reported as such, not as proof of the local corpus. Local registration does not
prove production deployment or support by any particular assistant client.
No deployment, origin-trial enrollment, browser configuration, or auth changes
are included in this PR.
