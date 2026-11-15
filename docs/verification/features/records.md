# Records

## Sub-features

`records list` queries a table. `records get` reads one record by `sys_id`. Create, update, delete, and bulk execution are mutation paths and are not part of the default read-only verification.

## How to get to it (user POV)

Run `node bin/jsn.js records list --table incident --limit 3 --columns number,short_description --json` with a named, disposable read-only profile selected by `--profile`.

## Driving it with the JSN CLI

Doctor the profile immediately before the read:

```bash
node cli/scripts/verify-jsn.mjs doctor --profile <disposable-read-only-profile>
node bin/jsn.js --profile <disposable-read-only-profile> records list --table incident --limit 3 --columns number,short_description --json
```

Proof requires exit 0, `ok: true`, a records array, and the requested fields. Human output can be checked with the same command without `--json`.

## Gotchas

Use an explicitly configured read-only profile. Authentication does not establish write safety. No local account or instance state is assumed.
