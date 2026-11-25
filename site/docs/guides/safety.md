---
title: Safety and mutations
---

Understand confirmation, read-only, update-set and skipped-change safeguards before changing records, flows or credentials.

## Use JSN safely

## Safe by default

Use a read-only profile while exploring. Setup's default preset allows writes;
read-only mode is an explicit profile setting. ServiceNow roles and ACLs still
control access. A compact help menu is not an access boundary.

```bash
jsn auth modify <profile> --read-only
jsn records list --table incident --query "active=true" --limit 5 --json
```

Writes do not all offer the same confirmation or preview behavior. Read each
command's help before enabling writes. Deletion normally asks for confirmation;
`--force` or an explicitly configured skip-confirmations policy can bypass that
prompt. A read-only profile still blocks instance mutations.

Treat `--force` as a deliberate boundary, not a convenience flag. Test against the correct profile, scope, and update set before changing an instance.

[Read about safe deletion](/features/safe-servicenow-record-deletion-cli/).

## Act as another user

`--impersonate <user_name or sys_id>` runs one command as that user: a read
returns the rows their roles and ACLs allow, and a record write is made as
them.

```bash
jsn records list --table incident --limit 5 --impersonate abel.tuter --json
jsn records update --table incident --sys-id <sys_id> --data '{"state":"2"}' --impersonate abel.tuter --impersonate-writes
```

The profile's user needs the admin or impersonator role. JSN opens a UI
session private to the process, switches it, and reads the session back before
the command runs, because the instance accepts a refused switch with success.
That session sends only its cookie and user token, since a per-request
credential would sign in again as the real user. It is never saved. On
success, failure, Ctrl+C or a closed pipe, JSN switches back, logs out and
checks the session has ended.

A write as another user never runs by default. In an interactive terminal JSN
asks, naming the user. Anywhere else, including `--json` and agents, it stops
with `confirmation_required` before any request and runs only when re-run with
`--impersonate-writes` after your user approves; `--yes` and `--force` do not
count. The usual guards still apply: a read-only profile refuses the write and
deletes still confirm. Customization writes are refused, because the
impersonated user's update set would capture them: `eval`, `rest` writes and
other commands that may write customization before any request, and record
writes to tables under `sys_metadata` once JSN has read the table's ancestry
as your own user.

Also refused before any request: local commands such as `setup`, `auth` and
`upgrade`; `records watch` and `logs follow`, which keep running after the
command returns; `compare`, `plugins compare`, `store compare`,
`updatesets diff` and `diff record`, which read through other profiles; and
browser-session profiles, whose cookies are the browser's own session.

## Credential destination policy

Project `.servicenow/config.json` files can select connection settings, but cannot
approve a destination for ambient `SERVICENOW_OAUTH_TOKEN` or Basic environment
credentials. Approve the exact origin outside the project: use `--instance URL`,
set `SERVICENOW_INSTANCE_URL` in the process environment, or configure that origin
as your user-global default. Merely saving another profile does not authorize a
project to redirect ambient credentials to its origin. Binding precedence is an
explicit instance, an explicitly selected global profile, the process instance,
then the global default. A project cannot approve an origin merely by
naming a profile. Explicitly selecting a globally saved profile uses its global
entry, not a same-named project shadow.

Environment variables are trusted process inputs, not project-file inputs. This
policy cannot protect a process after shell startup hooks, an untrusted dotenv
loader, or other code has already changed its environment. Direct SDK callers
and programmatically constructed config objects are responsible for selecting
their trusted destination; configuration loaded from project files retains its
origin provenance in memory. Stored credentials remain keyed to their instance
and username; this change does not grant project-selected origins access to
credentials for another origin.

The SDK rejects authenticated requests outside its configured instance origin.
Authenticated API requests and OAuth code/refresh grants do not follow redirects,
including same-origin redirects. Configure the canonical instance origin instead
of relying on a redirecting proxy. UI session bootstrap also rejects automatic
redirects. The existing MFA success response remains a manually inspected,
same-origin 302; it is not automatically followed.

