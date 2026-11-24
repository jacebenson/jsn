---
title: Records and record engines
---

Watch records, understand the record-engine contract and batch SDK reads without changing unrelated behavior.

## Watching a ServiceNow record

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

Live-verified on `example.service-now.com` on 2026-11-04 with an admin OAuth
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

## Version history

`jsn records versions` lists the saved versions of one record and compares an
older one to the current version. It is the CLI form of the Versions related
list, Compare to Current and Show Latest Update, and it only reads.

```bash
jsn records versions sys_script_include <sys_id> --limit 10
jsn records versions sys_script_include MyUtil --identifier-field name --diff 2 --json
```

- The record is resolved like `records get`, then versions are read from
  `sys_update_version` by the record's `sys_update_name`, which is not always
  `<table>_<sys_id>` (dictionary entries and list layouts are keyed by name).
  A record with no readable `sys_update_name` falls back to
  `<sys_class_name>_<sys_id>` and says so.
- Versions are numbered newest first, by `sys_recorded_at`, with one-row
  lookahead for `pagination.has_more`. Each shows state, action, when, who and
  the source (update set, upgrade or Store app). Payloads are not read for the
  list.
- `latest_update` is the newest `sys_update_xml` with the same name that is in
  an update set (a retrieved update not yet committed is left out), with its
  update set as a raw sys_id and label. A version's `source` is the set at the
  time; the two differ after an update is moved.
- `--diff N` reads two payloads, version N and the version in state current,
  and compares them in the CLI. Every element with an `action` attribute is a
  record, keyed by table and sys_id, so composite payloads (a list layout's
  columns) compare column by column. Fields compare on raw values; display
  labels are shown, never compared. `sys_created_*`, `sys_updated_*` and
  `sys_mod_count` are ignored, as `jsn diff record` does. Multi-line fields get
  a line diff, which reports counts only past about four million line pairs.
- No versions is never reported as "unchanged": only records tracked by update
  sets have versions, tables in `glide.update.suppress_update_version` keep
  none, and ACLs can hide rows from a user without admin. Only the newest 200
  versions can be listed or compared. A denied read, a second current version, a missing or unreadable
  payload, or a row for another record name fails.

It does not read the live record, compare across instances, or show a record
that has been deleted (the record must resolve first).

## Records engine compatibility contract

Audit for #313, prerequisite to #314–#321. Baseline: origin/main at a3b0e6f.
This contract precedes implementation and does not declare those issues complete.

### Current implementations

| Entry point | Implementation and transport | Compatibility requirements |
| --- | --- | --- |
| `records list/get/create/update/delete/delete-many` | `src/commands/records.js`; SDK list, create, update, delete, aggregateCount, attachment methods | Arbitrary/custom tables; required table; columns/c/fields aliases; list query, limit=20, offset=0, counts with profile override; get attachments; JSON/file/stdin/repeated-field payloads; derived-field warnings and strict write-back verification. `delete-many` previews by default and requires an exact `--expect-count` before any per-record delete; it never claims atomicity |
| incidents/inc, changes/chg, requests/req, tasks/task | `src/commands/_ticket.js` via four modules; requests adds catalog helpers | Preserve tables incident/change_request/sc_req_item/sc_task, number identifiers, aliases, list sorting/pagination, create description/priority shortcuts, breadcrumbs and required short_description |
| `tickets/ticket` | `src/commands/tickets.js`; separate CRUD on task | Preserve distinct task table, list shape and show summary; migrate alongside ticket factory without changing aliases |
| Simple specialized commands | `src/commands/_simple.js` delegates to `_generic.js`; other modules also use factory | Preserve every name/alias/default column/readOnly flag, optional resolver, showFields, onShow, summaries, breadcrumbs, extraQuery and scopeValidation hooks |
| Specialized rich commands | flows/actions/catalog/CMDB/users and others have custom implementations | Do not replace specialized operations wholesale; shared resolver changes require existing regression suite |
| Form views | `src/commands/forms.js` independently reads views, sections, elements | No automatic form/related-list retrieval in current generic get or ticket show. Preserve generic presentation; form-aware presentation belongs to specialized views |

### Observable data and calls

Generic get currently uses display=true; specialized show uses display=all.
List commands request all but usually project display strings with
formatRecordForDisplay. records/ticket lists expose table/count/columns/records,
pagination and instance context; factory lists omit pagination today. Selected
records carry _context. Preserve defaults and existing envelope/get extraction;
add explicit raw/display/both options rather than silently changing defaults.
Do not stringify raw reference objects when both is requested.

