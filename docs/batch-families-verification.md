# PR 416 batch families: verification and remaining gate

## Result and authorization boundary

Phase A was committed and normally pushed as ccc09a67d9c18da24de89e8929e9daa007c29bb9.
GitHub readback reported MERGEABLE at that exact head, after an initially stale
post-push response still showed the old head. No force push and no PR merge.

Phase B implements seven requested families (including the existing variables
family), through 14 new adapters. Dictionary overrides are explicitly skipped.
Live schema discovery and a multi-family plan ran against authenticated demo at
https://tygrllcdemo5.service-now.com. No instance artifact was created, updated or
deleted. The task explicitly also says demo is read-only within this task, which
conflicts with the later requested live apply-and-cleanup. That live write trial
is NOT completed or claimed: Jace must lift the read-only restriction for a
bounded create/readback/delete trial. There is consequently no live cleanup
claim; this task created no live artifacts to clean up. Unit transport deletion
readbacks are not being presented as live evidence.

## Phase A merge and fixture

Only docs/DECISIONS.md had a textual conflict: append-only independent batch
sections and main's AMB/watcher/store/recovery/welcome decisions were all retained.
cli/src/cli.js and output.js merged without textual conflicts; their resulting
surfaces were reviewed to retain batch registration, main's new commands and
structured batch failure details. The root's manually grouped help needed a
batch entry in cli/src/help.js, not merely CLI parser registration.

First-run fixtures were regenerated through runCli/spawnSync, with complete JSON
parsing (not a shell pipe). The committed Phase A fixture values are:

help/quiet/csv/markdown/get: 12119 bytes, SHA-256 9ac6f6a9d8d246cc2ae1fb13ce94dfe8c2774e9ff5c3b25a6a0cf16444bff653; JSON: 117229 bytes, SHA-256 7a9cf40bd1f16a1748207c57073af64cf5b6452e38802348d905e7b56abf9a33; commands: 88.

Phase A suite: {"tests":2031,"pass":2019,"fail":10,"skipped":2}. Both explicitly requested welcome suites
passed. The ten full-suite failures match pinned main by exact test name.

Phase B intentionally changes batch's description/options. Its refreshed fixture:

help/quiet/csv/markdown/get: 12118 bytes, SHA-256 e6b1f88ff829e9661822d284ae38b4c27e26e008484f9ac454a964a7edf83096; JSON: 117205 bytes, SHA-256 dec6fe5ba0f636bc1334108a14e4154735bbb84b757433187ce3a8d5a256d63f; commands: 88.

## Live verified mappings, before adapter implementation

sys_db_object confirmed the tables; sys_dictionary supplied exact field names,
reference targets and types, with raw values (not display labels). A second
query verified data policy2, and raw super_class.name queries confirmed the
catalog inheritance from sys_ui_policy, sys_ui_policy_action, sys_script_client.
The checker also verifies every new adapter field, not just relationship fields:
98 field declarations across 14 adapters.

| Child table | Parent column / selector | Dictionary reference / type | Declared on | Dictionary row sys_id |
|---|---|---|---|---|
| item_option_new | cat_item | sc_cat_item / reference | item_option_new | ce33e63f87833110eb5e8489cebb35c0 |
| catalog_ui_policy | catalog_item | sc_cat_item / reference | catalog_ui_policy | b723663f87833110eb5e8489cebb35c6 |
| catalog_ui_policy_action | ui_policy | sys_ui_policy / reference | sys_ui_policy_action | 8b4b9a7387033110eb5e8489cebb352c |
| catalog_ui_policy_action | catalog_variable | (not a reference) / string | catalog_ui_policy_action | 3323663f87833110eb5e8489cebb35be |
| catalog_script_client | cat_item | sc_cat_item / reference | catalog_script_client | 83336a3f87833110eb5e8489cebb350c |
| sys_security_acl_role | sys_security_acl | sys_security_acl / reference | sys_security_acl_role | 954b1a7387033110eb5e8489cebb3556 |
| sys_ui_policy_action | ui_policy | sys_ui_policy / reference | sys_ui_policy_action | 8b4b9a7387033110eb5e8489cebb352c |
| sys_data_policy_rule | sys_data_policy | sys_data_policy2 / reference | sys_data_policy_rule | 324b5a7387033110eb5e8489cebb35e6 |
| sp_container | sp_page | sp_page / reference | sp_container | 4645a27787c33110eb5e8489cebb3558 |
| sp_row | sp_container | sp_container / reference | sp_row | 3545a27787c33110eb5e8489cebb3540 |
| sp_column | sp_row | sp_row / reference | sp_column | 5a45a27787c33110eb5e8489cebb35c5 |
| sp_instance | sp_column | sp_column / reference | sp_instance | b045627787c33110eb5e8489cebb354f |

Catalog UI policy actions inherit ui_policy, which references the base
sys_ui_policy table; catalog_ui_policy extends that table. Existing live action
rows have catalog_variable values prefixed IO:, and their inherited field is
empty; adapters therefore require steps.variable.catalog_variable rather than
inventing a raw-ID relationship or using the inherited field as the variable
selector. The declared output format is IO:<sys_id>.

Data policies are sys_data_policy2, not sys_data_policy. Its child is
sys_data_policy_rule.sys_data_policy; rules require table and field.

Portal instances have no direct page parent: use
sp_page -> sp_container.sp_page -> sp_row.sp_container -> sp_column.sp_row ->
sp_instance.sp_column. sp_instance.sp_widget names an existing widget. Only this
verified layout chain is supported, not arbitrary SP subclasses/nested layouts.

