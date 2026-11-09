# Batch apply/delete live proof — PR #416

## Verdict: writes exercised, cleanup complete; full six-family signoff blocked

This is not a claim that every requested family passed. The live run found a real silent-write defect: Table API create returned sys_ids for two UI policy action rows while discarding their parent links. The original engine reported both as created. A pre-existing deny ACL explicitly disables creating `sys_ui_policy_action.ui_policy`, with admin override disabled. Catalog actions inherit that field. The separate ACL parent create returned HTTP 403. No pre-existing ACL, role, update set, credential, or other record was changed to work around these restrictions.

The engine fix reads supplied parent links and integer fields back by sys_id before releasing outputs. Failed post-write verification retains the sys_id and `created_unverified` / `updated_unverified`, and blocks descendants. It does not promise equality for every business-rule-normalized string or boolean. The fix was exercised live with an invalid integer child, and covered by eight new regression tests.

Instance: https://tygrllcdemo5.service-now.com; profile: `demo`; marker: `HOLLY-BATCH-1793991459`.
Capture set: `Default`, `def2e6fb87833110eb5e8489cebb355f`, Global, in progress. The audit hook checked the effective UI picker before every write and refused any other capture set. It allowed only POST/DELETE on the bounded tables and only deletion of sys_ids returned by this run. NullEdge Pass was not selected or changed.

## Acceptance status

| Requirement | Observed result |
|---|---|
| Dependency-ordered create | 17 six-family records created; the additional ACL parent failed and its m2m child was skipped. Transport proves each created parent response preceded its child request. |
| Persisted parent links and fields | Catalog variables, catalog client script, data policy rule and the entire SP hierarchy resolve correctly. Both UI action parent fields are blank; catalog action variable link is also blank. Full success is blocked. |
| Exact reverse deletion | All 23 returned create sys_ids were deleted in the exact reverse global transport order, checked programmatically. 21 used batch plan/apply, two malformed orphan actions needed explicit owned-sys_id cleanup. Therefore one whole six-family batch delete cannot be signed off. |
| Failure injection | Fixed engine: 1 created, 1 failed with recoverable sys_id, 2 skipped descendants. Both persisted records subsequently deleted and verified absent. |
| Receipt gate | Missing receipt plus changed manifest, prepared payload and bound instance all refused with exit 2. |
| ACL family | Role reads work; ACL creation is forbidden (HTTP 403), so m2m creation is not live-proven. |

## Created records and actual readback

Names below omit the common run prefix. `create-readback.json` retains the actual GET-by-sys_id responses. Its original `checks` field predates normalization of Table API reference objects; `live-summary.json` recomputes comparisons from raw `.value` fields and is authoritative for the normalized analysis.

