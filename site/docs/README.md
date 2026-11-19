# JSN documentation sources

This directory is the single documentation source boundary. Rails publishes only
the guides allowlisted in `site/config/guides.json` at `/docs/<key>/` and the
feature references named by `site/data/showcase-data.json` on their feature page.

## Published guides

- [Install](guides/install.md), [connect an instance](guides/setup.md),
  [safety and mutations](guides/safety.md), [output](guides/output.md)
- [Agent usage](guides/agents.md), [CLI guide](guides/cli-guide.md)
- [Flows](guides/flows.md), [records](guides/records.md),
  [update sets](guides/updatesets.md), [MID Server](guides/midservers.md),
  [Store applications](guides/store.md)

## Feature references

- [ServiceNow code search](features/servicenow-code-search-cli.md) — rendered on
  `/features/servicenow-code-search-cli/` in a default-closed details section.

## Source-only material

- [Architecture and decisions](maintainers/architecture.md)
- [Testing and parity reports](maintainers/testing.md)
- [Release maintenance](maintainers/releases.md)

Maintainer documents and `evidence/` are retained for contributors. They are not
published as app routes; there is no catch-all Markdown route. Old public guide
and legacy URLs redirect to the exact surviving page or section through
`site/config/legacy-guide-urls.json`.

Website data and public assets remain under `site/data/` and `site/static/`.
The ServiceNow corpus reader at `/documentation` is separate from these guides.
