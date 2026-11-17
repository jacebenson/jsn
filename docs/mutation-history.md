# Local mutation history (retired)

The CLI no longer creates, opens, updates or prunes a local mutation-history
database. `jsn history` and its subcommands are no longer available; they fail as
unknown commands. The logging-only global `--reason` option was removed too.
Command-specific provider reason fields and mutation safeguards are unchanged.

Existing `history.db` files under `JSN_DATA_HOME` (formerly `~/.jsn` by default)
are left untouched: there is no automatic deletion, migration or retention job.
This former convenience log did not provide undo or a durable ServiceNow audit.
Use the instance's audit/history facilities when you need provider-side evidence.
Documentation search indexes remain supported and separate.