| Step | Table | Created sys_id | Persisted parent reference(s) |
|---|---|---|---|
| f0_item | `sc_cat_item` | `70769bcb3bdc1f10531d2a8693e45a71` | — |
| f0_variable | `item_option_new` | `1d76dbcb3bdc1f10531d2a8693e45a10` | `cat_item=70769bcb3bdc1f10531d2a8693e45a71` → f0_item OK |
| f1_item | `sc_cat_item` | `2976dbcb3bdc1f10531d2a8693e45a36` | — |
| f1_policy | `catalog_ui_policy` | `7976dbcb3bdc1f10531d2a8693e45a55` | `catalog_item=2976dbcb3bdc1f10531d2a8693e45a36` → f1_item OK |
| f1_variable | `item_option_new` | `b176dbcb3bdc1f10531d2a8693e45a9c` | `cat_item=2976dbcb3bdc1f10531d2a8693e45a36` → f1_item OK |
| f1_action | `catalog_ui_policy_action` | `4e76dbcb3bdc1f10531d2a8693e45ad5` | `ui_policy=(blank)` → f1_policy FAIL; `catalog_variable=(blank)` → f1_variable FAIL |
| f2_item | `sc_cat_item` | `c2769bcb3bdc1f10531d2a8693e45a46` | — |
| f2_script | `catalog_script_client` | `1e76dbcb3bdc1f10531d2a8693e45aba` | `cat_item=c2769bcb3bdc1f10531d2a8693e45a46` → f2_item OK |
| f3_policy | `sys_ui_policy` | `9a761fcb3bdc1f10531d2a8693e45a4b` | — |
| f3_action | `sys_ui_policy_action` | `56761fcb3bdc1f10531d2a8693e45a1b` | `ui_policy=(blank)` → f3_policy FAIL |
| f4_policy | `sys_data_policy2` | `a2761fcb3bdc1f10531d2a8693e45a72` | — |
| f4_rule | `sys_data_policy_rule` | `a2761fcb3bdc1f10531d2a8693e45aca` | `sys_data_policy=a2761fcb3bdc1f10531d2a8693e45a72` → f4_policy OK |
| f5_page | `sp_page` | `b2761fcb3bdc1f10531d2a8693e45ae3` | — |
| f5_container | `sp_container` | `b6761fcb3bdc1f10531d2a8693e45a57` | `sp_page=b2761fcb3bdc1f10531d2a8693e45ae3` → f5_page OK |
| f5_row | `sp_row` | `c3761fcb3bdc1f10531d2a8693e45aed` | `sp_container=b6761fcb3bdc1f10531d2a8693e45a57` → f5_container OK |
| f5_column | `sp_column` | `43765fcb3bdc1f10531d2a8693e45a0f` | `sp_row=c3761fcb3bdc1f10531d2a8693e45aed` → f5_row OK |
| f5_instance | `sp_instance` | `5b761fcb3bdc1f10531d2a8693e45a2a` | `sp_column=43765fcb3bdc1f10531d2a8693e45a0f` → f5_column OK |

Non-link normalizations observed: the SP page id was lowercased and punctuation converted to underscores; the container name was generated from its page title and order. These are retained as differences, not incorrectly claimed as exact string equality. `public=false`, `draft=true`, inactive policies/items/variables/scripts/instance and all other supplied fields are visible in the captured readbacks. The page was not linked to any portal. Action rows without writable names are identified by run-prefixed manifest step names and owned parent lineage; SP row/column class names carry the run marker.

## Create order versus delete order

Initial create order:

f0_item → f0_variable → f1_item → f1_policy → f1_variable → f1_action → f2_item → f2_script → f3_policy → f3_action → f4_policy → f4_rule → f5_page → f5_container → f5_row → f5_column → f5_instance

Initial records were deleted in the exact reverse of that order. The first exploratory integer attempt then created four more records; the fixed failure attempt created two persisted records (one verified and one failed verification). Across all three attempts the complete orders are:

Create: f0_item → f0_variable → f1_item → f1_policy → f1_variable → f1_action → f2_item → f2_script → f3_policy → f3_action → f4_policy → f4_rule → f5_page → f5_container → f5_row → f5_column → f5_instance → fail_page → fail_container → fail_row → fail_column → bad_page → bad_container

Delete: bad_container → bad_page → fail_column → fail_row → fail_container → fail_page → f5_instance → f5_column → f5_row → f5_container → f5_page → f4_rule → f4_policy → f3_action → f3_policy → f2_script → f2_item → f1_action → f1_variable → f1_policy → f1_item → f0_variable → f0_item

The full 17-record delete plan initially refused before writing:

    Step "HOLLY-BATCH-1793991459-f3_action" (ui_policy_action): Delete parent mismatch at ui_policy; no writes performed.

Cleanup did not falsify those relationships or weaken deletion validation. It split valid contiguous reverse-order segments into five batch plan/apply operations across the three attempts and deleted the two exact known orphan sys_ids explicitly at their positions in the reverse order. Saved `*-cleanup-*-receipt.json`, `*-cleanup-*-apply.stdout`, `cleanup-results.json` and `transport.jsonl` show the real operations. Every batch delete performed an immediate empty-array absence query before allowing ancestors; no DELETE error was recorded.

## Failure injection

