# JSN: ServiceNow CLI

Read ServiceNow records, inspect platform metadata, search documentation, and make explicit changes from your terminal or AI agent.

[npm](https://www.npmjs.com/package/@jacebenson/jsn) · [GitHub](https://github.com/jacebenson/jsn) · [JSN docs](https://jsn.jace.pro/docs/install/)

## Install and connect

Use the current [Node.js LTS release](https://nodejs.org/en/about/previous-releases) and npm on macOS, Linux, or Windows. Older Node.js release lines are not supported.

```sh
npm install -g @jacebenson/jsn
jsn setup
```

Setup connects a named profile to your instance. Its default preset allows writes, so enable read-only mode before exploring. See [setup and authentication](docs/docs-setup.md).

For unreleased changes, use `npm install -g @jacebenson/jsn@dev`; see [channels and updates](docs/releases.md).

## Read and discover

```sh
jsn records list --table incident --query "active=true" --limit 5 --json
jsn discover --table incident
jsn docs "GlideRecord" --limit 5
jsn --help
```

Instance reads use your selected profile; add `--profile <name>` to choose another. Documentation search needs no ServiceNow connection and uses the hosted service by default. Use `jsn <command> --help` for options or `jsn --all-commands --help` for the full reference.

## Choose output

Use the default terminal view for people, `--csv` or `--tsv` for flat rows, and `--json` when scripts need pagination, context, or errors. CSV/TSV do not fetch more pages or preserve both reference IDs and labels. Pagination notices go to stderr only when more results are explicitly known; silence does not prove completeness. JSON retains reference objects only if the command has not already flattened them. See [output details](docs/cli-guide.md#output-formats).

## Work safely

Use `jsn auth modify <profile> --read-only` to block instance writes. ServiceNow roles and ACLs still decide what you can access. Help and discovery may show a compact command list for the connected account; this is not an access grant or an exhaustive capability check.

Writes are not universally dry-run operations or confirmation prompts. Inspect each command's help, target profile, scope, and update set before changing anything. Use `--force` only for an approved operation. See [safety guidance](docs/docs-safety.md).

## AI agents

Inspect the bundled skill with `jsn skill show`, then use `jsn skill install` to select your agent or `jsn skill install --target hermes` for Hermes. Reinstall after upgrading JSN; reinstalling replaces recorded copies, including local edits. See [agent installation](docs/docs-agents.md).

## Go deeper

- [CLI guide and feature workflows](docs/cli-guide.md)
- [Documentation search and local hosting](docs/docs-install.md)
- [Feature library](https://jsn.jace.pro/#features)

## Development and contributing

```sh
npm --prefix cli ci
npm test
npm run lint
node cli/bin/jsn.js --help
```

The published package, tests, and bundled skill live in [`cli/`](cli/README.md). The Rails website and public documentation API live in [`site/`](site/README.md); static reference pages live in [`docs/`](docs/). The CLI and website share the documentation search engine.

Run package commands, including `npm pack`, from `cli/`, not the private root package. For contribution rules and design context, read [AGENTS.md](AGENTS.md), [GLOSSARY.md](GLOSSARY.md), and [decisions](docs/DECISIONS.md). See [release maintenance](docs/releases.md) for the publishing workflow.

## License

[MIT](LICENSE).
