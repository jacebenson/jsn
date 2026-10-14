# Skipped update review

`jsn skipped-updates` discovers existing unresolved upgrade findings across the instance. It does not require a new upgrade event or filter to one upgrade history. The same upgrade log contains platform upgrade, patch and application-installation findings.

```sh
jsn skipped-updates list --json --limit 100 --offset 0
jsn skipped-updates review <finding-sys-id> --json
jsn skipped-updates preview --ids <finding-1>,<finding-2> --action retain --json
```

Discovery includes raw dispositions 4, 104, 9, 10 and 11 with blank or `not_reviewed` resolution. A page reports its fetched count, offset and `has_more`; the instance-wide total is unknown. Use the next offset to continue. A normal prompt-capable terminal uses the shared select-to-review picker. `process` offers a bounded 100-finding multi-select page and an explicit action picker when IDs or the action are omitted. Other pages can be selected with explicit IDs.

## Evidence and impact

Each review identifies the upgrade finding and affected artifact, selects the exact base version using the platform's version API, and compares its flat XML field values with the current artifact. It reports literal field changes, direct effects that can be established without executing the artifact, incoming references discovered through the dictionary, and unknown effects. Dependency reads are bounded to 20 reference fields and 10 referring records per field. Truncation and failed reads are reported as unknown.

`src/impact-analysis.js` is a reusable pure module. It accepts an artifact identity, current fields, a base payload and known dependencies. It performs no requests or writes and can be used independently by other commands. It does not simulate scripts, infer dynamic script dependencies, or establish transitive runtime safety. Its recommendation is deliberately to retain customizations pending validation of unknown effects. This conservative recommendation is advice, not an automatic selection.

The supported payload is a flat `record_update` for the exact artifact, with `INSERT_OR_UPDATE`, ordinary XML entities and CDATA. Other payload shapes, deletion operations and missing current fields remain unknown. There are no added XML-parser dependencies.

## One confirmation, selected action only

In a prompt-capable auto-format terminal:

```sh
jsn skipped-updates process
```

Select multiple findings and an action. The command renders the exact selected IDs, artifact identities, operations, evidence and impact before asking one default-No confirmation. Cancellation performs no writes. `--force` and a profile's `skip_confirmations` do not waive this batch confirmation.

Automation must review a read-only preview first, then confirm its token:

```sh
jsn skipped-updates preview --ids <finding-1>,<finding-2> --action revert --json
# Review data.selected and retain data.confirmation_token from that output.
jsn skipped-updates process --ids <finding-1>,<finding-2> --action revert --confirm <token> --json
```

The SHA-256 token binds the effective instance, exact selection, action, evidence, impact and finding/current-artifact/base snapshots. Changed snapshots reject old consent. JSON, pipes, `--get` and no-prompt environments never open a picker or confirmation prompt. They need explicit IDs, action and token. A missing token produces `confirmation_required` without writes.

`retain` sets only `resolution_status=reviewed_retained`. It does not change the customization. `revert` calls the observed provider lifecycle `RevertUpdateVersionAjax.revertToBaseSystem`, which chooses the platform or Store-app baseline, applies it, records a customer update and changes disposition/resolution. Generic Table API updates are never labeled as a revert.

Revert is limited to disposition 4, the provider UI action's verified eligibility, with a readable artifact and base version. The instance's script include must expose the observed method before a revert batch is prepared. Other skip dispositions are discoverable/reviewable and can be retained, but this CLI does not invent a revert contract for them. Baseline inspection and revert require Script Background access; revert also checks admin role and write access on the selected log record.

The capability registry declares `process` as a mutation. Existing middleware requires an instance and blocks read-only profiles, but does not prompt before preview. `list`, `review` and `preview` are read-only. The domain module also checks read-only state.

## Outcomes and limits

Each selected finding is rechecked after confirmation. Retain verifies log state by GET. Revert verifies disposition 5, `reviewed_reverted`, the same selected base-version identity and every meaningful base field on the artifact, including scope/class metadata but excluding identity and update bookkeeping. Dispatch acknowledgement alone is not success. Failures include whether a write was attempted; an attempted write with failed verification has unknown effects and should be inspected before retrying. A partly successful batch reports both counts and exits nonzero. There is no automatic rollback or recommendation-driven action.

Read/check/write is not an atomic transaction across the entire batch. Concurrent provider changes can still happen between checks and writes, particularly for retain's Table API update. Revert has an additional server-side finding-state/update-count check, but no claim of a lock on all versions or artifacts. Readback normalization may produce an honest verification failure after a real revert. Deeper outcomes still require operator validation.

## Provider sources and verification

Official ServiceNow Australia documentation, available through `jsn docs search "skipped updates"`:

- [Resolve a skipped update and set a resolution status](https://www.servicenow.com/docs/r/platform-administration/upgrade-management/um-resolve-skipped-update.html), local doc 37734. It distinguishes Reviewed and Retained from Revert to Base System and describes reverted disposition, resolution and customer-update creation.
- [Skipped records that occur during application installation](https://www.servicenow.com/docs/r/platform-administration/generation-skip-records-app-installs.html), local doc 36385. It confirms application skips use `sys_upgrade_history_log`.

Read-only inspection on the configured Australia PDI verified the dictionary, raw choice values, the Revert to Base System UI action condition and script, and the `RevertUpdateVersionAjax` implementation. The exact base-version getter path was exercised through a read-only background script. No live retain, revert, test-record creation or other instance writes were performed. Write orchestration and readback are tested with a fake provider; live persistence remains unverified.