Credential-bearing SDK and authentication requests require HTTPS. Loopback HTTP
(`localhost`, IPv4 127/8, and `::1`) remains available for local development.
For a legacy non-loopback HTTP instance, set `JSN_ALLOW_INSECURE_HTTP=1` explicitly
in the invoking process. This permits cleartext credential transmission and
should not be used on untrusted networks. Neither a project config key nor a
profile setting enables this escape hatch. It does not relax origin binding or
redirect rejection.

Transport inventory: OAuth grants and browser-session verification live in
`auth.js`; API/processor/raw-response/attachment requests, recovery verification,
UI bootstrap, MFA exchanges and AMB session acquisition live in `sdk.js`.
`amb.js` separately transmits AMB cookies/tokens and pins its destination to the
original instance origin, including when callers change its public baseUrl/path.
AMB paths must be local routes, not absolute URLs or protocol-relative references.
`midserver-install.js` validates explicit MID Basic credentials through a separate
sender. Both senders use the shared origin/HTTPS policy and reject redirects.

## Safe edits to existing flows

`flows update`, also available as `flows edit`, saves supported partial edits to an existing flow. Two lifecycle states are supported:

- an **inactive Draft**, whose working definition is edited directly;
- a **published or active flow whose ProcessFlow definition reports `security.can_write=true`**, whose working definition is edited while the published snapshot and runtime pointers must stay unchanged.

Every save acquires a Flow Designer safe-edit session, then releases that session and reads back its absence. The command does not publish, activate, execute, delete or roll back a flow, and it does not republish a published one.

The safe-edit session is a provider user-level lock, not an artifact deletion or publication operation. An existing session is refused even when it belongs to the current user: close the other Flow Designer editor first, or release your own stale lease with `jsn flows unlock` (see below). The CLI does not take over or release someone else's session. Stale definitions and competing editors stop content writes. Acquisition uses the ProcessFlow definition's `updated` timestamp, not a guessed current time; a definition whose timestamp lags the parent is reread once and refused if still stale. Preview never acquires or releases a lock.

### Inspect, preview, save and inspect again

```bash
jsn flows show "My draft" --profile pdi
jsn flows update "My draft" --profile pdi --data-file edit.json --preview
jsn flows update "My draft" --profile pdi --data-file edit.json --force
jsn flows show "My draft" --profile pdi --json
jsn flows show "My draft" --profile pdi --json --raw-payload   # + the ProcessFlow document
```

`flows show` returns the extracted steps, triggers, inputs and variables. The raw
ProcessFlow document is omitted because it duplicates those arrays; add
`--raw-payload` when you need the provider's own JSON.

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

### Supported edits and boundaries

- Change the `table` and/or `condition` of one existing `record_create_or_update` trigger. Conditions support one encoded predicate, or an empty string to clear it. Compound queries are refused.
- Change existing action inputs. Missing inputs, ambiguous step matches, duplicate action entries and caller-supplied component IDs are refused before mutation.
- Read transaction scope from the raw `sys_hub_flow.sys_scope`, with a legacy `scope` fallback. An explicit manifest scope must match it.
- Preserve omitted trigger/action inputs, component identities, ordering, schema fields, Flow Logic, subflows, variables, flow inputs/outputs and stages. A readback mismatch stops Autosave; it cannot undo an already-applied GraphQL patch.

New steps, removed steps, Flow Logic edits, subflow edits, flow-variable edits, catalog-trigger edits, error handling and stage placement are designer-only. Creation supporting a trigger family does not imply updates support it. Existing opaque components may be retained, but cannot be reconstructed through this partial manifest. Stage changes on both a definition and its published snapshot have no verified edit contract here and are not attempted.

### The published boundary is a permission, not a lifecycle label

Published is not the same as unwritable, and lifecycle alone cannot decide it. Several published global-scope flows report `security.can_write=true`, so the command reads the ProcessFlow definition and decides on the provider's own answer:

