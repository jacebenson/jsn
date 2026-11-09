# Transfer an update set

Export without changing the source set's state or your selected capture context:

```sh
jsn --profile source updatesets export "Digital Helpdesk 0.1.77"
# In a terminal: Digital-Helpdesk-0.1.77.xml in the current directory.
jsn --profile source updatesets export "Digital Helpdesk 0.1.77" --out-dir ./exports
jsn --profile source updatesets export "Digital Helpdesk 0.1.77" --stdout > transfer.xml
```

Piped output remains raw XML. `--out FILE` selects an exact filename; `--out-dir`
selects a directory that already exists. Export refuses to overwrite a file.
Explicit JSON output without a file option retains the XML in its data envelope.

Inspect before loading:

```sh
jsn updatesets import transfer.xml --dry-run --json
jsn --profile target updatesets import transfer.xml --yes --json
```

The dry run is entirely local: it lists members with target names and actions,
primary table counts, and subsidiary payload operations such as translation or
flow cleanup. An omitted payload action is labeled `platform_default` rather than
guessed. Imports support one retrieved set per file, up to 50 MiB, and require an
admin session with native XML upload access. Without `--yes`, a terminal prompts;
noninteractive calls return a confirmation-required error with a rerun command.
Normal target selection (`--profile` / `--instance`) and read-only guards apply.

Successful import verifies the loaded set and every member ID/name/action. It
**does not apply the changes**: the set is left `loaded` and uncommitted so the
target can be previewed and reviewed first. Existing retrieved sets or member IDs
cause refusal before upload. A timeout or failed verification may mean partial
loading; inspect Retrieved Update Sets before retrying. The command does not
silently replace an existing set, rename one, convert it to a local set, or
change its state, and it refuses `--name`, `--local`, and `--state` rather than
quietly ignoring them.

Preview, inspect the problems a human must decide, then commit:

```sh
jsn --profile target updatesets preview "Digital Helpdesk 0.1.77" --yes
jsn --profile target updatesets problems "Digital Helpdesk 0.1.77"
jsn --profile target updatesets commit "Digital Helpdesk 0.1.77" --yes
```

`preview` and `commit` run the platform's own steps through the CICD Update Set
API (`sn_cicd`), which needs the CICD plugin and the `sn_cicd.sys_ci_automation`
role. If that API is unavailable, jsn reports it and starts nothing; use System
Update Sets > Retrieved Update Sets instead. Both commands follow the platform
progress tracker (`--timeout` seconds, default 600) and then read the retrieved
set back: `preview` must show `previewed`, `commit` must show `committed`. A
successful call whose state does not match is reported as an error, not assumed.

`problems` is read-only. It lists unresolved preview problems with their
description, missing item/table, and available actions; `--include-resolved`
also shows rows a human already accepted or skipped. jsn **never** accepts,
skips, or ignores a problem, and `commit` refuses while any problem is
unresolved. It also refuses when the problem read reaches its 500-row bound,
because a resolved sample does not prove that unread problems are resolved.
Review and commit such sets in ServiceNow. Resolve problems in ServiceNow, rerun
`preview`, then commit. A commit
resolves the local update set it created through the retrieved record's
`update_set` reference, falling back to a name lookup only when that reference is
absent; an ambiguous or missing local copy is reported, never guessed.

Neither command changes the selected update set or scope.

Reopen a complete or ignored **local** update set explicitly:

```sh
jsn --profile source updatesets reopen "Digital Helpdesk 0.1.77"
```

This verifies `in progress` after the write and leaves selection unchanged. It
does not accept committed sets. Export and import never reopen or complete sets.
