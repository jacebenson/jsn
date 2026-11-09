---
title: Install JSN
layout: comparison.njk
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

To run the shared server explicitly:

```sh
jsn docs --serve --host 127.0.0.1 --port 3000
```

Point a separate CLI process at it with `JSN_DOCS_URL=http://127.0.0.1:3000`.
`JSN_DOCS_URL` overrides the documentation source saved by setup. It does not
change the active ServiceNow connection.

The retained `jsn docs install` and `jsn setup --docs-source` compatibility
commands prepare the older `~/.jsn/docs/docs.db` index, not the service index used
by current search. They do not select local-service mode. Use setup's
Documentation source choice for the current reader. `docs sync` and
`docs rollback` are no longer registered operations; those words are search
terms, not maintenance commands.
