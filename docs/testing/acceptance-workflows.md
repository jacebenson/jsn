# Owned-fixture acceptance workflows

These modules exercise the selected CLI through `ctx.command` and verify effects through independent, bounded `ctx.read` calls. They do not write through an SDK, use `eval`, contact customer services, provision a MID host or execute Store transactions.

No live acceptance claim accompanies these tests. The offline regression suite uses synthetic provider records. Public CLI regressions use loopback HTTP servers with isolated configuration and synthetic Basic credentials.

## Run offline

From the repository root:

```sh
node --test cli/test/acceptance-workflows.test.js
node --test cli/test/flow-designer-pty.test.js
```

The second command reuses the existing Python PTY driver. It proves synthetic interactive create/edit/confirmation/refusal/Escape/Ctrl+C behavior. It does not prove a live owned-fixture interactive workflow.

## Scenarios and readiness

| Scenario | Implemented sequence | Remaining live gate |
| --- | --- | --- |
| `workflows.context` | Read effective application and update-set pickers, save private original IDs, create/select dedicated Global capture set, verify effective selection | Child-first/context-last ordering is offline-proven; provider-generated captures remain unenumerated and the owned set is retained dirty |
| `resources.properties` | Create/show/update, deny unconfirmed delete, delete, independent readbacks | Live dictionary, ACL and capture-member reconciliation |
| `resources.views` | Same lifecycle, own `name` and `title` schema | Same |
| `resources.includes` | Same lifecycle, inactive inert script include | Same |
| `resources.rules` | Same lifecycle, inactive business rule | Same |
| `resources.clientscripts` | Same lifecycle, inactive onLoad client script | Same |
| `resources.uiactions` | Same lifecycle, inactive UI action | Same |
| `resources.scheduledjobs` | Same lifecycle, inactive on-demand script job | Same |
| `resources.uipolicies` | Same lifecycle, inactive UI policy, `short_description` identifier | Same |
| `workflows.update-set-transfer` | Generate owned native XML, reject unconfirmed import, load, reject commit before preview, preview, inspect problems, commit, independently read property effect and committed state | Platform native upload/CICD availability, preview ACLs and cleanup integration |
| `workflows.flow-lifecycle` | Create owned property and record-triggered Log flow, preview/edit, release own safe-edit lease, publish, status, test, bounded execution-state readback and exact log effect | Default-blocked because native flow deletion is explicitly unimplemented; complete graph enumeration/UI cleanup required |
| `workflows.catalog-fulfillment` | Create own item, separate mandatory variable, dependent Service Catalog flow, publish, bind owned item, reject missing-variable/unconfirmed orders, dry run, submit variables, verify request/RITM/answer and fulfillment task | Default-blocked pending the separate production flows-delete implementation/live verification, provider-derived Create Catalog Task inputs and complete graph cleanup |
| `workflows.interactive` | Explicit blocked result, never empty success | Integrate existing PTY technique with exact live owned fixture identities and confirmations |

This deliberately does not duplicate the factory CRUD implementation for every resource command. The fixture list imports actual table bindings from `record-command-profiles.js`. It covers different inert schemas without claiming support for all resource families. ACL creation, table creation, active business automation, ticket notifications, host operations and unsupplied dependent products remain outside these mutation fixtures.

## Fixture safety

Context restoration uses the registered `updatesets set <name>` interface, which does not accept a sys_id. Before creating the capture set, the suite reads the original set by its exact saved ID and requires an in-progress record in the original application, a query-safe nonempty name, and exactly one visible name match across applications. Duplicate names, including `Default` in several applications, block without context writes. Originals whose application differs from the effective application also block because `updatesets set` changes both selections. The suite repeats these checks before restoration and verifies both original picker IDs afterward. It never falls back to Default or guesses a duplicate-name winner.

`updatesets create --scope global` already selects the created set. The suite verifies that selection independently instead of issuing a redundant `updatesets set <sys_id>`. Failed selection does not cause a retry. Unresolved write intents or child cleanup prevent restoration and retain the capture context for reconciliation.

- Mutation scenarios declare only PDI mode. The runner must enforce the approved profile and expected host before constructing authenticated clients.
- `runKey` must contain only letters, digits and underscores. Fixture names include the whole key. Exact returned IDs enter `ctx.registerArtifact` before subsequent scenario mutations.
- Missing, truncated, read-only or unfilled mandatory own-table dictionary metadata blocks resource creation. Inherited mandatory fields are still provider-validated. These checks do not prove that a table lacks custom business rules.
- Script fixtures are inactive. The scheduled job is inactive and on demand. The standalone flow only writes its unique marker to the instance log.
- No code deletes by prefix, broad query or table sweep. Cleanup argv includes the exact registered ID.
- A failed or ambiguous write is not retried. Provider reconciliation is required. A failed multi-stage native command can leave an orphan before it returns an identity; that is an outstanding ownership gap, not permission to guess or delete matching names.
- Native `catalogitems create --variable` creates child variables before a caller can checkpoint item ownership and suppresses individual variable errors. This scenario instead checkpoints the native-created item, then uses the supported generic `records create --table item_option_new` command for its child. This is generic JSN support, not an invented catalog variable command.
- `flow_designer_flow` binding uses generic `records update` only after live dictionary metadata establishes a `sys_hub_flow` reference on the owned item.

