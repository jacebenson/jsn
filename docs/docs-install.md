---
title: Install JSN
subtitle: Install the ServiceNow CLI locally with npm, then verify the command is available.
docStep: 1
docLabel: Install
docNext: /docs/setup/
docNextLabel: Connect to ServiceNow →
permalink: /docs/install/
---

## Install

JSN runs locally on Windows, macOS, and Linux with the current Node.js LTS release and npm. Older Node.js release lines are not tested or supported.

```bash
npm install -g @jacebenson/jsn
jsn version
```

Then continue to [setup and authentication](/docs/setup/).

## Documentation source

Documentation search uses the hosted service by default. Installing JSN does not
download the ServiceNow documentation corpus, and no instance connection is
needed to search:

```sh
jsn docs "business rules"
jsn docs --path <exact-path-from-search>
```

Run `jsn setup` to choose hosted documentation, a custom service URL, or a local
documentation server under JSN settings, then Documentation source. Local mode
starts a loopback HTTP service and prepares its own index under
`~/.jsn/docs-service/`. The first preparation needs network access. Once an index
is ready, the local service can search it without reaching the hosted service;
background refresh still checks for updates.

The optional CLI browser UI and `--serve`, `--host`, and `--port` flags have been
removed. Terminal search and the hosted website remain available. For self-hosting
from a source checkout, run the shared JSON-only adapter explicitly:

```sh
JSN_DOCS_HOST=127.0.0.1 JSN_DOCS_PORT=3000 node cli/src/commands/docs/server.js
```

Point a separate CLI process at it with `JSN_DOCS_URL=http://127.0.0.1:3000`.
`JSN_DOCS_URL` overrides the documentation source saved by setup. It does not
change the active ServiceNow connection.

The retained `jsn docs install` and `jsn setup --docs-source` compatibility
commands prepare the older `~/.jsn/docs/docs.db` index, not the service index used
by current search. They do not select local-service mode. Use setup's
Documentation source choice for the current reader. `jsn docs sync` also manages
the older family index; `--no-ingest` downloads only its source and `--no-embed`
skips embeddings. `docs rollback` is not a registered maintenance operation.

## Families and exact document reads

Use `jsn docs "GlideRecord" --release brazil --limit 5` to select a family.
Resolution is `--release`, then the global `docs.release` preference, then
`australia`. Names contain 1–40 lowercase letters, digits, or dashes. The
service decides which families are available. Search, read, and status JSON
include the selected release.

Copy an exact path from search into `jsn docs --path <exact-path>`.
Numeric IDs can be pinned with `--revision <search-revision>` to reject a changed
index. See [targeted retrieval](https://github.com/jacebenson/jsn/blob/main/docs/TARGETED_DOCS.md) for outlines, complete section
subtrees, and the limits of section context. The compatible `docs search`,
`docs show`, and `docs status` spellings remain callable.

`jsn docs releases` lists locally installed families, revisions, document counts,
index paths, and the default marker without network access. These older indexes
live at `~/.jsn/docs/docs.db` for the default family and
`~/.jsn/docs/releases/NAME/docs.db` for others; `JSN_DATA_HOME` overrides the
parent directory. `jsn docs install --source snapshot --release brazil` prepares
such an index. Family snapshots use `/docs-index/releases/NAME/manifest.json`
and verify the declared release. Only the default family can fall back to the
legacy `/docs-index/manifest.json` on HTTP 404; that manifest may omit `release`.

Set `JSN_DOCS_RELEASE=brazil` on the JSON adapter to serve only that family and
reject requests for another. It serves no HTML or browser assets. Binding to
`0.0.0.0` exposes the service beyond loopback; use your
normal HTTPS proxy and access controls. `JSN_DOCS_URL` temporarily overrides the
saved service choice without starting a local server. Global preferences live
at `$XDG_CONFIG_HOME/servicenow/config.json`, normally
`~/.config/servicenow/config.json`. Setup preserves existing connection settings.