- `security.can_write === true` — the edit proceeds under the safe-edit lease, against the flow's working definition.
- `security.can_write === false`, or the field is absent — the command refuses **before** any edit session, content write or Autosave, naming the permission: the provider would answer `Insufficient access level for operation [write]`. This is a content-permission problem in that flow or its scope, not evidence that published flows need unpublishing or deactivation. Use an account or scope with write access to the flow's application, or edit the flow in Flow Designer as a user who can write it.

A published flow that is not currently active (`active=false`, `status=published`) is treated the same way: it is not an inactive Draft, so the same `can_write` check applies. A published target without a `master_snapshot` is refused, because there is no published baseline to compare against. The command still does not check out, unpublish, deactivate, modify raw component tables or edit a published snapshot.

### Proving the published snapshot stayed put

A published flow is edited as its working definition; the frozen snapshot that runtime reads is a different document. For a published target the command baselines runtime state after the definition read and before the edit session exists, then compares it again after the Autosave:

- `active`, `master_snapshot` and `latest_snapshot` on the parent record must be identical — these are the runtime gates;
- the published definition read through the `master_snapshot` id, compared as a digest, must be identical;
- the version rows, excluding the `Autosave` revisions this command creates, must be identical;
- the safe-edit lease is read once more after release and must be absent.

Two parent fields do move when a published flow is saved, because the platform turns the save into a draft working copy: `status` goes from `published` to `draft`, and `version_record` points at the new Autosave. Those two transitions are accepted only in exactly that shape — a status change from anything other than `published` to `draft`, or a `version_record` that is not this command's new Autosave — and they are reported as `runtime_preservation.design_time_changes` instead of being hidden. The result's `flow.status` is the post-save record state, so a published flow that now has a draft working copy reports `draft` with `active: true`.

Any other difference fails the command with last completed stage `autosave_verified` and the concrete before/after values, stating that the edit may have altered runtime and that no rollback, republish, unpublish or deactivation was attempted. A lease that survives the save is reported as a failed command naming the saved Autosave, not as success.

An Autosave is a design-time revision. It does not publish and does not make a published flow start using edited content; publishing the new revision remains a separate, explicit command. Until it is republished, the flow record shows a draft working copy while the unchanged published snapshot keeps running.

### Recovering a stale session

An update refuses any session the provider already reports for this user, including one left behind by an earlier failed run. When the refusal names `canUserEdit=true` or a `currentEditor`, release your own lease explicitly:

```bash
jsn flows unlock "My draft" --profile pdi      # asks first; --force in scripts
```

`unlock` reads the lease, releases only the session this user holds, then reads it back and fails if any session remains. It prints `canUserEdit` and `currentEditor` before and after, so a refusal you cannot clear shows the provider's own answer instead of a guess. It makes no content write and does not publish. If the flow is genuinely open in a Flow Designer tab, releasing the lease makes that editor's next save fail, so close the tab instead.

### Save evidence and partial failures

A successful save returns the before/after input diff, the ProcessFlow definition read back after the patch, an exact newly allocated Autosave version, and update-set capture diagnostics. A published save additionally returns `runtime_preservation` with the before/after pointers, published snapshot digest and version rows, plus `lifecycle.safe_edit_lease: "absent"`. The version uses annotation `JSN flow update`.

Failures after mutation name the exact flow ID and last completed stage: `validated`, `patch_acknowledged`, `definition_verified`, `autosave_verified` or `runtime_verified`. A timeout or failed capture read can occur after a provider write. A newly acquired session is released after success or failure; release failure is an error even if the save succeeded, and preserves any original partial-write error in its message. An ambiguous acquisition is not automatically retried or released because ownership is unknown. Inspect the exact flow, edit session, versions and update-set capture before retrying. No automatic retry, deletion or rollback occurs. Capture diagnostics can contain private definition XML; store them securely.

### Capture context before writes

