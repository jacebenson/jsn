# #320 terminal discovery verification

Date: 2026-10-28 (America/Chicago). Branch: `codex/command-discovery`.

These commands were run against this checkout's actual CLI, all exiting 0:

```sh
node bin/jsn.js discover --table incident --json --get data.commands.0.help
# "jsn incidents --help"

node bin/jsn.js discover "attachments catalog variables" --json --get data.commands.0.name
# "requests"

node bin/jsn.js discover --table incident --styled
# incidents: Manage incidents ...
#   Table: incident; default columns: number, short_description, priority, state, assigned_to
#   Configured list columns
#   Ticket-specific create/update flags
#   jsn incidents --help
#   jsn incidents list --help ...
#   jsn incidents show --help ...

node bin/jsn.js discover --table x_unknown --markdown
# Zero registered matches, with an actionable jsn records list --help fallback.
```

Daily version/skill checks were disabled for reproducibility. Discovery derives
these results from local command registrations and is declared no-instance and
offline. These examples perform no connected-PDI request and need no credentials;
a live PDI would not supply additional proof for this local registry operation.
No instance data, private records or credentials are captured here.

The regression suite verifies new/replaced registrations appear automatically,
exact table and action-text matching, structured extraction and human output,
unknown-table fallback, root help, strict parsing and shell completion. Full
suite: 1446 passed, 2 skipped, 0 failed (1448 total). Full lint and the local docs
fixture doctor/drive/cleanup also passed. See `docs/command-discovery-parity.md`
for the picker audit and skill-removal integration boundary.
