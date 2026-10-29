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

Those local byte transfers and writes are fixture evidence. The following
separately authorized, coordinated run establishes actual instance behavior.

## Actual PDI terminal round trip

[Sanitized terminal evidence](354-attachments-pdi.json) records source
`1c6f449` and the actual commands/results (all exit 0). A fresh doctor passed
with profile pdi authenticated and verified before the run. One uniquely named
`jsn354.*` preference was created solely as a disposable attachment parent.

- `attachments upload <owned-tiny-file> --table sys_user_preference --sys-id <owned-parent> --name jsn354-proof.txt --force --json` returned an attachment ID.
- `attachments list --sys-id <owned-parent> --json` returned count 1 and that attachment.
- `attachments download <owned-attachment> --json` needed no parent ID, selected the expected filename and reproduced the exact 57 harmless text bytes.
- Exact owned attachment/preference IDs were deleted, with subsequent lists verifying both gone.

Current application/update-set preference snapshots matched before and after;
no scope/update-set selection commands ran. A temporary Node preload blocked
OAuth `refreshToken` for the entire run to enforce the shared-auth boundary;
the successful run required no renewal. No remote-host/MID operations occurred.
Local temporary files were removed and verify cleanup passed. The public proof
omits opaque IDs, hostname and credential contents. The final commit only adds
this evidence; runtime source is unchanged from the tested revision.
