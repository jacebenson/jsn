---
title: Records and record engines
---

Watch records, understand the record-engine contract and batch SDK reads without changing unrelated behavior.

## Watching a ServiceNow record

`jsn records watch` streams changes to one record, or to every record matching
an encoded query, through ServiceNow's Asynchronous Message Bus (AMB) record
watcher, instead of polling the table with repeated reads.

```bash
jsn records watch --table incident --sys-id 0123456789abcdef0123456789abcdef --timeout 300 --json
jsn records watch --table incident --identifier INC0010001 --identifier-field number --max-events 1 --json
jsn records watch --table incident --query "priority=1^active=true" --timeout 300 --json
```

Use it when a person asks an agent to *track* an incident, change, task or
other record: "tell me when this changes", "watch this", "let me know when it
is assigned". You do not need to know the transport name — record watching is
the right tool for "keep an eye on this record".

## Watching every record that matches a query

`--query` subscribes to the query itself, so one watch covers every record
that matches it now or comes to match it later. The query is validated like
`records list --query` before anything subscribes, because the platform
drops a condition it cannot parse and a misspelt field would silently widen
the watch. A query that is demonstrably invalid is refused. One `jsn` cannot
fully verify, such as a field it cannot see in the dictionary, still
subscribes, but first emits a `query_validation` event naming the field. `--query` cannot be combined with `--sys-id` or `--identifier`.

Each `record_change` carries `match`, the platform's word for how the change
relates to the query:

| change | `operation` | `match` |
|--------|-------------|---------|
| a matching record is inserted | `created` | `entry` |
| a matching record is updated and still matches | `updated` | `change` |
| an update makes a record match | `updated` | `entry` |
| an update makes a record stop matching | `updated` | `exit` |
| a matching record is deleted | `deleted` | `exit` |

Changes to records outside the query, before and after, send nothing. Human
output marks the two crossings: `updated (now matches)` and
`updated (no longer matches)`.

Two filters narrow the stream. AMB has no server-side filter for either, so
`jsn` applies them to each notification, before any state read and before the
event counts toward `--max-events`:

- `--operation insert|update|delete` keeps one kind of change. An update that
  leaves the query is an `update`.
- `--on-change state,assigned_to` keeps changes naming at least one of the
  fields. Inserts name every field they set; deletes name none, so
  `--on-change` drops them.

```bash
jsn records watch --table incident --query "priority=1^active=true" --operation update --on-change state,assigned_to --timeout 300 --json
```

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
`match` (`entry`, `change` or `exit`) is present when the platform sends it;
see the query table above.

`record` is the platform's record-watcher payload: a map of field name to
`{value, display_value}` for the fields that changed, plus `sys_*` audit
fields (`sys_updated_on`, `sys_mod_count`, `sys_updated_by`, …). The
instance checked on 2026-11-04 sent no `changes` array and put no `table` or
`sys_id` in the notification; `jsn` fills those from the subscription, which
is why a single-record watch is always scoped by `sys_id=<id>`. A PDI checked
on 2026-11-25 also sent `sys_id`, `match` (as `action`) and `changes` as a
list of field names, which `jsn` emits as `{"field": "priority"}` entries
with no values. A query watch has no `sys_id` to fill in, so on an instance
that sends the older shape each event carries a `warning` and only its
`display_value` says which record changed.

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

AMB authorizes like a browser session: it reads the session cookies of a
logged-in session and ignores a bearer or Basic header sent on its own.
`jsn` supplies that session from a browser-session (`gck`) profile, or by
opening a UI session for a basic or OAuth profile. A basic profile was
verified on 2026-11-25: the handshake reported `session.logged.in` and query
and single-record watches delivered events.

- A bearer-token-only identity, an SSO instance that refuses the session
  login flow, or an instance with no `/amb` endpoint fails with an actionable
  error and recovery hint rather than retrying.
- A single-record watch reads the record first: an inaccessible or missing
  record fails with `not_found` before any subscription is opened.
- A query watch has no record to read first, and the platform does not hold
  back notifications from a user who cannot read the record. On 2026-11-25 a
  user with no roles, who could not read the watched incidents through the
  Table API, received every change on the channel: `sys_id`, the display
  value (the incident number), `operation`, `match` and the changed field
  names, with the field values withheld. The same user received full values
  for an incident they could read as its caller, and the same trimmed events
  on a single-record channel. `jsn` emits such an event
  with `changes` and no `record`; a state read (`--state always`) returns
  `state.record: null` when ACLs hide the record.
- Watching is read-only and works on read-only profiles. It declares no
  mutation capability and requires no update set.
- If the session expires mid-watch, the run ends with `auth_error` and
  reauthentication guidance instead of retrying a dead cookie. Events during
  that window were not observed; start a new watch after reauthenticating.

## Supported versions and restrictions

- Record watchers exist on current ServiceNow releases; AMB is a platform
  service that administrators may restrict. If `/amb` is disabled or proxied
  away, the command reports `AMB endpoint not found (HTTP 404)`.
- One channel per invocation: one record (`sys_id=<id>`) or one encoded
  query. Query watches deliver entry, change and exit as described above.
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

