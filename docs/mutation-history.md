# Local mutation history

JSN automatically keeps seven days of Table API create, update and delete history
in `history.db` under `JSN_DATA_HOME` (default `~/.jsn`). No documentation download,
ServiceNow customization, or opt-in is needed. The database is local to this JSN
installation, not a durable ServiceNow audit log. Expired entries are purged when
history is read or written; `jsn history prune` safely removes expired entries only.

```sh
jsn --profile dev records update --table incident --sys-id ID --data '{"active":false}' --reason 'Maintenance ticket 123'
jsn history list --table incident --operation update --since 2026-10-28 --json
jsn history list --instance-url https://example.service-now.com --record FULL_SYS_ID
jsn history list --profile-name removed-profile --json
```

Use `jsn records update --help` for the installed command's input options. Reasons
must contain only non-sensitive context, such as a ticket number. Common credential
assignments and authorization values are redacted, but arbitrary prose cannot be
reliably recognized as a secret. Do not put credentials or record contents in a
reason. History stores no payloads, response bodies, or authentication headers.

Successful mutations include their full returned or requested record ID. A create
whose response provides no ID is marked `unknown`. Definitive HTTP rejections are
`failed`; connection loss, timeout and server errors are `unknown`, because the
server may have committed a write. Authentication replay produces a single final
event. Non-Table APIs and scripts cannot be interpreted as record mutations and are
outside this history. Local history storage failure emits a warning without
changing the reported remote result. Confirmation rules remain the same.
