# JSN feature map

This map names user-facing JSN surfaces and the proof that matters. Read the source command help before extending it. Do not add a command here unless `node cli/bin/jsn.js --help` or the command's source supports it.

| Feature | Entry point | Safe proof |
| --- | --- | --- |
| Records | `records list`, `records get` | JSON envelope, selected table, and returned record fields against a disposable read-only profile |
| Profiles and auth status | `auth status`, `auth switch` | Selected profile, host, auth method, and auth state without credential contents |
| Command discovery | `--help`, `<command> --help`, `completion` | Stable command names and documented options match the installed binary |
| Raw REST | `rest` | GET-only request against a disposable read-only profile, with JSON or raw text shape checked |
| Hosted docs service | `docs "query"`, `docs --path` | Search succeeds in JSON and Markdown against the local Rails service without an instance |

The current checkout has no authenticated disposable ServiceNow profile. The hosted docs service is the only live drive recorded today. Records and raw REST remain gated recipes until a safe profile is established.
