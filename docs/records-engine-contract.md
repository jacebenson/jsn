# Records engine compatibility contract

Audit for #313, prerequisite to #314–#321. Baseline: origin/main at a3b0e6f.
This contract precedes implementation and does not declare those issues complete.

## Current implementations

| Entry point | Implementation and transport | Compatibility requirements |
| --- | --- | --- |
| `records list/get/create/update/delete` | `src/commands/records.js`; SDK list, create, update, delete, aggregateCount, attachment methods | Arbitrary/custom tables; required table; columns/c/fields aliases; list query, limit=20, offset=0, counts with profile override; get attachments; JSON/file/stdin/repeated-field payloads; derived-field warnings and strict write-back verification |
| incidents/inc, changes/chg, requests/req, tasks/task | `src/commands/_ticket.js` via four modules; requests adds catalog helpers | Preserve tables incident/change_request/sc_req_item/sc_task, number identifiers, aliases, list sorting/pagination, create description/priority shortcuts, breadcrumbs and required short_description |
| `tickets/ticket` | `src/commands/tickets.js`; separate CRUD on task | Preserve distinct task table, list shape and show summary; migrate alongside ticket factory without changing aliases |
| Simple specialized commands | `src/commands/_simple.js` delegates to `_generic.js`; other modules also use factory | Preserve every name/alias/default column/readOnly flag, optional resolver, showFields, onShow, summaries, breadcrumbs, extraQuery and scopeValidation hooks |
| Specialized rich commands | flows/actions/catalog/CMDB/users and others have custom implementations | Do not replace specialized operations wholesale; shared resolver changes require existing regression suite |
| Form views | `src/commands/forms.js` independently reads views, sections, elements | No automatic form/related-list retrieval in current generic get or ticket show. Preserve generic presentation; form-aware presentation belongs to specialized views |

## Observable data and calls

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

## Identifier contract for the new engine

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

## Safety and extension boundaries

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

## Verification and migration gates

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