The child `bad_container` used `order: 9007199254740991`, a JSON integer outside the instance integer range. An exploratory run before integer verification accepted four writes; it is preserved as `failure-*`, not hidden or relabelled as a successful failure test. With readback verification enabled, `failure2-*` records the actual nonzero partial result:

| Step | Outcome | sys_id |
|---|---|---|
| bad_page | created | `29a713033b509f10dc18ea64c3e45a8a` |
| bad_container | failed / created_unverified | `a5a713033b509f10dc18ea64c3e45aa6` |
| bad_row | skipped | `—` |
| bad_column | skipped | `—` |

Actual child error:

    Write readback mismatch at order; record sp_container/a5a713033b509f10dc18ea64c3e45aa6 may exist. Inspect and clean up before retrying.

No sp_row or sp_column POST followed the failed child. Their skipped reasons identify the failed dependency and its propagation to the grandchild. The plan listed four creates; result counts distinguish one verified create, one failed persisted write, and two skipped writes. The failed row retained its sys_id instead of becoming an untracked orphan claiming success. Batch cleanup deleted the container before the page; final GET queries show both absent.

Additional exploratory attempt sys_ids (all also deleted):

- fail_page: `sp_page/0e5757cf3b109f10dc18ea64c3e45a7c`
- fail_container: `sp_container/9e5797cf3b109f10dc18ea64c3e45acb`
- fail_row: `sp_row/9e57db4f3b109f10dc18ea64c3e45a26`
- fail_column: `sp_column/925797cf3b109f10dc18ea64c3e45adb`

## Plan receipt refusals

All commands used the real CLI with `--profile demo --json --force` and exit 2. `gate-results.json`, individual stdout/stderr and status files retain the evidence. Payload and instance variants had recomputed valid checksums, so their rejection exercises fresh-plan comparison rather than merely detecting a damaged hash. The instance variant is an intact receipt bound to a different URL; no request was sent to that other URL.

- missing: `Missing required argument: --plan`
- manifest: `Batch plan is stale or does not match this manifest/instance. Re-plan before applying.`
- payload: `Batch plan is stale or does not match this manifest/instance. Re-plan before applying.`
- instance: `Batch plan is stale or does not match this manifest/instance. Re-plan before applying.`

## ACL family verdict and underlying queries

The earlier role-visibility gap does not reproduce. Exact query:

    GET /api/now/table/sys_user_role?sysparm_query=name%3Ditil&sysparm_limit=3&sysparm_fields=sys_id%2Cname

    {"result":[{"sys_id":"282bf1fac6112285017366cb5f867469","name":"itil"}]}

Unfiltered and `name=admin` queries also return readable roles (`preflight.json`). The historical no-row result alone does not establish that the old query was wrong; the current family cannot be excluded on that basis.

An inactive run-marked ACL parent was attempted through the batch engine:

    POST /api/now/table/sys_security_acl
    {"name":"HOLLY-BATCH-1793991459-inert","operation":"read","type":"record","active":false,"advanced":false,"admin_overrides":true}
    forbidden: Access forbidden (HTTP 403).

Its acl_role step was skipped, and no role assignment was made. Querying `sys_security_acl` with `nameSTARTSWITHHOLLY-BATCH-1793991459` returns `{"result":[]}` (`acl-absence.json`, repeated in marker-residue). `acl-create-permissions.json` records existing create deny rules with `admin_overrides=false`. This is a concrete write-permission blocker on this profile, not missing schema or unreadable roles; no claim is made that a different identity/elevation would behave the same.

The UI policy action restriction is independently visible at:

    GET /api/now/table/sys_security_acl/0dc190923712210066512f3c8e41f18b

Its response names `sys_ui_policy_action.ui_policy`, operation `create`, `decision_type=deny`, `admin_overrides=false`, active true, description `Disable create on ui_policy field` (`ui-policy-field-create-acl.json`). No ACL bypass or pre-existing ACL change was attempted.

## Cleanup proof

