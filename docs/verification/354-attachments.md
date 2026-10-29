# Standalone attachment transfers (#354)

The transfer subtree has moved from `records attachments` to `attachments`.
`list` takes a parent record ID; `download` (`get`) takes only the attachment ID;
`upload` (`add`) takes a local file, parent table and parent record ID. The root
alias `attachment` also works. Optional attachment enrichment in `records get`
and rich request views is unchanged.

The root registry, `discover attachments`, parent JSON discovery, and help expose
these actions. Download results remain metadata envelopes rather than putting
binary bytes into stdout; `--get` still extracts envelope fields. Filenames from
the server are reduced to a safe basename (including Windows separators/device
names), and local replacement requires `--overwrite`. An explicit `--out` skips
the filename metadata lookup. Uploads retain confirmation, declared mutation
capabilities and read-only profile enforcement across all aliases.

## Local verification

- Full suite: **1,585 passed, 2 skipped, 0 failed** (1,587 total).
- Focused attachment/features/capability/output checks: **71 passed**.
- Full lint and diff whitespace checks passed.
- Local docs drive produced three JSON results and human output; cleanup passed.

`test/attachments.test.js` drives the actual repository CLI and SDK against a
loopback server, using an explicitly selected fixture profile while the default
points elsewhere. It verifies exact binary download/upload bytes, metadata and
name overrides, safe filenames, no accidental overwrite, explicit replacement,
`--out` metadata-call avoidance, upload confirmation, all upload aliases blocked
before any request on read-only profiles, JSON/extraction, discovery and removal
of the old subtree. Existing parent-discovery extraction regressions now exercise
the top-level attachment parent. SDK endpoints remain native attachment APIs;
no scripts or subprocess command dispatch are introduced.

These byte transfers and writes are local fixture evidence. No instance access,
credential refresh, remote-host changes or PDI writes were performed by this
implementation/test run. Any separately coordinated PDI proof is recorded with
its exact source revision and limits rather than implied by fixture results.
