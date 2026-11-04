# ServiceNow Store applications

`jsn store` inspects the ServiceNow Store applications available to the
authenticated instance. It is **read-only**: discovery and inspection only.

> **Verification status.** Every command below is verified against a live
> instance (`dev366743`, 2026-11-04): 747 `sys_store_app` rows, 260 rows in the
> App Client's `installed` tab, and each response shape captured from the wire.

## Commands

```sh
jsn store list [--tab available|installed|updates] [--limit 20] [--offset 0]
jsn store search "<term>" [--tab …] [--limit …] [--offset …]
jsn store show <application>
jsn store status <tracker-id>
```

`<application>` is a 32-character store application sys_id, an application scope
(`x_acme_app`), or an exact application name. Names and scopes resolve through
`sys_store_app`, then through the Store search endpoint; a name shared by
several applications fails as `ambiguous` instead of picking one. A company
application-repository application (`sys_app`) is refused with
`store_not_store_app` — `jsn store` handles ServiceNow Store applications only.

## The App Client API, as measured

Everything under `/api/sn_appclient/appmanager` is the App Client's scripted
REST service (`AppManager(Internal API)`, service id `appmanager`). This
repository uses the read-only half:

| Operation | Method and path | Used for |
| --- | --- | --- |
| GetApps | `POST /apps` | `list`, `search` |
| GetAppById | `GET /app/{appID}` | `show` |
| Execution Status | `GET /api/sn_cicd/progress/{trackerID}` | `status` |

ServiceNow's published OpenAPI for this service
(`sn_appclient-AppManager_Internal_API`) lists the same operations, with
`tab_context` required on `POST /apps` (documented values: `available_for_you`,
`installed`, `updates`).

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
  `status_message`, `status_detail`, `percent_complete` and `error`. **Not** the
  App Client's own `/appmanager/progress/{trackerID}`, which returns a different
  shape (`name`, `state`, `message`, `percent_complete`, `results`).
- The `installed` tab reports only applications the instance has installed;
  `version` is populated there and `null` on `available_for_you`. Sampled scopes
  matched their `sys_store_app` rows exactly.

### Roles

The service enforces one ACL, `App Manager Security Rules` (type
`REST_Endpoint`, operation `execute`), whose script grants access to:

```
admin || sn_appclient.app_client_user || unified_plugin_read_only
      || sn_appclient.app_client_company_installer
```

The same gate covers every operation on the service. `admin` and
`sn_appclient.app_client_user` are the roles that matter in practice;
`unified_plugin_read_only` sees the catalogue without change rights.

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
- `detail_unavailable` (`forbidden`/`not_found`) if the detail read fails, so
  missing detail is never rendered as empty data;
- notes, including that the platform does not say whether a refusal is caused by
  entitlement, licensing or compatibility, and that jsn never infers purchase
  authorization or accepts commercial terms.

`status` reads the CI/CD tracker directly: `status`, `status_label`,
`status_message`, `status_detail`, `percent_complete`, `terminal`, `succeeded`.
`status_detail` names the operation the tracker ran and the app/version it acted
on, and `status_message` carries the platform's reason when it failed.

### The version list

`versions` is an array of objects, not strings. Each entry carries `version`,
`version_display`, `sortable_version`, `publish_date`, `sys_id`, `dependencies`,
`compatibilities`, `price_type`, and its own `block_install` / `indicators`.

## Why install and update are not here

They were built, tested, and dispatched. They are deliberately absent.

Twenty requests across nineteen applications were sent to the only instance
available. Every one was accepted — the instance recorded the exact payload:

```
install  {"load_demo_data":"false","app_id":"01ebede3c3212010a3a6ddaa7d40dd94","version":"30.1.2"}
update   {"app_id":"3cc85c0107303010c7d559bf1ad30022","version":"9.1.5"}
```

Every one then failed at the same step:

```
sys_execution_tracker: state=3, name=Install from the App Repository,
                       message=Unable to download app package
```

The instance cannot download packages. Its own store-integration credential
fails, and `syslog` shows the same 403 on every outbound download — including
the read-only metadata call, which is the clean boundary:

```
POST /appmanager/apps                    200   (answered from sys_store_app)
GET  /appmanager/app/{appID}             200   (answered from sys_store_app)
GET  /appmanager/app_info_from_store/…   403   AppManagerIntegrationAPI: instance_api
```

So the request shape is proven three ways — the live operation registry, the
published OpenAPI, and the instance's own stored payload — but **completion
never was**. A mutation that has never completed end-to-end does not ship,
however correct its parameters look.

The reference implementation named in issue #400
(`sonisoft-cnanda/now-sdk-ext-core`) uses the same endpoints and the same
`app_id`/`version` parameters, so there is no alternative route to copy. What
would have to happen before adding `install`/`update` back:

1. an instance whose App Repository downloads succeed;
2. one install and one update observed through
   `submitted → tracker → sys_store_app` version readback;
3. confirmation that tracker success plus that readback is sufficient proof, and
   what a partial or failed install leaves behind.

The prototype is in this PR's history if someone picks it up with a working
instance.