The live sys_dictionary_override table exists, but its selectors are base_table,
name and element (table_name/table_name/string), not a reference to a dictionary
entry. No dictionary parent-reference column exists in the returned complete
field set. Per the task's skip-if-different rule, no guessed adapter was added.

sys_user_role returned no readable rows both unfiltered and with name=itil, so
ACL-role support is schema-confirmed and unit-tested but excluded from the live
multi-family plan; no role sys_id was invented. sys_security_operation and
sys_security_type did return read and record as their keys, respectively.

Reproduce the field check from the retained raw captures:

    node cli/scripts/check-batch-schema.mjs /home/jace/work/jsn-batch-live-fields.json /home/jace/work/jsn-batch-live-data-fields.json

Machine-readable selected schema evidence: verification/batch-families-schema.json.
Raw discovery envelopes remain at /home/jace/work/jsn-batch-live-*.json.

## Actual live multi-family plan

Exit 0; {"steps":17,"creates":17,"updates":0,"deletes":0,"writes":0}; writes_performed=false.
An SDK request guard blocked non-GET methods and recorded 5 GETs:
- GET /api/now/table/sys_user
- GET /api/now/table/sys_user_preference
- GET /api/now/table/sys_user_preference
- GET /api/now/table/sys_update_set/def2e6fb87833110eb5e8489cebb355f
- GET /api/now/table/sys_scope/global

Plan ID: 1a8b9b241d9f360711cc1ca914880a265d5a516912479a68c34d2f60a76dd112

Order:

    f0_item -> f0_variable -> f1_item -> f1_policy -> f1_variable -> f1_action -> f2_item -> f2_script -> f3_policy -> f3_action -> f4_policy -> f4_rule -> f5_page -> f5_container -> f5_row -> f5_column -> f5_instance

Full CLI JSON output: verification/batch-families-plan.json.
Exact manifest: verification/batch-families-manifest.json (NOT applied; no replay
approval is implied). The existing widget ID was obtained by a live read.
The plan contains six families; ACL-role rows were excluded for the visibility
limit above, and dictionary overrides are not implemented.

## Tests and independent checks

Pinned main: 2f47f0f991d25a27d794807e5c933a2ce2f18a85. Main remained at this SHA when checked again after
implementation. Failures were compared programmatically by exact name, not count.

- Main: {"tests":1993,"pass":1981,"fail":10,"skipped":2}.
- Phase B: {"tests":2108,"pass":2096,"fail":10,"skipped":2}.
- Focused batch tests: {"tests":115,"pass":115,"fail":0,"skipped":0}.
- Explicit first-run-welcome + first-run-welcome-matrix: {"tests":34,"pass":34,"fail":0,"skipped":0}.
- npm run lint: exit 0. Helper eslint: exit 0. git diff --check: exit 0.
- No CLI build or type-check script exists (ESM JavaScript, no compile step).
  npm pack --dry-run and actual npm pack both exited 0; this is package validation,
  not a claim that a nonexistent compiler/build ran. The docs site is separate.
- npm audit: unchanged 2 moderate development
  findings (minimatch and @stryker-mutator/core) on both branch and main. Production
  audit with --omit=dev exited 0 with no vulnerabilities. No dependency changes.

Per-family test suite prefix: batch family: <name>, for catalog variables,
catalog UI policies and actions, catalog client scripts, ACL roles, UI policy
actions, data policy rules, Service Portal layout and instances. Each asserts:

- exact create plan, order and zero writes
- exact update plan, order and zero writes
- exact delete plan, order and zero writes
- resolves symbolic parents and exact prepared payloads on create
- updates parents before children with resolved references
- failed parent skips children without orphan writes
- deletes children first and proves every target absent
- failed child deletion blocks ancestors
- rejects malformed schema, literal parents and unrelated delete targets

Additional tests cover missing/tampered/stale/wrong-instance receipts; malformed
absence readbacks; mixed destructive edges; unsupported dictionary mapping;
CLI --plan enforcement; per-step read-only/context guards; and schema evidence
checker missing/type/reference errors. Exact JSON plans are compared as complete
objects (payloads, targets, pending refs, outputs, notes, counts, order, plan ID),
not just substring assertions. See cli/test/batch-families.test.js,
batch-cli.test.js, batch-engine.test.js, batch-manifest.test.js and
batch-schema-evidence.test.js.

Identical pre-existing failures on branch and main:

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

The measured errors concern writable installation ancestors and Linux preflight
fixture expectations. This execution environment actually has Python 3 and a
non-root jace account; the task's environment description was not used as proof
of a failure's cause. Captured test output, not an assumed cause, establishes the
baseline. No tests were weakened or disabled.

Full raw evidence on this host:

- /home/jace/work/jsn-batch-suite-main.log
- /home/jace/work/jsn-batch-suite-A.log
- /home/jace/work/jsn-batch-suite-B.log
- /home/jace/work/jsn-batch-target-B.log
- /home/jace/work/jsn-batch-welcome-A.log
- /home/jace/work/jsn-batch-welcome-B.log
- /home/jace/work/jsn-batch-audit-main.json
- /home/jace/work/jsn-batch-audit-B.json
- /home/jace/work/jsn-batch-audit-production.json
- /home/jace/work/jsn-batch-live-plan-requests.jsonl

## Remaining acceptance gate

Live create/readback/reverse-delete/absence is blocked by the read-only scope,
not replaced with mocked evidence. Confirm explicit permission to make bounded
inert test records on demo, then verify allowed tables/ACLs, inspect a fresh plan,
apply, read back exact relationships, generate and inspect reverse-delete plan,
apply cleanup and query every created ID for absence. No PR merge is authorized.
