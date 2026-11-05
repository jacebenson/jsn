# Watching a ServiceNow record

`jsn records watch` streams changes to one record through ServiceNow's
Asynchronous Message Bus (AMB) record watcher, instead of polling the table
with repeated reads.

```bash
jsn records watch --table incident --sys-id 0123456789abcdef0123456789abcdef --timeout 300 --json
jsn records watch --table incident --identifier INC0010001 --identifier-field number --max-events 1 --json
```

Use it when a person asks an agent to *track* an incident, change, task or
other record: "tell me when this changes", "watch this", "let me know when it
is assigned". You do not need to know the transport name — record watching is
the right tool for "keep an eye on this record".

## What it emits

One compact JSON object per line (newline-delimited JSON) when the output is
JSON — which `--json` requests and a pipe selects automatically:

```json
{"type":"connecting","table":"incident","sys_id":"70d5…","channel":"/rw/default/incident/…"}
{"type":"subscribed","channel":"/rw/default/incident/…","session_status":"session.logged.in"}
{"type":"record_change","channel":"/rw/default/incident/…","table":"incident","sys_id":"70d5…","operation":"updated","received_at":"2026-11-04T18:00:45.348Z","action":"update","display_value":"INC0010004","event_id":"b836…","record":{"short_description":{"display_value":"probe second update","value":"probe second update"},"sys_updated_by":{"display_value":"admin","value":"admin"},"sys_mod_count":{"display_value":"2","value":"2"},"sys_updated_on":{"display_value":"2026-11-04 10:00:45","value":"2026-11-04 18:00:45"}}}
{"type":"watch_summary","table":"incident","sys_id":"70d5…","channel":"/rw/default/incident/…","reason":"max_events","events":1,"gaps":0,"reconnects":0,"complete":true,"started_at":"…","ended_at":"…","duration_ms":9000,"last_event_at":"2026-11-04T18:00:45.348Z"}
```

In a terminal (or with `--format styled`) each event becomes one line naming
the changed fields, for example
`2026-11-04T18:00:45.348Z incident INC0010004 updated — short_description: probe second update`.

`type` values:

| type | meaning |
|------|---------|
| `connecting` / `subscribed` / `unsubscribed` | connection status |
| `record_change` | a change notification for the watched record |
| `gap` | the connection dropped; observation was interrupted |
| `reconnected` | re-subscribed after a gap (`may_have_missed_events: true`) |
| `watch_summary` | final line: reason, counts, duration, `complete` |

`operation` is `created`, `updated`, `deleted`, `changed` or `unknown`.
The `action` field keeps the platform's raw word (`update`, `insert`, …).

`record` is the platform's record-watcher payload: a map of field name to
`{value, display_value}` for the fields that changed, plus `sys_*` audit
fields (`sys_updated_on`, `sys_mod_count`, `sys_updated_by`, …). A live
instance does **not** send a `changes` array, and it does not put `table` or
`sys_id` in the notification; `jsn` fills those from the subscription, which
is why a single-record watch is always scoped by `sys_id=<id>`. `changes` is
normalized if an instance ever sends it, but the current platform shape is
`record`.

The notification carries current values only. There is no previous value in
it, so output never invents a before → after transition.

`state.record` (with `--state always`) is the Table API's
`display_value=all` shape — again a map of field name to
`{value, display_value}` — not a flat record. With the default `--state
auto`, a record-watcher notification already carries `record`, so no
follow-up read happens. The notification and the state read are always
distinct: `record` is what the event said, `state.record` is a later read
with `source: "fetched"`. A failed read sets `state: null` and
`state_error`; it never rewrites the event.

## Bounds and cancellation

- `--timeout <seconds>` stops after a bounded window (default `0`, until
  interrupted). The exit status is `0`; the summary's `reason` is `timeout`.
- `--max-events <n>` stops after `n` change events (`reason: "max_events"`).
- Ctrl+C (SIGINT/SIGTERM) unsubscribes, disconnects and prints the summary
  with `reason: "cancelled"`.

Agents should schedule observation as repeated bounded runs (for example a
60–300 second window per check) rather than holding a connection forever.
Scheduling and telling the user belong to the calling agent, not to `jsn`.

## Reconnects and gaps

Record watchers are **best effort delivery, not a durable stream**. If the
connection drops, `jsn` re-subscribes with backoff and reports one `gap`
event, then a `reconnected` event; `watch_summary` reports `complete: false`.
Events sent while disconnected are not replayed, so do not treat the stream
as a complete history. Use a table query for the current state after a gap.
`--no-reconnect` turns a drop into a hard failure instead of a gap.

## Authentication and access

AMB authorizes like a browser session: it needs the session cookies and
`X-UserToken` of a logged-in UI session, not a bearer or Basic header alone.
`jsn` supplies that from a browser-session (`gck`) profile, or by warming a
UI session for a basic/OAuth profile.

- Recommended: `jsn auth login --browser`, then `--profile <name>`.
- A bearer-token-only identity, an SSO instance that refuses the session
  login flow, or an instance with no `/amb` endpoint fails with an actionable
  error and recovery hint rather than retrying.
- The subscription respects the authenticated user's ACLs: an inaccessible or
  missing record fails with `not_found` before any subscription is opened.
- Watching is read-only and works on read-only profiles. It declares no
  mutation capability and requires no update set.
- If the session expires mid-watch, the run ends with `auth_error` and
  reauthentication guidance instead of retrying a dead cookie. Events during
  that window were not observed; start a new watch after reauthenticating.

## Supported versions and restrictions

- Record watchers exist on current ServiceNow releases; AMB is a platform
  service that administrators may restrict. If `/amb` is disabled or proxied
  away, the command reports `AMB endpoint not found (HTTP 404)`.
- One record per invocation in this release. Filtered table subscriptions are
  not exposed yet — the channel query is `sys_id=<id>` — until table-level
  access behavior is validated on a live instance.
## Verification status

Live-verified on `dev366743.service-now.com` on 2026-11-04 with an admin OAuth
profile, watching one incident:

- `/amb/handshake` returned `200` with a `clientId` and
  `glide.session.status: session.logged.in`; the cookies and `X-UserToken`
  from the warmed OAuth session were accepted.
- `/meta/subscribe` acknowledged the `/rw/default/incident/<base64>` channel
  with `successful: true`.
- A save made in a separate UI session was delivered as a `record_change`
  within milliseconds, with the `record` map described above.
- `--state always` fetched the record after the event; `--state auto` did not
  (the notification already had detail).
- SIGINT during a watch unsubscribed, disconnected, and printed
  `watch_summary` with `reason: "cancelled"` and exit status 0.

Still unverified: ACL/role denial (the only available profile is an admin,
and admins bypass record ACLs), create and delete notification payloads,
reconnect/gap behavior against a real dropped connection, and filtered
table-level subscriptions. Unit and mock coverage lives in
`cli/test/amb.test.js`, `cli/test/record-watch.test.js` and
`cli/test/records-watch.test.js`; the opt-in live harness is
`cli/test/amb-live.test.js`.
