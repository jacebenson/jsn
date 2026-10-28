# JSN: ServiceNow CLI

A command-line interface for ServiceNow. Read and update records, manage flows, inspect platform data, and automate routine work from your terminal or AI agent.

## Install

Requires Node.js 22.5.0 or newer. Supports macOS, Linux, and Windows.

```bash
npm install -g @jacebenson/jsn
jsn setup
```

See the [setup guide](docs/docs-setup.md) to connect an instance safely.

### Dev channel

For the newest changes from `main`, including changes that may be unstable:

```bash
npm install -g @jacebenson/jsn@dev
```

Dev builds check the dev channel for updates during normal use, at most once
per day. Run `jsn version --check` to check immediately. To install the newest
dev build, run `npm install -g @jacebenson/jsn@dev` again. Updates are manual.
Return to stable with `npm install -g @jacebenson/jsn@latest`.

Pushes to `main` promote the commit to `dev` and publish a tested prerelease
under npm's `dev` tag. Versions include the workflow run number and attempt
(for example, `4.3.9-dev.123.1`); they do not move npm's stable `latest` tag.
The npm trusted publisher for `publish-dev.yml` must authorize the repository's
`dev` GitHub environment, alongside the production publishing configuration.

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