Update-set reporting and the provider's effective capture context come from different sources. Reporting reads the persisted `sys_user_preference` (`name=sys_update_set`); the write captures into the authenticated session's effective picker selection (`GET /api/now/ui/concoursepicker/updateset`). A fresh CLI invocation is a fresh session, so the two can disagree even when the preference names the intended set.

Before the first content write, `flows create` and `flows update` read the effective session selection and, when it differs from the persisted choice, re-apply the persisted choice through the same picker contract (`PUT /api/now/ui/concoursepicker/updateset`) and verify the result. The outcome is returned as `capture_context` (`intended`, `effective`, `aligned`, `action`, and `previous_effective` when a selection was applied). A mismatch that cannot be aligned fails before any content write. When the effective selection cannot be read at all — for example an auth mode that cannot keep a UI session — `capture_context.aligned` is `null` with `action: "unverified"`; the write proceeds but capture cannot be pre-verified. Preview never touches the session.

After the save, `update_set_capture` is computed for the intended set. When it reports `missing`, the CLI also searches `sys_update_xml` by `nameLIKE<flowId>` across sets. Matching rows in another set produce `update_set_capture.elsewhere.update_sets` and a `diagnosis` saying capture was routed elsewhere; finding none says capture may be absent or named differently. Nothing is moved, deleted or retried.

These checks are repository-tested against synthetic providers. They establish that the CLI no longer reports a set it has not confirmed, not why a specific instance or auth mode ignored a selection; that still requires a PDI.

### Repository tests versus instance evidence

Repository tests prove no-write validation/preview, raw scope resolution, preservation guards, version readback, partial-failure reporting, the published `can_write` gate, published preview, published snapshot/runtime-pointer preservation and lease release against synthetic providers. They do not establish platform ACLs or every Flow Designer family.

PDI testing for issue #295 verified action-input and record-trigger condition/table saves through the branch-local CLI on inactive drafts, including guided condition and action-input saves, exact ProcessFlow readback, a new Autosave, inactive Draft status and capture in a disposable update set. Follow-up verification edited an older definition with saved children dating to 2019, saved its Autosave, restored the original scalar value through the same CLI, and verified full action/trigger restoration and lock cleanup. Session application/update-set selections were read through the session-aware picker API and restored.

Read-only inspection of four published global-scope active flows reported `security.can_write=true` for all four, which is why lifecycle alone cannot decide writability. An earlier published sample from a store/demo scope reported `can_write=false` and its content patch was rejected with `Insufficient access level for operation [write]`; that is a content-permission result for that scope, not a published lifecycle rule. Evidence is instance-specific, not a claim that every ServiceNow release accepts the same contract. Private IDs and full live payloads belong in the owner-only evidence report, not in Git.

A disposable published fixture (`JSN-STUDY-295-PUB-*`, record-trigger condition that cannot match) was created, published and then edited through `flows update` while its record said `published`/`active=true`. The save returned the exact new condition, a new Autosave, an unchanged published snapshot id and digest, unchanged `active`, `master_snapshot`, `latest_snapshot` and published version rows, and the platform checkout (`status` `published`→`draft`, `version_record`→the new Autosave) reported as `design_time_changes`. Restoring the original condition through the same command verified the reverse readback with the same preservation result, and preview on the published flow returned before/after values with no version row and no pointer change. The same `can_write=false` store-scope sample was refused read-only with the permission message and no content write. Deactivation is not a CLI command; the platform route `GET /api/now/processflow/flow/<id>/deactivate` deactivated the fixture (`active=false`, status still `published`, snapshot intact) and left the `sys_flow_record_trigger` row for its table active, which is why the flow record — not that registration row — is the liveness gate.

## Skipped update review

`jsn skipped-updates` discovers existing unresolved upgrade findings across the instance. It does not require a new upgrade event or filter to one upgrade history. The same upgrade log contains platform upgrade, patch and application-installation findings.

```sh
jsn skipped-updates list --json --limit 100 --offset 0
jsn skipped-updates review <finding-sys-id> --json
jsn skipped-updates preview --ids <finding-1>,<finding-2> --action retain --json
```

