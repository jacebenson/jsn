# ServiceNow Store applications

`jsn store` inspects the ServiceNow Store applications available to the
authenticated instance and requests explicit install/update operations.

Discovery and inspection are read-only. `install` and `update` are declared
mutations: read-only profiles block them, and they require confirmation unless
the profile skips confirmations or `--force` is passed.

> **Verification status.** The endpoints below come from the App Client
> application's own REST surface (`sn_appclient.appmanager`) as implemented by
> the reference Store CLI named in issue #400. They have **not** been verified
> against a live Store-entitled instance from this repository — CI has no such
> instance and no Store entitlement. Discovery/inspection is covered by mock
> transport tests; the lifecycle path is implemented against the same contract
> and is labelled unverified until a maintainer confirms it on a real instance.

## Commands

```sh
jsn store list --tab available|installed|updates [--limit 20] [--offset 0]
jsn store search "<term>" [--tab …] [--limit …] [--offset …]
jsn store show <app>
jsn store status <tracker-id>
jsn store install <app> --version <version> [--demo-data] [--wait] [--dry-run]
jsn store update  <app> [--version <version>] [--wait] [--dry-run]
```

`<app>` is a 32-character store application sys_id, an application scope
(`x_acme_app`), or an exact application name. Names and scopes resolve through
`sys_store_app`, then through the Store search endpoint; a name shared by
several applications fails as `ambiguous` instead of picking one. A company
application-repository application (`sys_app`) is refused with
`store_not_store_app` — `jsn store` handles ServiceNow Store applications only.

### Read-only inspection

`list` and `search` use the App Client's application list. The endpoint is
POST-shaped (an empty JSON body) but performs no mutation. Each row reports
`sys_id`, `name`, `scope`, `vendor`, `source`, installed `version`,
`latest_version`, `installed`, `update_available`, `installable`,
`is_store_app`, `is_plugin`, `price_type`, `needs_app_engine_licensing` and
`short_description`.

A 2xx body without `result.apps` is a **malformed response**, reported as an
unavailable source — never an empty catalogue.

`show` reports, where the platform exposes them:

- the installed version, active flag and install/update dates;
- the latest version, version list and `compatibilities`;
- entitlement/licensing flags (`can_install_or_upgrade`,
  `can_install_or_upgrade_customization`, `needs_app_engine_licensing`,
  `price_type`, `subscription_applicable`);
- `dependencies`;
- `detail_unavailable` (`forbidden`/`not_found`) if the App Client detail read
  fails, so missing detail is never rendered as empty data;
- notes, including that the platform does not say whether a refusal is caused by
  entitlement, licensing or compatibility, and that jsn never infers purchase
  authorization or accepts commercial terms.

### Lifecycle operations

Before anything is sent, `install`/`update` resolve the exact application and
version and refuse:

- an unknown application (`not_found`) or an ambiguous name (`ambiguous`);
- a missing `--version` (installs always need an explicit version; updates
  default to the reported `latest_version`);
- a version the Store did not offer (`store_version_unavailable`);
- an application the client reports as not installable (`store_app_not_installable`);
- `install` of an already-installed application (`store_already_installed`);
- `update` of an application that is not installed (`store_not_installed`) or to
  its current version (`store_version_unchanged`).

`--dry-run` performs all of those reads, reports the intended operation and
sends nothing.

A real operation: confirms, submits, and returns the asynchronous tracker id.
**Submission is not a completed installation.** With `--wait`, jsn polls the
CI/CD progress tracker, then reads `sys_store_app` back and compares the
installed version:

- `verification.verified: true` — the readback shows the requested version;
- `verification.verified: false` — the tracker reported success but the record
  shows another version; the command fails with `store_verification_failed`;
- `verification.verified: null` — the record could not be read; the command
  reports the success as unverified rather than claiming completion.

A failed tracker fails the command with `store_operation_failed` and keeps the
tracker id. An expired wait keeps the tracker id, reports `wait_timed_out` and
does not cancel or resubmit. A submission without a usable tracker id fails with
`store_tracker_missing` and is never retried.

`jsn store status <tracker-id>` reads the tracker directly: `status`,
`status_label`, `status_message`, `percent_complete`, `terminal`, `succeeded`.

## What a maintainer must confirm live

1. The App Client endpoints and their payloads on a Store-entitled instance,
   including whether the list/search endpoint accepts the documented POST body.
2. The roles required for `appmanager` search/detail and for install/update.
3. The `versions` list shape (`string[]` vs objects) used to reject an
   unavailable version.
4. That a successful tracker plus a matching `sys_store_app.version` readback is
   sufficient proof of installation on supported ServiceNow versions.
5. Repair/reinstall behaviour, which is deliberately not implemented here.
