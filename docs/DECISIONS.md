# JSN decisions

## Browser login launches an isolated browser and manages its connection

Browser-session login launches a detected Chrome/Chromium-family browser with a
fresh temporary user directory and an OS-assigned loopback debugging port.
Setup asks only for the browser choice; JSN waits for login and then closes its
own browser and removes the directory. Browser selection supports installed
Chromium, Chrome, and Edge, with Chromium the first implemented/tested adapter.
`--browser-url` retains explicit advanced connection support.
It reads one exact-origin tab and API-scoped cookies, then verifies the current
user before saving via AuthManager. It rejects ambiguous tabs and account
mismatches. No browser databases, decryption helpers, dependencies, automatic
browser restarts, or background session renewal are introduced. Imported
credentials remain `gck`, so transport and storage use the existing auth path.
Firefox needs a separate adapter; macOS, Windows, Chrome, and Edge still need
live validation of platform browser discovery and launch.

## The capability registry is authoritative

Command safety capabilities live in `src/capabilities.js`. Middleware derives mutation and daily-check behavior from that registry. New commands must declare their capabilities instead of adding names to separate lists.

## Output goes through one controller

Command data goes through `app.output` so JSON, Markdown, CSV, styled output, and `--get` remain consistent. Handlers must not print data directly with `console.log`.

## Mutations stay guarded

Mutation commands require the instance, respect read-only profile boundaries, and follow the confirmation path in `src/mutations.js`. Verification recipes use read-only commands unless a disposable mutation lane is explicitly established.

## Verification is project-owned

The pstack-shaped launch, drive, proof, evidence, and cleanup instructions live in `.agents/skills/verify/`. General product knowledge lives in `docs/`, so verification procedures and product description do not drift into one document.

## Skipped batches require preview-bound consent

Skipped-update processing is declared as a mutation through the capability registry.
The shared middleware blocks read-only profiles without requesting confirmation.
The domain module previews the exact selected batch before its single confirmation;
automation confirms a snapshot-bound token from a separate read-only preview.
`--force` and profile confirmation opt-outs do not waive this consent. Impact analysis
is pure and reusable, while revert calls the inspected provider lifecycle and verifies
log and artifact readback. Unknown deeper effects remain explicit rather than being
inferred from a field comparison.

## New flows get their trigger from the same GraphQL patch as their actions

`POST /api/now/processflow/flow` returns a flow whose `triggerInstances` is
empty — there is no default trigger to patch — so `jsn flows create` inserts the
trigger through the `snFlowDesigner` `flowPatch` alongside the actions, then
verifies it by reading the flow back. Creation is therefore two-stage: a failure
after the parent POST names the orphan draft's sys_id in the error, because flow
deletion is not implemented and the operator has to remove it in Flow Designer.

## Trigger inputs come from the instance, not a hand-written table

`sys_hub_trigger_input` is the source of truth for what each trigger definition
declares. Its owning definition is carried by the `name` column
(`var__m_sys_hub_trigger_input_<definitionId>`); the `model` reference is empty
on the verified instance and a `trigger_definition=` query is ignored, so the
name suffix is the only reliable relation. `internal_type` holds the GraphQL type
as its raw value. The documented record-trigger table descriptor route
(`/api/now/processflow/trigger/record/table`) does not exist (HTTP 400), so the
table label comes from `sys_db_object` and the display column from the nearest
`sys_dictionary` `display=true` element walking up `super_class`.

## The instance derives trigger predicate metadata

The `snFlowDesigner` patch parses the `condition` trigger input into
`metadata.query_parse.predicates` itself, producing the same `field_label`,
`operator_label` and `field_type` Flow Designer shows. This CLI sends `{}` and
verifies the derived predicate by read-back instead of rebuilding the predicate
tree locally, which removes the dead descriptor route from the condition path.

## GraphQL input objects are narrower than the read model

The `snFlowDesigner` input types accept strict key sets that GraphQL
introspection (disabled on the verified instance) cannot reveal. Notably
`global_snFlowDesigner_ActionInstanceValue` takes only
`id/name/children/displayField/scriptActive/parameter/value/displayValue`, with
the provider's UI schema carried inside `parameter`
(`global_snFlowDesigner_FlowDesignParameter`), and `attributes` is a String on
input even though the read path renders an object. Payload builders narrow the
provider's schema to those sets; the accepted keys are recorded in
`src/flow-triggers.js`.

## Revert readback verifies base content, not the previewed version sys_id

`RevertUpdateVersionAjax.revertToBaseSystem` reverts the artifact to the previewed
base version and leaves a new `sys_update_version` record whose payload copies
that baseline. The previewed version `sys_id` is therefore expected to change, so
comparing it after the write reports a real revert as a failure. Revert readback
compares the SHA-256 digest of the base payload captured during review plus the
artifact's meaningful base fields. A fake provider that returns the same version
record after the write cannot expose this, so the regression test simulates the
provider's new record.