Discovery includes raw dispositions 4, 104, 9, 10 and 11 with blank or `not_reviewed` resolution. A page reports its fetched count, offset and `has_more`; the instance-wide total is unknown. Use the next offset to continue. A normal prompt-capable terminal uses the shared select-to-review picker. `process` offers a bounded 100-finding multi-select page and an explicit action picker when IDs or the action are omitted. Other pages can be selected with explicit IDs.

### Evidence and impact

Each review identifies the upgrade finding and affected artifact, selects the exact base version using the platform's version API, and compares its flat XML field values with the current artifact. It reports literal field changes, direct effects that can be established without executing the artifact, incoming references discovered through the dictionary, and unknown effects. Dependency reads are bounded to 20 reference fields and 10 referring records per field. Truncation and failed reads are reported as unknown.

`src/impact-analysis.js` is a reusable pure module. It accepts an artifact identity, current fields, a base payload and known dependencies. It performs no requests or writes and can be used independently by other commands. It does not simulate scripts, infer dynamic script dependencies, or establish transitive runtime safety. Its recommendation is deliberately to retain customizations pending validation of unknown effects. This conservative recommendation is advice, not an automatic selection.

The supported payload is a flat `record_update` for the exact artifact, with `INSERT_OR_UPDATE`, ordinary XML entities and CDATA. Other payload shapes, deletion operations and missing current fields remain unknown. There are no added XML-parser dependencies.

### One confirmation, selected action only

In a prompt-capable auto-format terminal:

```sh
jsn skipped-updates process
```

Select multiple findings and an action. The command renders the exact selected IDs, artifact identities, operations, evidence and impact before asking one default-No confirmation. Cancellation performs no writes. `--force` and a profile's `skip_confirmations` do not waive this batch confirmation.

Automation must review a read-only preview first, then confirm its token:

```sh
jsn skipped-updates preview --ids <finding-1>,<finding-2> --action revert --json
## Review data.selected and retain data.confirmation_token from that output.
jsn skipped-updates process --ids <finding-1>,<finding-2> --action revert --confirm <token> --json
```

The SHA-256 token binds the effective instance, exact selection, action, evidence, impact and finding/current-artifact/base snapshots. Changed snapshots reject old consent. JSON, pipes, `--get` and no-prompt environments never open a picker or confirmation prompt. They need explicit IDs, action and token. A missing token produces `confirmation_required` without writes.

`retain` sets only `resolution_status=reviewed_retained`. It does not change the customization. `revert` calls the observed provider lifecycle `RevertUpdateVersionAjax.revertToBaseSystem`, which chooses the platform or Store-app baseline, applies it, records a customer update and changes disposition/resolution. Generic Table API updates are never labeled as a revert.

Revert is limited to disposition 4, the provider UI action's verified eligibility, with a readable artifact and base version. The instance's script include must expose the observed method before a revert batch is prepared. Other skip dispositions are discoverable/reviewable and can be retained, but this CLI does not invent a revert contract for them. Baseline inspection and revert require Script Background access; revert also checks admin role and write access on the selected log record.

The capability registry declares `process` as a mutation. Existing middleware requires an instance and blocks read-only profiles, but does not prompt before preview. `list`, `review` and `preview` are read-only. The domain module also checks read-only state.

### Outcomes and limits

Each selected finding is rechecked after confirmation. Retain verifies log state by GET. Revert verifies disposition 5, `reviewed_reverted`, the same selected base-version identity and every meaningful base field on the artifact, including scope/class metadata but excluding identity and update bookkeeping. Dispatch acknowledgement alone is not success. Failures include whether a write was attempted; an attempted write with failed verification has unknown effects and should be inspected before retrying. A partly successful batch reports both counts and exits nonzero. There is no automatic rollback or recommendation-driven action.

Read/check/write is not an atomic transaction across the entire batch. Concurrent provider changes can still happen between checks and writes, particularly for retain's Table API update. Revert has an additional server-side finding-state/update-count check, but no claim of a lock on all versions or artifacts. Readback normalization may produce an honest verification failure after a real revert. Deeper outcomes still require operator validation.