## Update-set fixture

`workflows.update-set-transfer` writes a private local XML fixture in the same envelope format parsed by the production importer. It contains one synthetic `sys_properties` payload, no scripts and no external destination.

The retrieved set, remote source, member and property IDs are random. The code checks exact target IDs absent and checkpoints planned import/member/effect ownership before loading. The property is created only by native update-set commit. It does not sidestep commit with a Table API insert. The import confirmation denial and unpreviewed commit denial must fail for the expected reason. Preview problems must be untruncated and unresolved count zero; the scenario never auto-accepts conflicts.

Preview/commit each have a 60-second provider timeout and a 75-second CLI bound. Execution polling is bounded and does not retry writes. CLI success, a progress tracker, or accepted dispatch alone never passes an effect assertion.

## Flow and catalog prerequisites

The runner does not currently expose configuration for these two state entries:

- `ctx.state.set('workflows.allowRetainedFlows', true)` is used only by offline synthetic contexts to exercise orchestration. It is NOT a permitted live workaround. The user chose a separate production `flows delete` PR first; leave live flow/catalog creation blocked until that route ships, is verified and complete graph ownership is reviewed. The runner exposes no live flag for this state.
- `ctx.state.set('workflows.catalogRecipe', recipe)` requires target-derived `actionTypeId`, `inputs` and optional `triggerInputs`. Obtain metadata through the real `actions action-type-schema` and `flows schemas` commands. No platform input names or data pills are invented by these acceptance modules.

The catalog recipe must reference the exact published `Create Catalog Task` action. Every supplied input name must appear in the current provider schema, and the fulfillment task must have the unique `$RUN_NAME` as its `short_description` and reference the newly ordered RITM. `$RUN_NAME` is replaced with this scenario's unique name. Synthetic test input names and data pills in `acceptance-workflows.test.js` are fixture behavior, not a published provider recipe.

Even after all effect checks succeed, both flow scenarios record their verified steps in `ctx.state` and throw a blocked result because native flow deletion and full graph cleanup are missing. `--keep` must not turn this into full capability acceptance. Known parent/trigger/action/autosave IDs are registered with null cleanup argv. Never replace this with speculative GraphQL or parent-only Table API deletion. Flow-created snapshots, further autosaves, publish versions and update-set capture members still require complete exact-ID reconciliation.

## Runner integration required before live mutations

The integrated runner offline-proves rules 1–4 below, conservatively retaining the capture set dirty. Provider write intents are checkpointed before dispatch; unresolved allocation/deletion retains the current capture/session selection and blocks further provider mutation. `--keep` performs no object deletion and restores user context only without unresolved write intents. Read-only `ctx.reconcileWrites()` may settle a DELETE by exact-ID absence, never by retrying it. Provider-generated graph/capture ownership (rule 5) remains a live prerequisite; these are not all-complete claims:

1. Preserve the dedicated capture selection while cleaning owned mutable children. Do not restore the user's work set before generic deletion.
2. Exact-ID absence checks must make cleanup idempotent. Resource scenarios intentionally delete their own fixture after checking confirmation denial. Planned XML artifacts may never have been created after an earlier failure.
3. Failed/unavailable child cleanup must retain its parents and dependencies. A missing native flow cleanup command must not authorize deletion of its trigger fixture, catalog item or capture set.
4. Restore original application/update-set selection after child cleanup, including retained-artifact runs. Handle current capture-set deletion specially so no later operation writes into Default or an existing user set. Read both effective pickers back.
5. Persist/read back provider-generated capture members before dependent cleanup. Do not infer that deleting a parent removed every graph or update-set member.
6. Report missing recipe, unavailable provider features, access blocks, assertion failures and unimplemented interactive coverage separately. None count as passing.

The checked-in worker implementation is not authorization to run live until these integration points are reviewed.

## Offline evidence

The new tests run the actual exported scenarios through controlled contexts. They assert context snapshot/restore, every declared resource binding, dictionary refusal, checkpoint ordering, stale readback failure, bounded asynchronous error handling, XML operation order and unresolved-preview stop, full catalog creation/order/fulfillment/variable readback, reverse dependency cleanup argv and retained flow gaps.

The public CLI loopback regression observes exactly `POST`, `PUT`, `DELETE` for its successful resource lifecycle. Unconfirmed delete performs no DELETE, malformed payload performs no POST, a read-only profile produces no request, and a rejected update is not retried. The isolated fixture does not read personal credentials or profiles.

Context loopback regressions run the actual CLI and guarded write journal for Global and scoped originals. The provider fixture enforces exact `name=` queries, simulates application selection resetting the selected set, and verifies restoration to the exact original application and update-set IDs. Real JSON success settles the selection intent; a rejected picker write leaves an uncertain intent and prevents restoration without an automatic retry. Separate refusal cases cover duplicate names, missing or malformed readbacks, unsafe names, changed identity/scope/state, and unresolved children.