Live-verified on a PDI on 2026-11-25 with a basic profile, watching the
query `short_descriptionSTARTSWITH<tag>^priority=1` while disposable
incidents were inserted, updated and deleted through the Table API:

- Inserting a matching incident sent `insert`/`entry` with every field set;
  inserting one outside the query sent nothing.
- An update that kept the incident in the query sent `update`/`change`; an
  update that raised another into it sent `update`/`entry`; an update that
  lowered the first out of it sent `update`/`exit`. Later updates to the
  incident outside the query sent nothing.
- Deleting a matching incident sent `delete`/`exit` with an empty `changes`
  list and no `record`; deleting one outside the query sent nothing.
- A second session impersonating a user with no roles received the same
  events, trimmed as described under Authentication and access.
- `--operation update --on-change priority` emitted exactly the entry and the
  exit, and the summary reported `complete: true`.
- A four-minute watch on the shared PDI saw one load-balancer `500` on a
  long-poll; the stream reported a `gap`, re-subscribed and finished with
  `complete: false`.

Still unverified: watches much longer than four minutes, where other AMB
clients rotate their session to stay ahead of an idle reaper. Unit and mock
coverage lives in
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
| `records list/get/create/update/delete/delete-many/export/import` | `src/commands/records.js`, `src/record-xml.js`; SDK list, create, update, delete, aggregateCount, attachment methods, `<table>.do?UNL`, `sys_upload.do` | Arbitrary/custom tables; required table; columns/c/fields aliases; list query, limit=20, offset=0, counts with profile override; get attachments; JSON/file/stdin/repeated-field payloads; derived-field warnings and strict write-back verification. `delete-many` previews by default and requires an exact `--expect-count` before any per-record delete; it never claims atomicity. `export` writes unload XML only for a fully validated query, after counting matches against `glide.xml.export.limit`, and fails when the XML holds more or fewer records than expected; it refuses `sys_update_xml` and `sys_remote_update_set`, which move whole with `updatesets export`. `import` previews by default; with `--yes` it uploads through `sys_upload.do`, which answers success whether or not anything loaded, so it re-reads every record the file names and exits nonzero unless each is present with the file's `sys_updated_on` and `sys_mod_count` (or absent, for `action="DELETE"`); it compares only those fields |
| `records list/get/create/update/delete/delete-many/export` | `src/commands/records.js`, `src/record-xml.js`; SDK list, create, update, delete, aggregateCount, attachment methods, `<table>.do?UNL` | Arbitrary/custom tables; required table; columns/c/fields aliases; list query, limit=20, offset=0, counts with profile override; get attachments; JSON/file/stdin/repeated-field payloads; derived-field warnings and strict write-back verification. `delete-many` previews by default and requires an exact `--expect-count` before any per-record delete; it never claims atomicity. `--preview-cascade` adds the platform's cascade preview: one never-executed Data Management delete job (`sys_dm_delete`) for the filter, read through the console's Preview Cascade data broker, up to three levels with estimated counts past the source table; the job is deleted after unless `--keep-job` (its `sys_dm_delete_count` rows stay, since their delete ACL refuses even an admin), and an empty or mismatched preview is an error | `export` writes unload XML only for a fully validated query, after counting matches against `glide.xml.export.limit`, and fails when the XML holds more or fewer records than expected; it refuses `sys_update_xml` and `sys_remote_update_set`, which move whole with `updatesets export` |
| incidents/inc, changes/chg, requests/req, tasks/task | `src/commands/_ticket.js` via four modules; requests adds catalog helpers | Preserve tables incident/change_request/sc_req_item/sc_task, number identifiers, aliases, list sorting/pagination, create description/priority shortcuts, breadcrumbs and required short_description |
| `tickets/ticket` | `src/commands/tickets.js`; separate CRUD on task | Preserve distinct task table, list shape and show summary; migrate alongside ticket factory without changing aliases |
| Simple specialized commands | `src/commands/_simple.js` delegates to `_generic.js`; other modules also use factory | Preserve every name/alias/default column/readOnly flag, optional resolver, showFields, onShow, summaries, breadcrumbs, extraQuery and scopeValidation hooks |
| Specialized rich commands | flows/actions/catalog/CMDB/users and others have custom implementations | Do not replace specialized operations wholesale; shared resolver changes require existing regression suite |
| Form views | `src/commands/forms.js` independently reads views, sections, elements | No automatic form/related-list retrieval in current generic get or ticket show. Preserve generic presentation; form-aware presentation belongs to specialized views |
| `records undelete` | `src/record-undelete.js`; SDK listStrict, executeScript (global) | Restores the newest `sys_audit_delete` copy of one record, found by table and original sys_id, through `GlideAuditDelete().undelete`, the Undelete Record action's own call, which has no REST API. Refuses with no script run when no copy is recorded, the copy does not match, the record exists, or a verified capture context's scope differs from the copy's; confirms like `delete`; the script checks admin, the copy and the absence again and prints a marker; the record is read back. Attachments and cascade-deleted records are not restored, and references other records held to it may stay cleared |

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
- `records export` holds its query to the same standard before counting or
  exporting, because the export processor drops a term on an unknown column and
  writes unfiltered rows.

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