Current shared resolver selects 32-hex ids by sys_id and other values by the
human field, requests one row and returns it without ambiguity checking. Generic
get independently queries sys_id. Generic update/delete send supplied ids
straight to SDK. The new resolver must replace these unsafe differences.

Interactive generic lists, ticket lists and factory lists use distinct picker
rules and cancellation/empty behavior. Preserve those rules in this migration;
reuse in-process transport/parameter functions underneath the existing UI.
Keep ordinary get to one table read where resolution can return the record.
Mutation id resolution may add bounded reads before a write; never substitute
subprocess invocations. List counts remain best effort and honor opt-outs.

### Identifier contract for the new engine

1. Explicit identifier field wins. `--sys-id` means sys_id even for legacy or
   nonhex values. `--identifier` with `--identifier-field` selects any safe field.
2. Specialized commands preserve their configured human-field precedence for
   non-32-hex identifiers; exact sys_id is attempted if no human match. Full
   32-hex values retain sys_id precedence. Explicit field selection resolves a
   collision in either direction.
3. Every lookup requests at most two records. Exact zero matches may fall back
   to sys_id prefix then suffix; partial matching applies only to ids, never
   human fields. Zero and multiple results fail, including duplicate exact ids.
4. Never select the first ambiguous result or proceed to write. Errors identify
   table, lookup mode, field, match count/lower bound and actionable next steps.
5. Validate identifiers and field/table names before encoded queries. Preserve
   the safe-exact-match boundary and always unwrap raw ids before mutations.

### Safety and extension boundaries

Middleware capability registry remains the source for read-only/instance and
mutation safeguards. SDK authentication/recovery stays in-process. Keep delete
confirmation, scope guards and write-back checks in their current order. New
engine functions accept hooks for table-specific policy; they cannot bypass
handlers or the registry. Coordinate any Global + Default work with #310.

Declarative profiles should own actual table/aliases/defaults, not a second
help-only registry. Function hooks remain code. Discovery must derive from
those same definitions. Related/essential data is additive JSON, never stdout
console prose (UI policy actions currently print console prose and must migrate).
Batch transport is optional, validates read-only same-instance subrequests,
maps responses/errors by id and falls back only when batch is unsupported.
Dynamic metadata and counts must report ACL/coverage uncertainty, inherit safely,
cache within an invocation, and avoid eager supplementary record retrieval.

### Verification and migration gates

Existing contracts: test/records.test.js, test/tickets.test.js,
test/resolve-record.test.js, test/users.test.js, test/inspect.test.js,
test/field-pairs.test.js, test/usability-output-contract.test.js,
test/usability-safety-group-mutations.test.js, test/capabilities.test.js,
test/mutations.test.js and test/records-rest-help.test.js. Existing resolver tests
assert limit=1 and must deliberately change to 2 with ambiguity regression proof.
Most are structure/stub tests, so add real CLI/local HTTP fixtures for generic,
ticket and factory operations, custom/legacy ids, references, output modes,
ambiguity/no matches, selected profiles, mutation blocking and exact HTTP counts.
No live instance writes. Run lint/full suite and verify skill local docs fixture;
inspect evidence and cleanup. Batch, inherited metadata, related counts and
essential data each need independent behavior/fallback/error/call-count tests.

The user has explicitly approved keeping the existing generic get presentation.
Form-aware presentation belongs to specialized views. New metadata APIs and
explicit opt-in operations must preserve that boundary.

## Optional SDK batch reads

`SDKClient.batch(requests, options)` is an explicit transport for independent,
read-only calls to the selected instance. Ordinary SDK/record commands stay
unbatched. This follows the compatibility audit's initial read-only batch scope;
writes continue through normal SDK methods and their safety/history contracts.

```js
const output = await sdk.batch([
  { id: 'incident', url: '/api/now/table/incident?sysparm_limit=1' },
  { id: 'task', method: 'GET', url: '/api/now/table/task?sysparm_limit=1' },
], { fallback: true, chunkSize: 50 });
for (const item of output.results) {
  if (item.ok) consume(item.data); // normal API envelope, e.g. { result: [...] }
  else report(item.id, item.status, item.error);
}
```

Requests accept an optional unique `id` (otherwise their one-based index), a
same-instance `/api/` URL, optional `GET` method, and optional header object.
External origins, authentication-header overrides, nested batches, request bodies,
and write methods fail validation before any requests are sent. Auth and domain
selection come from the existing SDK. Credential last-seen metadata is not touched.

