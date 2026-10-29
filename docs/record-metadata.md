# Dynamic record metadata

Implements #317 after the #313 compatibility audit. Generic `records get`
presentation and request count are unchanged. `forms show <table> --view <name>`
now uses the reusable reader and output controller, including JSON and `--get`.

## Reader contract

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
  carry source table, position, filter and ordering. Inherited reference targets
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

## Reads and batching

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

## Source verification

Property names were checked against the official `@servicenow/sdk-core` 4.14.0
published schemas, including `sys_ui_form_section.sys_ui_form`,
`sys_ui_form_section.sys_ui_section`, `sys_ui_related_list_entry.list_id` and
`related_list`. The schema package is reference material, not a runtime dependency.

Official references:

- [Form record hierarchy](https://servicenow.github.io/sdk/guides/form-layout-guide)
- [Relationship and related-list storage](https://servicenow.github.io/sdk/4.12.0/guides/relationship-guide)

## Verification

`test/record-metadata.test.js` covers inherited/custom views, references and
scripted/custom descriptors, exact call counts, bulk/chunked element reads,
cache isolation/invalidation, batched vs individual results, ACL/malformed/capped
sources, hidden ids, ambiguity, injection, auth, cycles and depth limits.
`test/forms-metadata-cli.test.js` drives the real CLI against local HTTP with an
explicit nondefault read-only profile, JSON, extraction and human output, and
proves generic get still performs a single table read without metadata requests.
No ServiceNow instance calls are required.

Connected-PDI terminal counts and scope limits: `docs/verification/317-metadata.md`.
