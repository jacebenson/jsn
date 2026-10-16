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

Run `jsn --help` for the command list. See the [CLI guide](docs/cli-guide.md) for authentication, output formats, development, and examples. The [docs site](https://jacebenson.github.io/jsn/) has feature guides.

## AI agents

JSN includes a skill for Claude Code, OpenCode, Hermes, Cursor, Copilot, and other agents. Use `jsn skill install --target all` to install it or `jsn skill show` to inspect it.

## Development

```bash
npm install
npm test
```

## License

MIT
