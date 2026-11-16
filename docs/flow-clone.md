# Clone an inactive Draft flow

Status: draft feature; not live accepted. Native allocation and a separately user-operated Designer Force Save have been observed. They establish distinct copy, full-save and version-creation operations, not a completed CLI clone lifecycle.

```sh
jsn flows clone 'Source flow' --name 'My copied flow' --force --json
jsn flows copy <source_sys_id> --name 'My copied flow' --force --get data.flow.id
```

`clone` is canonical; `copy` is an alias with identical mutation, confirmation and read-only-profile guards. Omitting the source in a prompt-capable auto-format terminal uses the family's shared picker. An interactive invocation without `--name` uses `<source name> copy`. Automation must supply `--name`. A name collision in the source scope is refused, never overwritten. The collision read is repeated just before allocation, but the provider does not expose an atomic uniqueness guarantee.

Select a named, in-progress update set with an already aligned effective session before running the command. Clone does not switch applications or update sets. Both persisted capture selection and effective picker selection must match before allocation and remain unchanged afterward. The new flow stays in the source application scope, with its access, protection, domain and run-as policy preserved. Cross-scope copying and description changes are not offered.

## Supported graph and fail-closed boundaries

The initial contract supports inactive, nondeleted Draft flows with one record-create, record-update or record-create-or-update trigger and flat actions referencing published reusable definitions. It compares the complete accepted provider collections and preserved top-level inventory, including descriptions, conditions, scripts, typed inputs, parameter schemas, choice/default metadata, maps and action definitions. Native copy owns allocation and serialization; this command does not export a reduced manifest or reconstruct the graph.

Owned flow, database component and catalog-variable-model identities must be fresh. Flow-local UI identifiers can be preserved by native copy, or remapped together with their typed references. Only those explicit identity/ownership paths and complete typed input pills are remapped for comparison. A destination-only `compiledSnapshot` is treated as derived only for a flat published action when it equals both the unchanged reusable definition's identity and `actionTypeSysId`, and the source field is explicitly empty. This does not allow runtime-bearing sources or unrelated snapshots. Literal embedded IDs, scripts and arbitrary object keys must remain unchanged. Anonymous nested input/output schema children remain anonymous; identified schema children must receive fresh identities.

Nonempty stages, nested logic, subflows, flow variables, catalog variables, connection configurations, error handlers, runtime snapshots, unknown top-level fields and unknown component fields are refused before the native allocation. Embedded or script-based pill encodings are likewise refused. Unsupported categories are not omitted from a copy. Credentials, runtime history and execution snapshots are not submitted to the provider. Shared action/trigger/parameter definitions remain references, not cloned records.

## Verification and partial results

The implementation sends exactly one source-confirmed native Designer allocation request:

```text
POST /api/now/processflow/flow/{source}/copy?sysparm_transaction_scope={source-native-scope}
{"name":"requested unique name","scope":"source-native-scope"}
```

Designer 29.0.5 `copyFlowSaga`, `copyFlowServerCall` and `getCopyFlowServerModel` establish this contract. The response's `result.data` is the new sys_id. It is not a guessed GraphQL operation or a guessed create payload.

Success requires positive destination name/scope/provenance and inactive-Draft evidence, full accepted-definition comparison, fresh identities, an exact saved version with matching owned identities and input values, source-to-copy serialized version content/schema comparison, and an exact parent customer update whose parsed XML points at that version. Source definition SHA-256 digests must match before and after. The original saved-version content is read and checked before allocation. Capture polling uses bounded GETs only and never repeats allocation.

The capture receipt proves the exact parent XML and saved version pointer/content, not independent child-table XML portability or execution correctness. It does not publish, activate or execute the flow. A verification failure is an error, not a claim that allocation rolled back.

After allocation, failures retain the new flow sys_id and failed stage in the actual JSON error envelope. Ambiguous allocation responses report an uncertain outcome and source/name reconciliation instructions. No retry, delete or automatic cleanup is attempted. Reconcile a partial result before retrying.

## Evidence still required

After graph readback, completion checks the authenticated SDK user against the exact destination lease row and the Designer safe-edit status. Only positively owned leases permit a full native `PUT /api/now/processflow/flow`, followed by `POST /api/now/processflow/versioning/create_version` with `{item_sys_id, type:"Save", annotation:"", favorite:false}`. The save preserves the readable definition and instance input schemas; reusable action-definition inputs/steps are excluded as in the editor serializer. Before release it rechecks the same lease identity and owner, then uses GraphQL `safeEdit(delete:destination)` and verifies both status and lease-row absence. This deletes the edit lease, never the flow. The owned lease is also released after a native save failure; ambiguous or foreign ownership is a zero-save, zero-release refusal.

The retained native copy passes full GET-definition and serialized-version comparison. Two fixed record-trigger outputs (`current`/`document_id` and `table_name`/`table_name`) can omit the known `FlowDesignVariableMapper` serialization attribute; only that exact name/type/parameter relationship is normalized. Action-input mapper metadata and all other schema metadata remain strict. JSON object-key insertion order is ignored for source digests, but array order and authored values remain exact.

Live completion is still **not accepted**. The retained CLI allocation currently has no lease (`canUserEdit:false`, `currentEditor:null`, zero lease rows), so the authorized repair stopped before save/version/release rather than inventing ownership or acquiring a replacement. Independent GET-only readback proves the source and application/update-set context unchanged, the destination inactive Draft, and its graph/saved-version preserved; its parent XML still has an empty version pointer. The captured UI Force Save also demonstrated a predecessor/current-version mismatch. The exact-current-version XML gate remains strict: no empty or stale pointer is accepted. No new allocation or UI-owned-copy mutation was performed. Keep the PR draft until the native completion path and exact XML relationship are live verified.

The isolated `flow-clone-cli.test.js` acceptance scenarios run the real CLI against a loopback provider under normal `npm test`, so existing CLI CI executes them without secrets or untrusted live workflows. They prove parsing, aliases, guards, exact requests, readback verification and recovery behavior, not ServiceNow compatibility. No live acceptance workflow or completion files are changed by this feature.
