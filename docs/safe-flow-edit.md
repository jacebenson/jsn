# Safe edits to existing flows

`flows update`, also available as `flows edit`, saves supported partial edits to an existing inactive Draft. Before the ProcessFlow GraphQL patch and Autosave it acquires a Flow Designer safe-edit session, then releases that session and reads back its absence. It does not check out a published flow, publish, activate, execute, delete or roll back a flow.

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

In a human terminal with automatic output, omit `--data` and `--data-file` to use the existing condition/input wizard. Scripts must supply an explicit identifier and manifest. `--preview` validates the same manifest and resolves the same target as saving, then returns before/after values without a GraphQL mutation or Autosave. It does not reserve a version or lock the flow. Preview and save are separate reads; avoid concurrent designer edits.

## Supported edits and boundaries

- Change the `table` and/or `condition` of one existing `record_create_or_update` trigger. Conditions support one encoded predicate, or an empty string to clear it. Compound queries are refused.
- Change existing action inputs. Missing inputs, ambiguous step matches, duplicate action entries and caller-supplied component IDs are refused before mutation.
- Read transaction scope from the raw `sys_hub_flow.sys_scope`, with a legacy `scope` fallback. An explicit manifest scope must match it.
- Preserve omitted trigger/action inputs, component identities, ordering, schema fields, Flow Logic, subflows, variables, flow inputs/outputs and stages. A readback mismatch stops Autosave; it cannot undo an already-applied GraphQL patch.

New steps, removed steps, Flow Logic edits, subflow edits, flow-variable edits, catalog-trigger edits, error handling and stage placement are designer-only. Creation supporting a trigger family does not imply updates support it. Existing opaque components may be retained, but cannot be reconstructed through this partial manifest. Stage changes on both a definition and its published snapshot have no verified edit contract here and are not attempted.

Published, active and unreadable-state targets are refused before writes. A published flow that is inactive is still refused. Use Flow Designer to check out and edit published flows. The CLI has not verified that checkout lifecycle, so it does not try guessed routes, deactivate a flow, modify raw component tables or edit published snapshots. Saving a draft in the designer does not bypass the CLI's inactive-Draft gate.

## Save evidence and partial failures

A successful save returns the before/after input diff, the ProcessFlow definition read back after the patch, an exact newly allocated Autosave version, and update-set capture diagnostics. The version uses annotation `JSN flow update`. An Autosave is not a published snapshot or an execution. Publishing and execution remain separate commands requiring separate consent.

Failures after mutation name the exact flow ID and last completed stage: `validated`, `patch_acknowledged`, `definition_verified` or `autosave_verified`. A timeout or failed capture read can occur after a provider write. A newly acquired session is released after success or failure; release failure is an error even if the save succeeded, and preserves any original partial-write error in its message. An ambiguous acquisition is not automatically retried or released because ownership is unknown. Inspect the exact flow, edit session, versions and update-set capture before retrying. No automatic retry, deletion or rollback occurs. Capture diagnostics can contain private definition XML; store them securely.

## Repository tests versus instance evidence

Repository tests prove no-write validation/preview, raw scope resolution, preservation guards, version readback and partial-failure reporting against synthetic providers. They do not establish platform ACLs or every Flow Designer family.

PDI testing for issue #295 verified action-input and record-trigger condition/table saves through the branch-local CLI, including guided condition and action-input saves, exact ProcessFlow readback, a new Autosave, inactive Draft status and capture in a disposable update set. Follow-up verification edited an older definition with saved children dating to 2019, saved its Autosave, restored the original scalar value through the same CLI, and verified full action/trigger restoration and lock cleanup. Session application/update-set selections were read through the session-aware picker API and restored.

A separate approved published-sample experiment acquired and released safe-edit while preserving the active snapshot and runtime pointers. However, that sample's ProcessFlow security remained `can_write=false`; the supported content patch was rejected with `Insufficient access level for operation [write]` both in the initial context and after selecting the target application. No successful published edit or restoration is claimed, and the public CLI's published-flow refusal remains. This evidence does not establish that all published flows are uneditable or that unpublishing is required. No publish, execution, deletion or stage/snapshot mutation was attempted. Evidence is instance-specific, not a claim that every ServiceNow release accepts the same contract. Private IDs and full live payloads belong in the owner-only evidence report, not in Git.