### Provider sources and verification

Official ServiceNow Australia documentation, available through `jsn docs search "skipped updates"`:

- [Resolve a skipped update and set a resolution status](https://www.servicenow.com/docs/r/platform-administration/upgrade-management/um-resolve-skipped-update.html), local doc 37734. It distinguishes Reviewed and Retained from Revert to Base System and describes reverted disposition, resolution and customer-update creation.
- [Skipped records that occur during application installation](https://www.servicenow.com/docs/r/platform-administration/generation-skip-records-app-installs.html), local doc 36385. It confirms application skips use `sys_upgrade_history_log`.

Read-only inspection on the configured Australia PDI verified the dictionary, raw choice values, the Revert to Base System UI action condition and script, and the `RevertUpdateVersionAjax` implementation. The exact base-version getter path was exercised through a read-only background script.

### Verified live behavior on a PDI

A disposable Script Include fixture was created, customized, and processed through this CLI against a configured Australia PDI, then deleted.

- `RevertToBaseSystem` reverted the artifact to the previewed base content and left a **new** `sys_update_version` record behind whose payload is a byte-identical copy of the previewed baseline (matching SHA-256). The previewed version `sys_id` therefore legitimately changes. Revert readback compares base **content** (payload digest) plus the artifact's meaningful fields, never the previewed version `sys_id`. Requiring the same `sys_id` would report a successful revert as failed.
- A before-business-rule named `Add To Update Set On Resolution Change` is active on `sys_upgrade_history_log` (Global, `before`). Every resolution change this CLI writes is captured as a `sys_update_xml` record in the **active** update set. Run retain/revert batches in a scratch update set and delete the captured records with the fixture, or the operator inherits customer updates for records that no longer exist.
- Deletion of captured `sys_update_xml` records is ACL-blocked over the Table API on a PDI. Remove them through a background script with admin rights.

Live retained and reverted read-backs (log state, disposition, artifact script) are recorded in the issue 270 evidence set.

### Local processing versus cross-instance transfer

These note what this command does **not** do. `skipped-updates` reviews and processes findings on the instance you are connected to. It is not an update-set transport for skips, and no transport feature is planned here.

- [KB0955553](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0955553) documents the `glide.save.skiplist.decision` property and the conditions an update-set transfer checks: same `file_name`, `sys_upgrade_state` matching the incoming version payload hash, `changed=true`, resolution other than not reviewed, an eligible disposition, and the latest upgrade WAR matching. Plugin-history skips cannot be moved or processed through update sets at all.
- Those conditions limit **transfer**. They are not review eligibility, so discovery stays instance-wide with no latest-upgrade or event filter.
- [KB0678054](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0678054) shows the `sys_upgrade_history_log` disposition grouping is consolidated evidence, with the related sections covering the individual groups.
- [KB0726987](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0726987) explains that skip counts differ between instances because of incomplete clones and modifications between clone and upgrade. Matching or differing counts are not parity or completeness evidence.
- A [ServiceNow Community article on processing skipped records](https://www.servicenow.com/community/upgrades-and-patching-articles/processing-skipped-records-and-capturing-upgrade-details-in/ta-p/3403302) notes that captured upgrade-detail payloads match across instances by `incoming_version_payload_hash` rather than by log `sys_id`, and confirms the resolution-change capture described above.

## Local mutation history (retired)

The CLI no longer creates, opens, updates or prunes a local mutation-history
database. `jsn history` and its subcommands are no longer available; they fail as
unknown commands. The logging-only global `--reason` option was removed too.
Command-specific provider reason fields and mutation safeguards are unchanged.

Existing `history.db` files under `JSN_DATA_HOME` (formerly `~/.jsn` by default)
are left untouched: there is no automatic deletion, migration or retention job.
This former convenience log did not provide undo or a durable ServiceNow audit.
Use the instance's audit/history facilities when you need provider-side evidence.
Documentation search indexes remain supported and separate.
