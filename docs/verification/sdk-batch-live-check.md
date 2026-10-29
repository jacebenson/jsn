# SDK batch: connected PDI verification attempt

Checked 2026-10-29 at 04:26 UTC using PR #339 implementation commit `a65e060`.
The initial read-only attempt was **blocked by the authentication gate**. After
the user approved credential renewal and the profile passed the doctor, the live
batch test **passed**. The successful run below establishes native endpoint
support; live unsupported-endpoint fallback was not observed.

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

## Successful live read-only run

The user approved renewal separately. The doctor was rerun at 04:28 UTC and
reported `ok: true`, `authenticated: true`, `verified: true`, and
`probe_status: succeeded` for `pdi`. Then this exact command ran from the PR
checkout (runtime source unchanged from implementation `a65e060`):

```sh
node docs/verification/sdk-batch-live-read.mjs pdi
```

The reproducible script uses this checkout's `SDKClient.batch` and existing scoped
credentials with refresh and auth recovery disabled. Its bearer-only lane disables
UI-session warming to avoid extra login/session requests. It submits two GETs:
limited `sys_db_object` metadata (`name=incident`, fields=`name`, limit=1), and
an Aggregate API count for the same metadata table/query. The outer Batch API
POST contains only these read subrequests; no records are created or changed.

Sanitized observed results:

| Request | HTTP | Result |
| --- | --- | --- |
| `POST /api/now/v1/batch` | 200 | Native batch transport |
| Metadata GET | 200 | 1 result row |
| Aggregate GET | 200 | Count 1 |

Both subrequests were serviced successfully. `transport` was `batch` and
`fallback_observed` was `false`. This proves native endpoint support on the selected
PDI; unsupported-endpoint fallback remains covered by fixtures, not this live run.
No private record bodies, usernames, credentials, cookies, or hostnames appear in
the saved [JSON transcript](sdk-batch-live-result.json).

