---
title: Output and record context
---

Choose a human or machine format, then understand record metadata and related-list counts that accompany output.

## JSN output and automation

## Human output first, structured output when needed

Most commands are designed to be useful at a terminal. Add JSON output when another tool needs stable structured data.

```bash
jsn records list --table incident --limit 10
jsn records list --table incident --limit 10 --json
```

Keep the command and profile visible in scripts. That makes automation easier to review and reduces accidental cross-instance changes.

[Browse the full feature catalog](/features/).

## Dynamic record metadata

Implements #317 after the #313 compatibility audit. Generic `records get`
presentation and request count are unchanged. `forms show <table> --view <name>`
now uses the reusable reader and output controller, including JSON and `--get`.

### Reader contract

`createRecordMetadataReader(sdk, {limit:1000, maxDepth:32})` returns
`{read({table,view:'Default view'}), clear()}`. A reader belongs to one SDK/session
and one invocation. It caches in-flight reads and reports, returns cloned report
objects, and never persists metadata between users/instances. Consumers should
reuse one reader while enriching multiple records and discard it after changing
identity or session. `clear()` permits explicit invalidation.

The report contains:

- `hierarchy`: the requested table followed by visible ancestors from
  `sys_db_object.super_class`, with cycle/depth checks.
- `form`: the nearest shared layout for the requested view, its inherited table,
  ordered linked sections and ordered elements, or null. Forms and related-list
  containers resolve independently. Custom views do not silently select Default
  view. Exact id/name and canonical Default view matches precede title/alias
  matches; ambiguity at the same precedence is not guessed. Personalized records are
  excluded; this is shared metadata, not a simulation of the user's runtime UI.
- `related_lists`: configured entries plus discoverable dictionary reference and
  basic relationship candidates. Each descriptor carries `configured`, `kind`,
  `table`, `reference_field` and `query_status`. Configured entries additionally
  carry source table, position, filter and ordering. `filter_available` distinguishes
  a visible empty filter from an ACL-omitted filter; unknown filters remain a
  coverage gap and must not be counted as an unfiltered collection. Inherited reference targets
  are included. Configured advanced `REL:` IDs are read individually by id when
  not included in the basic relationship search.
- `coverage`: `observed` or `partial`, a scope limitation and source warnings.
  A successful empty read means no visible metadata, not proof that ACL-hidden
  data or dynamic relationships do not exist. Denied/malformed/truncated sources,
  unknown views, ambiguity, missing links and inheritance caps remain explicit.

Only `query_status:reference` describes an ordinary static reference query.
`platform_required` means a custom/advanced/scripted relationship needs platform
query logic; this reader never executes, interprets or returns relationship
scripts. `unavailable` means the relation cannot be safely described from visible
metadata. Consumers must preserve these unknown states rather than infer zero
counts. Stored encoded filters are metadata, not authorization to execute an
arbitrary filter or script; consumers must validate filters before building
queries or runnable hints.

### Reads and batching

The reader follows `sys_ui_form` → `sys_ui_form_section` → `sys_ui_section` →
`sys_ui_element`, rather than issuing one element request per section. Bulk id
queries contain at most 100 ids. Independent phases use `sdk.batch` when present,
using the #316 GET-only contract and result IDs; older SDKs use parallel list
reads. The batch provider owns unsupported-endpoint fallback. Metadata code never
replays item failures or outer authentication/ACL/server errors. Fatal auth
failures propagate to the existing CLI error handling.

Bounds are explicit (metadata row cap, inheritance depth cap, bulk id chunk).
Reaching a row cap reports partial coverage instead of claiming completeness.
No related record collections or counts are fetched during discovery. Default
readable source limits may hide additional metadata; adjust a dedicated reader's
limit only when an operation needs broader discovery.

The current implementation discovers shared table/view layouts and configured
or dictionary/static related lists. It does not evaluate advanced apply-to or
query-from scripts, personalize forms, or emulate every domain/role/UI runtime
rule. These limits are visible in every report.

