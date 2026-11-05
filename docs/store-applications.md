# ServiceNow Store applications

`jsn store` inspects the ServiceNow Store applications available to the
authenticated instance and requests explicit install/update operations.

Discovery and inspection are read-only. `install` and `update` are declared
mutations: read-only profiles block them, and they require confirmation unless
the profile skips confirmations or `--force` is passed.

> **Verification status.** Discovery and inspection are verified against a live
> instance (`dev366743`, 2026-11-04): 747 `sys_store_app` rows, 260 rows in the
> App Client's `installed` tab, and every response shape below captured from the
> wire. The lifecycle requests are registered on the same API and are exercised
> in-tests, but a real install/update has not been run from this repository, so
> the dispatch/tracker/readback path stays labelled unverified. See
> [What is still unverified](#what-is-still-unverified).

## Commands

```sh
jsn store list --tab available|installed|updates [--limit 20] [--offset 0]
jsn store search "<term>" [--tab …] [--limit …] [--offset …]
jsn store show <application>
jsn store status <tracker-id>
jsn store install <application> --version <version> [--demo-data] [--wait] [--dry-run]
jsn store update  <application> [--version <version>] [--wait] [--dry-run]
```

`<application>` is a 32-character store application sys_id, an application scope
(`x_acme_app`), or an exact application name. Names and scopes resolve through
`sys_store_app`, then through the Store search endpoint; a name shared by
several applications fails as `ambiguous` instead of picking one. A company
application-repository application (`sys_app`) is refused with
`store_not_store_app` — `jsn store` handles ServiceNow Store applications only.

## The App Client API, as measured

Everything under `/api/sn_appclient/appmanager` is the App Client's scripted
REST service (`AppManager(Internal API)`, service id `appmanager`). Its
operations are registered as:

| Operation | Method and path | Used for |
| --- | --- | --- |
| GetApps | `POST /apps` | `list`, `search` |
| GetAppById | `GET /app/{appID}` | `show`, and every lifecycle precheck |
| Install Application | `GET /app/install?app_id=&version=&load_demo_data=` | `install` |
| Update Application | `GET /app/update?app_id=&version=` | `update` |
| Execution Status | `GET /api/sn_cicd/progress/{trackerID}` | `status`, `--wait` |

ServiceNow's published OpenAPI for this service (`sn_appclient-AppManager
_Internal_API`) lists the same operations, with `app_id` and `version` both
**required** on install and update, `customization_version`/`load_demo_data`
optional, and `tab_context` required on `POST /apps` (documented values:
`available_for_you`, `installed`, `updates`). The implementation sends exactly
those parameters.

Measured behaviour:

- `GET /apps` returns **405** (`Method not Supported: GET method not supported
  for API`). The list call must be `POST` with an empty JSON body `{}`; the
  parameters travel in the query string. The body is required, and the request
  performs no mutation.
- An unrecognized `tab_context` returns **200** with `{"result": {}}` — no
  `apps` key. That is reported as `store_response_malformed` (an unavailable
  source), never as an empty catalogue.
- `GET /app/{appID}` returns `{"result": {"app_info_on_instance": {…}}}`.
- `GET /api/sn_cicd/progress/{trackerID}` returns `status`, `status_label`,
  `status_message`, `percent_complete` and `error`. **Not** the App Client's own
  `/appmanager/progress/{trackerID}`, which returns a different shape
  (`name`, `state`, `message`, `percent_complete`, `results`).
- The `installed` tab reports only applications the instance has installed;
  `version` is populated there and `null` on `available_for_you`. Sampled
  scopes matched their `sys_store_app` rows exactly.

### Roles

The service enforces one ACL, `App Manager Security Rules` (type
`REST_Endpoint`, operation `execute`), whose script grants access to:

```
admin || sn_appclient.app_client_user || unified_plugin_read_only
      || sn_appclient.app_client_company_installer
```

The same gate covers list, detail, install and update — there is no separate
read/write ACL. What still varies per application is entitlement: an application
the account may not install reports `can_install_or_upgrade=false`, or reports
`block_install=true` with an `indicators` entry. `admin` and
`sn_appclient.app_client_user` are the roles that matter in practice;
`unified_plugin_read_only` sees the catalogue but is not meant to install.

## Read-only inspection

`list` and `search` return one row per application with `sys_id`, `name`,
`scope`, `vendor`, `source`, installed `version`, `latest_version`, `installed`,
`update_available`, `installable`, `is_store_app`, `is_plugin`, `price_type`,
`needs_app_engine_licensing`, `blocked`, `indicators` and `short_description`.

The list payload is **not** the detail payload. It carries no `isInstalled`,
`can_install_or_upgrade`, `is_store_app`, `isAppstorePlugin`, `price_type` or
`needs_app_engine_licensing`; those fields are reported as `null` rather than
guessed. What it does carry:

- `version` — set only for installed applications (the installed marker);
- `update_available` — `"1"` when an update exists;
- `indicators` — a JSON-encoded string of platform reasons, for example
  `not_available_for_instance_type` / "Unavailable for Instance" on a developer
  instance. `jsn store` parses it into `indicators[]` and reports `blocked`.

`show` reports, where the platform exposes them:

- the installed version, active flag and install/update dates;
- the latest version, version list and `compatibilities`;
- entitlement/licensing flags (`can_install_or_upgrade`,
  `can_install_or_upgrade_customization`, `needs_app_engine_licensing`,
  `price_type`, `subscription_applicable`);
- `indicators` and `blocked`, the platform's own reason an application is not
  available here;
- `dependencies`;
- `detail_unavailable` (`forbidden`/`not_found`) if the App Client detail read
  fails, so missing detail is never rendered as empty data;
- notes, including that the platform does not say whether a refusal is caused by
  entitlement, licensing or compatibility, and that jsn never infers purchase
  authorization or accepts commercial terms.

### The version list

`versions` is an array of objects, not strings. Each entry carries `version`,
`version_display`, `sortable_version`, `publish_date`, `sys_id`, `dependencies`,
`compatibilities`, `price_type`, and its own `block_install` / `indicators`. jsn
reads `version` from each entry, so an unoffered version is refused against the
real catalogue:

```
Error: Skill Kit - Prompt Optimizer for Creator Tools does not offer version 9.9.9.
```

## Lifecycle operations

Before anything is sent, `install`/`update` resolve the exact application and
version and refuse:

- an unknown application (`not_found`) or an ambiguous name (`ambiguous`);
- a missing `--version` (installs always need an explicit version; updates
  default to the reported `latest_version`);
- a version the Store did not offer (`store_version_unavailable`);
- an application blocked on this instance (`store_app_not_installable`) —
  `block_install=true` or an `indicators` entry of type `error`. Note that
  `can_install_or_upgrade` can stay `true` for a blocked application, so the
  block flags are checked first;
- an application the client reports as not installable
  (`store_app_not_installable` when `can_install_or_upgrade=false`);
- `install` of an already-installed application (`store_already_installed`);
- `update` of an application that is not installed (`store_not_installed`) or to
  its current version (`store_version_unchanged`).

`--dry-run` performs all of those reads, reports the intended operation and
sends nothing. Every refusal above happens before `dispatchOperation`, so no
request reaches `/app/install` or `/app/update`.

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

## Lifecycle attempts, and what they proved

Twenty install/update requests were sent to this instance across nineteen
applications (ten updates of installed apps, nine installs). **Every one was
accepted and every one failed the same way.**

```
GET /appmanager/app/install?app_id=01ebede3c3212010a3a6ddaa7d40dd94
    &version=30.1.2&load_demo_data=false
-> tracker 4b54416e9314935016c8fd18dd03d642

status=3  status_label=Failed  percent_complete=100  error=""
status_message=Unable to download app package
status_detail=operation=app_install, app=01ebede3c3212010a3a6ddaa7d40dd94,
               version=, baseVersion=30.1.2, loadDemoData=false,
               isReinstallRequested=false
```

What that proves: the endpoint, method and parameters are right — the request
reaches the install plan for the exact application and version asked for, and
the tracker is created. What it does not prove: that an operation can complete.

What was actually sent is recorded by the instance itself, in
`sn_appclient_progress_tracker.payload`:

```
install  {"load_demo_data":"false","app_id":"01ebede3c3212010a3a6ddaa7d40dd94","version":"30.1.2"}
update   {"app_id":"3cc85c0107303010c7d559bf1ad30022","version":"9.1.5"}
update   {"app_id":"13f82d59fad128f947b961972d2ccd14","version":"2.1.0"}
```

The `version=` blank in `status_detail` is the *customization* slot; the
requested version lands in `baseVersion`. The app id and version are correct in
every attempt.

The cause is the instance, not the request. `syslog` shows its own outbound
store downloads failing on credentials, before and during these attempts:

```
UADownloader-ua_blocking:  Download request failed due to possible credential
                           error, status code = 403
UADownloader-ua_app_fam:   Download request failed due to possible credential
                           error, status code = 403
sn_entitlement:            Failed with status code (403) ... /api/now/v2/ualice
```

The tracker's execution record names the operation and its verdict:
`sys_execution_tracker` for the install above reads `state=3`,
`name=Install from the App Repository`, `message=Unable to download app
package`, `percent_complete=100`.

The line between "works" and "does not" is exactly here. `POST /appmanager/apps`
and `GET /appmanager/app/{appID}` answer from the instance's own store table.
Every call that has to reach the actual Store fails with the same 403, including
the read-only metadata one:

```
GET /appmanager/app_info_from_store/{appID}/{version}
403  AppManagerIntegrationAPI.makeAPIRequest(): Error occurred while processing
     request - {"apiName":"instance_api","params":{"sub_type":
     "get_app_details_from_store",...},"method":"Get"}: instance_api
```

That is the instance's own store-integration credential (`instance_api`), the
same one behind the `UADownloader` 403s in `syslog`. It is why an install cannot
complete here, and why the app list still looks healthy.

ServiceNow's own documentation (`application-development/queued-app-operations`)
describes exactly this path: a queued operation that "is unable to download an
application package" logs an error, is retried up to
`com.glide.update_operation.max_failure_count` times (default 3), and then "the
tracker fails, and the job is removed from the queue". The failure text is the
queue's, not jsn's.

Two things this changed:

- `status_detail` is now part of `store status` output; it is the only place a
  failed submission says what it tried to do.
- A failed tracker now reports `status_message`, not just the generic
  `status_label`: the command used to say `failed: Failed.` and hide
  `Unable to download app package`.

Side effects to clean up by hand: each failed install leaves an inert
`sys_store_app` row for its scope with an empty `version` and `active: false`
(nine of them here). Failed updates change nothing — every attempted app is
still on its original version.

## What is still unverified

1. A **successful** install or update. Twenty requests were dispatched across
   nineteen applications and all of them failed at package download with the
   instance's own 403 credential errors. The request shape is proven; the
   dispatch-to-completion path has never completed here.
2. That a successful tracker plus a matching `sys_store_app.version` readback is
   sufficient proof of installation on supported ServiceNow versions.
3. Repair/reinstall behaviour, which is deliberately not implemented here. There
   is also no uninstall: an application installed by `jsn store` must be removed
   through Application Manager.
