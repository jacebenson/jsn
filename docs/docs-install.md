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

JSN runs locally on Windows, macOS, and Linux wherever Node.js and npm are available.

```bash
npm install -g @jacebenson/jsn
jsn --version
```

Then continue to [setup and authentication](/docs/setup/).

## Optional offline documentation

JSN installation does not download the ServiceNow documentation corpus. Setup
offers an optional source choice, and scripts can make the same choice directly:

```sh
jsn setup --docs-source snapshot
jsn docs install --source github
jsn docs install --source skip
```

The prebuilt source downloads an already searchable database from `jsn.jace.pro`.
Its manifest supplies the download size; JSN displays an estimate at 5 MiB/s plus
verification, clearly labeled because actual transfer time varies. The GitHub
source downloads approximately 51,000 raw files and indexes them locally; around
5–25 minutes is a labeled estimate: prior runs were around five minutes, while
full semantic indexing in the recorded validation took about 21 minutes. Actual
time varies by host and indexing options. Both use
the same FTS5 schema and local search. GitHub remains available if the snapshot
service is unavailable or a local source build is preferred.

If installation was skipped, first search explains the choices and asks approval;
noninteractive search returns an actionable install command. Existing indexes work
offline immediately. Snapshot freshness checks run in a separate bounded process
at most daily; `jsn docs status` reports a newer revision and its install command.
Downloads verify checksum, size, schema, FTS5 and SQLite integrity before replacing
the local index. `jsn docs rollback` restores the previous installed database.
`jsn docs sync` remains the explicit raw-source synchronization command.