### Source verification

Property names were checked against the official `@servicenow/sdk-core` 4.14.0
published schemas, including `sys_ui_form_section.sys_ui_form`,
`sys_ui_form_section.sys_ui_section`, `sys_ui_related_list_entry.list_id` and
`related_list`. The schema package is reference material, not a runtime dependency.

Official references:

- [Form record hierarchy](https://servicenow.github.io/sdk/guides/form-layout-guide)
- [Relationship and related-list storage](https://servicenow.github.io/sdk/4.12.0/guides/relationship-guide)

### Verification

`test/record-metadata.test.js` covers inherited/custom views, references and
scripted/custom descriptors, exact call counts, bulk/chunked element reads,
cache isolation/invalidation, batched vs individual results, ACL/malformed/capped
sources, hidden ids, ambiguity, injection, auth, cycles and depth limits.
`test/forms-metadata-cli.test.js` drives the real CLI against local HTTP with an
explicit nondefault read-only profile, JSON, extraction and human output, and
proves generic get still performs a single table read without metadata requests.
No ServiceNow instance calls are required.

Connected-PDI terminal counts and scope limits: `docs/verification/317-metadata.md`.

## Related-list counts and lazy navigation

Specialized record `show` commands can opt into supplementary related-list
counts with `--related`; `--view <name>` selects metadata for a custom view.
Ordinary specialized shows and generic `records get` retain their existing
presentation and request pattern. The specialized-command integration calls
`enrichRelatedLists`; the metadata/count modules themselves do not change generic
record reads.

The hook adds `_related` to the record. It contains every considered list with
its observed count or explicit unavailable state, a `nonempty` list with actionable
`records list` commands, and coverage warnings. Nonempty hints carry the resolved
parent ID, the relationship filter, and the selected profile/instance so opening
them cannot silently switch connections. Related records are fetched only when
the user follows a suggested command. Zero-count lists have no navigation hint.

Counts use the official
[Aggregate API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AggregateAPI.html)
with `sysparm_count=true` and an exact parent reference query. Independent counts
use optional SDK batch reads when available; that transport owns unsupported-endpoint
fallback. Denied, unserviced, missing, failed, or malformed responses remain
`count: null` with `status: unavailable`, not zero. No count fallback fetches full
record lists. Returned numeric zero is an actual observed aggregate result.

Coverage is scoped to `aggregate_api_access`, not a promise that the count includes
all records or matches every Table API visibility rule. Table/record permissions
can prevent aggregate access. Metadata ACL gaps and count errors are preserved as
partial coverage; a list absent from metadata is not evidence that no relationship
exists.

Safe ordinary reference relationships, including inherited references, can be
counted. A configured filter hidden by metadata access makes that list unavailable;
an explicitly empty visible filter remains valid. Only a conservative AND-only literal subset of configured filters is
combined with the resolved parent reference. OR/NQ branches, JavaScript/dynamic
logic, unknown operators and malformed filters are unavailable rather than risk
widening the query. Custom/advanced relationships requiring platform scripts are
never executed. Ignoring an unsafe filter would give an incorrect count, so those
lists receive no aggregate request or navigation command.

`createRelatedListReader(sdk, { metadataReader, maxLists: 50 })` exposes `read` and
`clear`. Aggregate URLs are deduplicated and cached within this SDK-bound reader;
repeated views may share counts, while changed records use distinct queries.
Connection changes replace the app's reader. The default 50-descriptor limit
bounds work, and skipped descriptors stay explicit unavailable entries with safe
list-specific navigation commands. `--related-limit` explicitly raises/lowers this
limit (1–1000). Individual aggregate reads run with at most four concurrent calls;
batch chunking remains bounded by the SDK. Metadata
is cached by the metadata reader; no cache is persisted across invocations.

This module depends on dynamic metadata (#317). Specialized factory, ticket, request and standalone tickets shows expose these
options. Generic get is intentionally outside this feature. `_related` is supplementary data; essential children use their
separate `_essential` contract.