The implementation uses the official
[ServiceNow Batch API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/batch-api.html):
`POST /api/now/v1/batch` with `batch_request_id` and `rest_requests`. Response
`serviced_requests` carry base64 bodies; `unserviced_requests` contain IDs. Results
are correlated by ID and returned in input order, even if the server reorders them.
JSON item bodies become objects, other bodies stay text, and empty bodies are null.

The result includes `transport` (`batch`, `individual`, `mixed`, or `none`),
`counts` (`total`, `successful`, `failed`), and `results`. Each item contains `id`,
`ok`, HTTP `status`, `data`, `error`, and `serviced`. Explicit unserviced items have
`serviced: false`; absent responses have `serviced: null` because execution is
unknown. Both are errors, never empty success. Item HTTP failures and malformed
body errors retain their item correlation. Malformed aggregate envelopes,
unknown/duplicate response IDs, and wrong batch IDs fail the aggregate operation.

By default, only outer HTTP 404/405/501 triggers sequential individual GET fallback.
Unsupported endpoint state is cached for this SDK instance. `fallback: false`
requires native batch support. No fallback hides outer authentication, ACL,
rate-limit, server, timeout, or malformed-response failures. Item failures,
unserviced requests, and missing responses are never automatically retried.
Existing SDK auth recovery applies only to a definitive outer 401, not failed
items in an otherwise accepted batch. No writes can be replayed through this API.

`chunkSize` defaults to 50 and accepts 1–1000; chunks run sequentially. `timeout`
defaults to the SDK timeout and applies to each native batch or fallback read,
not the entire operation. Platform payload/processing limits can still leave
items unserviced; batching does not promise parallel transactions or atomicity.
Successful earlier chunks may have been read if a later aggregate request fails.

## Encoded-query validation

User-supplied encoded `--query` values on table-resolvable public commands,
including shared lists, counts, aggregates and filter-based mutations are parsed and checked against
on-demand, table-scoped metadata (`sys_db_object` ancestry plus one
`sys_dictionary` read). The query string is never rewritten, re-encoded,
substituted, retried or dropped: AND/OR/NQ clauses, escaped `^^` carets,
`ORDERBY`/`ORDERBYDESC` directives and dot-walks reach ServiceNow
byte-identically.

- Demonstrably invalid syntax or a dot-walk through a proven non-reference
  field is refused with a structured diagnostic and suggestions. Operator
  boundaries use visible field names. Missing fields remain unverified because
  dictionary ACLs can hide them.
- Denied, unavailable or incomplete metadata is reported as unverified
  (`query_validation.state` in JSON plus `warnings` in human output). Reads may
  continue with the original query. Hidden metadata is never reported as proof
  that a table or field is absent. An unresolved table may include up to three
  close accessible names from one `nameSTARTSWITH` lookup, restricted to the
  first three input characters and at most 20 rows. This is not a schema scan
  or an exhaustive match list. Failed candidate lookups are not cached, and
  suggestions are never substituted into queries.
- Dynamic/script syntax, ON/NOTON, RELATIVE, DYNAMIC, RLQUERY and unsupported
  directives are reported as `unsupported`, never invalid. SAMEAS/NSAMEAS,
  INSTANCEOF and BETWEEN also remain unverified because their operand semantics
  are not fully checked; reads retain their original syntax, filtered writes
  refuse them. Dot-walks beyond
  five field components are unverified, never partially accepted. Ancestry is
  capped at eight tables and dictionary reads at 1,000 rows. A missing or
  inconsistent total-count receipt, empty dictionary, hidden type/reference,
  malformed row or truncated response cannot prove a complete schema.
- Filter-based mutations (`delete-many`, `bulk`) validate the complete filter
  before any count, enumeration, scope read or write, and fail closed with zero
  writes on any non-valid state. There is no skip-validation flag.

Usable metadata is cached on disk for five minutes per exact instance URL,
selected profile and authenticated principal (owner-only files under the
existing cache directory). Different instances, profiles or principals never
share entries; an unverified identity uses in-process metadata only. Pass
the global `--refresh-metadata` flag to force a fresh read. The principal must
be independently read back from the authenticated provider; matching configured
usernames are not proof. Cache files are capped at 256 KiB each, 64 entries and
8 MiB in total, with the same memory limits. Windows uses memory-only metadata:
Node permission bits cannot verify private Windows cache ACLs, so the CLI never
reads or writes query-metadata cache files there. Successful table or field mutations
invalidate affected entries. The five-minute window is a latency tradeoff, not
authorization and not a guarantee that ACLs or schema stay stable inside it.
