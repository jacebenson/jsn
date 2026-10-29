# JSN decisions

## Runtime auth recovery reacts to rejection, not session age

Issue #311 adds an App-owned recovery provider to the SDK. Only a real command's
HTTP 401 permits one refresh/reauthentication and one retry. Bootstrap requests,
403, network errors, aborts, timeouts and 5xx never invoke recovery. Replaying a
mutation is allowed only after that definitive 401 rejection; an uncertain
outcome is never replayed. The SDK imports no app/config policy.

OAuth retains the existing identity-scoped token refresh and the declared-expiry
refresh in `AuthManager.getCredentialsFor`. The latter uses `expires_at` and is
intentionally unchanged. There is no new preflight or fixed session-age rule.
Basic never renews. Browser renewal uses the existing bounded GCK login flow,
with profile `reauth` defaulting to `confirm`; `auto` and `never` are explicit
settings through `auth modify`. Noninteractive and machine-output invocations
never prompt or launch a browser. Setup does not duplicate this setting.

401 and 403 errors omit provider bodies, which may contain credentials. 401
errors carry profile-specific recovery guidance; 403 reports an ACL/role problem.
Other statuses keep their existing API error behavior. Diagnostics remain
read-only and offline commands do not acquire credentials.

## Setup collects answers for the canonical auth operations

Setup remains the human front door, with add/reconnect/status/default/settings/
sign-out/remove actions. It invokes the same exported operations as `auth`;
the wizard has no separate credential or profile persistence. Login collects
new-profile preferences and a default choice before authentication, then saves
through one path. Bots provide explicit values or receive structured missing-
input errors, and never launch browsers implicitly. Preference flags are
idempotent assignments. New usernames cannot inherit the old default's pending
credential slot. Remote browser-extension capture is a separate follow-up
tracked in issue #302.

## Auth output separates profile settings, credentials, and live verification

Auth status uses a compact table for method, saved credential state, live
connection result, and profile options. Users and instance URLs require
`--details` in both human and machine output; identity JSON paths require that
flag as well. The identity column is labeled User. Credential
availability alone does not imply successful live verification. `--local`
skips instance requests. Auth/setup suppress the unrelated current-instance
header through a declared capability. New-profile login and setup share the
same option prompts; noninteractive login uses structured breadcrumbs for
setting hints. Existing-profile reauthentication preserves its settings.

## Browser login launches an isolated browser and manages its connection

Browser-session login launches a detected Chrome/Chromium-family browser with a
fresh temporary user directory and an OS-assigned loopback debugging port.
Setup asks only for the browser choice; JSN waits for login and then closes its
own browser and removes the directory. Browser selection supports installed
Chromium, Chrome, and Edge, with Chromium the first implemented/tested adapter.
`--browser-url` retains explicit advanced connection support.
Windows discovery uses Windows path separators, semicolon-delimited PATH,
case-insensitive environment names, and both per-user and system installations.
Browsers launch as executables with separate arguments and no shell, allowing
spaces without shell quoting. Cleanup asks the owned browser to close through
DevTools before falling back to termination, and retries profile removal for
file locks. This avoids treating Windows termination as graceful POSIX SIGTERM.
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

## Escape cancels any interactive prompt

`src/prompts.js` is the only module that imports `@inquirer/prompts`. Every
prompt a command shows comes from there through `cancellablePrompt`, which
listens for Escape, aborts with `PromptCancelled`, and removes its keypress
listener in a `finally`. Escape therefore backs out of selection, search,
confirmation, text entry and multi-select prompts alike, leaving no partial
answer behind.

A cancelled prompt throws, and the shared renderer turns `PromptCancelled` into
`Cancelled.` on stderr with exit status 0, so backing out is not a failure.
Guided flow and action editing catches it the same way it catches Ctrl+C and
returns without dispatching a mutation. Record pickers resolve `undefined`
instead, because every picker caller treats that as "leave this screen", and
the picker help line names Escape so the hint matches the wizard prompts.

The editor prompt is the exception: its keyboard belongs to `$EDITOR` while the
editor is open, so cancelling still uses Inquirer's Ctrl+C abort.

## Agent skill installation stays paired with the CLI

`jsn skill install` copies the packaged ServiceNow skill rather than downloading
mutable `main`. Skill guidance may omit safeguards only after the matching CLI
implements them, so a newer skill cannot safely be installed by an older CLI.
Installation, `skill show`, and `skill check` use the same bundled source and
version. Upgrade JSN and reinstall the skill to update both together.
`skill fetch` remains an explicit way to inspect the latest development text.

## 2026-10-28: Declarative record command profiles

The migrated simple-table and ticket factories consume validated JSON definitions
for aliases, table, default columns, identifier field, reference/list output and
relationship policy. Executable hooks remain JavaScript. The same definition is
attached to the implemented command as metadata, avoiding a second help-only map.
Bundled wrappers retain their public exports and specialized hooks; additional
profiles can use the same factory without a subprocess or a CRUD implementation.
