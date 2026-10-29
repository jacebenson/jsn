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
**does not commit the application changes**: preview and resolve collisions in
ServiceNow before committing. Existing retrieved sets or member IDs cause refusal
before upload. A timeout or failed verification may mean partial loading; inspect
Retrieved Update Sets before retrying. The command does not silently replace an
existing set, rename one, convert it to a local set, or change its state.

Reopen a complete or ignored **local** update set explicitly:

```sh
jsn --profile source updatesets reopen "Digital Helpdesk 0.1.77"
```

This verifies `in progress` after the write and leaves selection unchanged. It
does not accept committed sets. Export and import never reopen or complete sets.
