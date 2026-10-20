# Safe edits to existing flows

`flows update`, also available as `flows edit`, saves supported partial edits to an existing flow. Two lifecycle states are supported:

- an **inactive Draft**, whose working definition is edited directly;
- a **published or active flow whose ProcessFlow definition reports `security.can_write=true`**, whose working definition is edited while the published snapshot and runtime pointers must stay unchanged.

Every save acquires a Flow Designer safe-edit session, then releases that session and reads back its absence. The command does not publish, activate, execute, delete or roll back a flow, and it does not republish a published one.

The safe-edit session is a provider user-level lock, not an artifact deletion or publication operation. An existing session is refused even when it belongs to the current user: close the other Flow Designer editor first. The CLI does not take over or release someone else's session. Stale definitions and competing editors stop content writes. Acquisition uses the ProcessFlow definition's `updated` timestamp, not a guessed current time; a definition whose timestamp lags the parent is reread once and refused if still stale. Preview never acquires or releases a lock.

## Inspect, preview, save and inspect again

```bash
jsn flows show "My draft" --profile pdi
jsn flows update "My draft" --profile pdi --data-file edit.json --preview
jsn flows update "My draft" --profile pdi --data-file edit.json --force
jsn flows show "My draft" --profile pdi --json
```

Example `edit.json`:

```json
{
  "trigger": { "condition": "short_descriptionSTARTSWITHStudy" },
  "actions": [
    { "order": 1, "type": "Log", "inputs": { "log_message": "Updated message" } }
  ]
}
```

Use the flow's exact name or sys_id. Each action identifies an existing step by its order and published action type name or sys_id. Callers do not supply component identities. Omit `trigger` or `actions` to leave that component unchanged. Only list inputs you intend to change. Combine edits to one action in one entry.

In a human terminal with automatic output, omit `--data` and `--data-file` to use the existing condition/input wizard. Scripts must supply an explicit identifier and manifest. `--preview` validates the same manifest and resolves the same target as saving, then returns before/after values without a GraphQL mutation, edit session or Autosave. It does not reserve a version or lock the flow. Preview and save are separate reads; avoid concurrent designer edits.

## Supported edits and boundaries

- Change the `table` and/or `condition` of one existing `record_create_or_update` trigger. Conditions support one encoded predicate, or an empty string to clear it. Compound queries are refused.
- Change existing action inputs. Missing inputs, ambiguous step matches, duplicate action entries and caller-supplied component IDs are refused before mutation.
- Read transaction scope from the raw `sys_hub_flow.sys_scope`, with a legacy `scope` fallback. An explicit manifest scope must match it.
- Preserve omitted trigger/action inputs, component identities, ordering, schema fields, Flow Logic, subflows, variables, flow inputs/outputs and stages. A readback mismatch stops Autosave; it cannot undo an already-applied GraphQL patch.

New steps, removed steps, Flow Logic edits, subflow edits, flow-variable edits, catalog-trigger edits, error handling and stage placement are designer-only. Creation supporting a trigger family does not imply updates support it. Existing opaque components may be retained, but cannot be reconstructed through this partial manifest. Stage changes on both a definition and its published snapshot have no verified edit contract here and are not attempted.

## The published boundary is a permission, not a lifecycle label

Published is not the same as unwritable, and lifecycle alone cannot decide it. Several published global-scope flows report `security.can_write=true`, so the command reads the ProcessFlow definition and decides on the provider's own answer:

- `security.can_write === true` — the edit proceeds under the safe-edit lease, against the flow's working definition.
- `security.can_write === false`, or the field is absent — the command refuses **before** any edit session, content write or Autosave, naming the permission: the provider would answer `Insufficient access level for operation [write]`. This is a content-permission problem in that flow or its scope, not evidence that published flows need unpublishing or deactivation. Use an account or scope with write access to the flow's application, or edit the flow in Flow Designer as a user who can write it.

A published flow that is not currently active (`active=false`, `status=published`) is treated the same way: it is not an inactive Draft, so the same `can_write` check applies. A published target without a `master_snapshot` is refused, because there is no published baseline to compare against. The command still does not check out, unpublish, deactivate, modify raw component tables or edit a published snapshot.

## Proving the published snapshot stayed put

A published flow is edited as its working definition; the frozen snapshot that runtime reads is a different document. For a published target the command baselines runtime state after the definition read and before the edit session exists, then compares it again after the Autosave:

- `active`, `master_snapshot` and `latest_snapshot` on the parent record must be identical — these are the runtime gates;
- the published definition read through the `master_snapshot` id, compared as a digest, must be identical;
- the version rows, excluding the `Autosave` revisions this command creates, must be identical;
- the safe-edit lease is read once more after release and must be absent.

Two parent fields do move when a published flow is saved, because the platform turns the save into a draft working copy: `status` goes from `published` to `draft`, and `version_record` points at the new Autosave. Those two transitions are accepted only in exactly that shape — a status change from anything other than `published` to `draft`, or a `version_record` that is not this command's new Autosave — and they are reported as `runtime_preservation.design_time_changes` instead of being hidden. The result's `flow.status` is the post-save record state, so a published flow that now has a draft working copy reports `draft` with `active: true`.

Any other difference fails the command with last completed stage `autosave_verified` and the concrete before/after values, stating that the edit may have altered runtime and that no rollback, republish, unpublish or deactivation was attempted. A lease that survives the save is reported as a failed command naming the saved Autosave, not as success.

An Autosave is a design-time revision. It does not publish and does not make a published flow start using edited content; publishing the new revision remains a separate, explicit command. Until it is republished, the flow record shows a draft working copy while the unchanged published snapshot keeps running.

## Save evidence and partial failures

A successful save returns the before/after input diff, the ProcessFlow definition read back after the patch, an exact newly allocated Autosave version, and update-set capture diagnostics. A published save additionally returns `runtime_preservation` with the before/after pointers, published snapshot digest and version rows, plus `lifecycle.safe_edit_lease: "absent"`. The version uses annotation `JSN flow update`.

Failures after mutation name the exact flow ID and last completed stage: `validated`, `patch_acknowledged`, `definition_verified`, `autosave_verified` or `runtime_verified`. A timeout or failed capture read can occur after a provider write. A newly acquired session is released after success or failure; release failure is an error even if the save succeeded, and preserves any original partial-write error in its message. An ambiguous acquisition is not automatically retried or released because ownership is unknown. Inspect the exact flow, edit session, versions and update-set capture before retrying. No automatic retry, deletion or rollback occurs. Capture diagnostics can contain private definition XML; store them securely.

## Repository tests versus instance evidence

Repository tests prove no-write validation/preview, raw scope resolution, preservation guards, version readback, partial-failure reporting, the published `can_write` gate, published preview, published snapshot/runtime-pointer preservation and lease release against synthetic providers. They do not establish platform ACLs or every Flow Designer family.

PDI testing for issue #295 verified action-input and record-trigger condition/table saves through the branch-local CLI on inactive drafts, including guided condition and action-input saves, exact ProcessFlow readback, a new Autosave, inactive Draft status and capture in a disposable update set. Follow-up verification edited an older definition with saved children dating to 2019, saved its Autosave, restored the original scalar value through the same CLI, and verified full action/trigger restoration and lock cleanup. Session application/update-set selections were read through the session-aware picker API and restored.

Read-only inspection of four published global-scope active flows reported `security.can_write=true` for all four, which is why lifecycle alone cannot decide writability. An earlier published sample from a store/demo scope reported `can_write=false` and its content patch was rejected with `Insufficient access level for operation [write]`; that is a content-permission result for that scope, not a published lifecycle rule. Evidence is instance-specific, not a claim that every ServiceNow release accepts the same contract. Private IDs and full live payloads belong in the owner-only evidence report, not in Git.

A disposable published fixture (`JSN-STUDY-295-PUB-*`, record-trigger condition that cannot match) was created, published and then edited through `flows update` while its record said `published`/`active=true`. The save returned the exact new condition, a new Autosave, an unchanged published snapshot id and digest, unchanged `active`, `master_snapshot`, `latest_snapshot` and published version rows, and the platform checkout (`status` `published`→`draft`, `version_record`→the new Autosave) reported as `design_time_changes`. Restoring the original condition through the same command verified the reverse readback with the same preservation result, and preview on the published flow returned before/after values with no version row and no pointer change. The same `can_write=false` store-scope sample was refused read-only with the permission message and no content write. Deactivation is not a CLI command; the platform route `GET /api/now/processflow/flow/<id>/deactivate` deactivated the fixture (`active=false`, status still `published`, snapshot intact) and left the `sys_flow_record_trigger` row for its table active, which is why the flow record — not that registration row — is the liveness gate.
