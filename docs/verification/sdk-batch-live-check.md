# SDK batch: connected PDI verification attempt

Checked 2026-10-29 at 04:26 UTC using PR #339 implementation commit `a65e060`.
The requested live read-only test was **blocked by the authentication gate**.
No Batch API request was sent. Endpoint support and live fallback behavior remain
unverified; the existing HTTP fixtures are not live-instance evidence.

Exact command, executed from the PR checkout:

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
```

Sanitized terminal result (instance hostname and local evidence path omitted):

```json
{
  "ok": false,
  "kind": "jsn-doctor",
  "package_version": "4.3.13",
  "binary": "bin/jsn.js",
  "version": { "status": 0, "reported": "4.3.13" },
  "profile": {
    "name": "pdi",
    "default": true,
    "authenticated": false,
    "verified": null,
    "read_only": false,
    "auth_method": "oauth",
    "auth_source": "keyring",
    "probe_status": "not_attempted",
    "probe_code": "refresh_required"
  },
  "auth_boundary": "credential contents were not read or printed",
  "commands": { "version": 0, "auth_status": 0 }
}
```

Doctor exited **2**. The configured OAuth credential requires refresh, so the
verification workflow correctly stopped before contacting the Batch API. No
login, credential refresh, or record writes occurred. No credential contents were
printed or saved in evidence.

After the user restores an authenticated session, rerun the doctor and then test
GET-only batch requests for limited metadata (for example `sys_db_object` names
and an aggregate count). Record observed transport (`batch` or `individual`),
per-request HTTP status and result counts without publishing record bodies or
credentials. That subsequent run is required before claiming live support.
