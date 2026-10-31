# JSN: ServiceNow CLI

A command-line interface for ServiceNow. Read and update records, manage flows, inspect platform data, and automate routine work from your terminal or AI agent.

## Install

Requires Node.js 22.5.0 or newer. Supports macOS, Linux, and Windows.

```bash
npm install -g @jacebenson/jsn
jsn setup
```

See the [setup guide](docs/docs-setup.md) to connect an instance safely.

## Try it

```bash
jsn incidents list --query "active=true^priority=1"
jsn records list --table incident --limit 10 --json
jsn flows list
```

Run `jsn --help` for the command list. See the [CLI guide](https://github.com/jacebenson/jsn/blob/main/docs/cli-guide.md) for authentication, output formats, development, and examples. The [docs site](https://jacebenson.github.io/jsn/) has feature guides.

## AI agents

JSN includes a skill for Claude Code, OpenCode, Hermes, Cursor, Copilot, and other agents. Use `jsn skill install --target all` to install it or `jsn skill show` to inspect it.

## Development

From a repository checkout:

```bash
cd cli
npm ci
npm test
```

## License

MIT

## Documentation search

```bash
jsn docs "GlideRecord" --limit 5
jsn docs --path "api-reference/c_GlideRecordClientSideAPI.md"
```

No ServiceNow connection is required. Hosted docs at `https://jsn.jace.pro` are
the default and download no database. `jsn setup` asks once for defaults for new
connections and whether to use hosted documentation. Decline hosted docs to let
JSN start a local server, or decline that too and enter your own service base URL.
Later changes live under **Advanced settings** in setup. Existing connections
keep their saved settings.

Local mode downloads the public documentation on first use and checks for updates
daily while running. The server starts again automatically when needed. A first
search can report that the index is still being prepared; later updates preserve
the last working index if offline. Local storage lives under
`~/.jsn/docs-service` (`JSN_DATA_HOME` overrides the parent directory).

To host the same service yourself, run `jsn docs --serve --host 0.0.0.0 --port 3000`.
It manages its own index; expose it through your normal HTTPS proxy. The hosted
website and this server share one search engine. `JSN_DOCS_URL` temporarily
overrides the saved choice without starting a local server.

Exact paths remain stable across revisions. Numeric IDs can be pinned with
`--revision <search-revision>`. Older `docs search`, `docs show` and `docs status`
spellings remain compatible but are omitted from the everyday help menu.