- 23 create responses with readable sys_ids; 23 DELETE requests; 23 independent final empty-array sys_id queries.
- 21 batch deletes; 2 explicit owned-orphan deletes.
- Exact reverse global create/delete ordering is asserted by `cli/scripts/summarize-batch-live.mjs`.
- `final-absence.json`: all 23 exact sys_id queries returned `{"result":[]}`.
- `marker-residue.json`: 12 marker searches returned empty arrays, including skipped SP descendants and the forbidden ACL parent. Actions/rules without name fields are additionally covered by exact sys_id absence.
- No known run-created content record remains. The existing Default update set was used for normal platform capture; platform-managed audit/update history was not purged. No claims are made that normal server audit history is absent.

## Tests and verification

- Focused batch: 140 tests, 140 pass, 0 fail (`focused-tests.log`).
- First-run/help: 42 tests, 42 pass, 0 fail (`help-tests.log`).
- Commands run from cli/: `node --experimental-test-module-mocks --test test/batch*.test.js test/sdk-batch.test.js`; `node --experimental-test-module-mocks --test test/first-run-welcome*.test.js test/*help.test.js`.
- Full suite: root `npm test`, both exit 1 due to the same environmental failures below. Baseline main is pinned to `2f47f0f991d25a27d794807e5c933a2ce2f18a85`; branch starting commit is `142b286cbc2ba1be8e8cd3c59ffa3dde30278f98` plus this patch.
- Branch: 2116 tests, 2104 pass, 10 fail. Main: 1993 tests, 1981 pass, 10 fail. Each skips two opt-in integration tests.
- Exact failing names compared programmatically: no new failures and no resolved failures (`suite-comparison.json`; raw branch-suite.log/main-suite.log).
- `npm run lint`: exit 0. `git diff --check`: exit 0. All three proof scripts passed `node --check`.
- No TypeScript or CLI build command exists. The executable CLI was exercised live; `npm pack --dry-run --json` from cli/ succeeded (`package-dry-run.json`). This is a packaging check, not a claim that an unavailable build command ran.
- `npm audit --json`: two moderate dev-dependency findings (minimatch and @stryker-mutator/core), identical on main. No dependency change or forced audit fix was made.

New regression tests:

- create: silently discarded parent is failed with recoverable id and descendants skipped
- update: silently discarded parent is failed with recoverable id and descendants skipped
- coerced out-of-range integer fails instead of publishing child outputs
- unreadable persisted child (missing) retains id and blocks descendants
- unreadable persisted child (throw) retains id and blocks descendants
- raw reference values, not display names, verify correctly before descendants write
- UI action 201 echo with blank persisted links is not success
- silent parent-field discard exits partial with the created id retained for cleanup

Full-suite failing names on both revisions:

- Linux installer announces download and extraction phases before the silent runtime start
- ZIP extraction refuses pre-existing symlink escape and metadata cannot claim another MID
- a crash between start and verification reconciles state instead of reporting success
- collision and unsupported-platform preflight never downloads or changes existing files
- failed extraction and ACL preparation clean up only newly created installation
- failed native start retains an uncertain runtime and refuses cleanup when stop fails
- native extraction rejects traversal and symlink ZIP entries before writing payload files
- real isolated Linux launcher prepares private XML, starts, stops and removes only its owned directory
- static native runner executes read-only Linux preflight without creating remote paths
- static runner extracts a bounded vendor fixture, protects config, reads logs and removes only owned files

## Remaining operator decision

The requested fully successful UI action and ACL family proof remains blocked by instance permissions. Changing a pre-existing deny ACL, roles, credentials, or access policy is outside this task's bounds and was not done. A separately authorized compatible test identity/instance or sanctioned native creation path is needed to close those acceptance checks. The PR was not merged.

## Evidence handling

Transport evidence stores method, endpoint, payload, returned sys_id, row counts and errors, never auth headers or credentials. All sources and raw evidence are retained alongside this report. The helper is deliberately demo-scoped and opt-in; do not replay creates. Generate and inspect fresh receipts for any new authorized run.
