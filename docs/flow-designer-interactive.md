# Flow Designer interactive commands

## Terminal contract

Use a human terminal with `auto` output. Run `jsn actions create` or
`jsn flows create` without JSON data to start a wizard. Use
`jsn actions edit` or `jsn flows edit` to pick an existing target and edit it.

Record selection uses the shared paginated, searchable `interactiveList`.
Picker Escape, wizard Ctrl+C and refusing the final save return without writes.
Parent allocation, autosave, testing, publication and deletion do not occur
until the relevant confirmation. Explicit `--force` confirms existing mutation
commands, but does not bypass the creation wizard's final save confirmation.

`--json`, explicit non-auto formats, `--get`, `--data`, `--data-file`,
`--output-map`, pipes, `CI`, `NONINTERACTIVE` and `JSN_NO_PROMPTS=1` disable the
new wizard and target-picking paths. Missing required values produce a
`usage_error` JSON envelope with exit status 2 in JSON/auto-pipe mode. Existing
commands elsewhere retain their legacy usage-error rendering.

Explicit action definitions still go unchanged to the existing SDK lifecycle.
Explicit flow manifests still use the existing validation, GraphQL patch,
autosave versioning and readback. New scope selection offers the active raw
application ID before a scope picker and validates the selected ID. Existing
target scope checks remain unchanged. No credential, ACL, role or instance
setting changes are made by these wizards.

## Coverage matrix

`action` aliases `actions`; `flow` aliases `flows`. The rows below cover every
existing subcommand, including retained aliases.

| Command | Human terminal | Scripted path and safety | Local proof |
| --- | --- | --- | --- |
| `actions` | Existing command summary | Output controller summary retained | Command registration |
| `actions list`, `ls` | Existing searchable list/show picker | Existing query, fields and output behavior retained | Existing list tests |
| `actions show`, `get` | Omitted identifier picks an action | Explicit identifier unchanged; omission fails fast | Handler cancellation and binary usage checks |
| `actions definition` | Pick action, read full definition and executable steps | Exact scope inference/validation, read-only | PTY Escape; SDK definition/readback tests |
| `actions step-types` | Pick scope or accept its current raw ID | Explicit `--scope` remains supported, read-only | Real PTY scope picker; SDK endpoint test |
| `actions create` | Scope/name, live step schemas, typed inputs, script file/editor, script outputs, output mappings, final confirmation | Existing full JSON + explicit scope supported; fresh parent allocation and complete PUT; no publish/test | Real PTY successful creation, refusal and Ctrl+C; SDK-backed wizard unit tests with variables/mappings |
| `actions update`, `edit` | Pick action, load full saved definition; edit name/description, input defaults/required flags, output mappings, step inputs/scripts/mappings; confirm save | Supplied full definitions unchanged; target lifecycle identities and unknown nested fields retained | Real PTY script-file edit; SDK-backed preservation and cancellation tests |
| `actions test` | Pick action, prompt from saved input schemas, explicitly confirm execution | Explicit saved/supplied definition and output-map supported; force/confirmation and read-only guards; wait/output contract retained | PTY required input and refusal; dispatch argument tests; existing SDK wait/error/output tests |
| `actions delete` | Pick action, validate scope, confirm existing parent cleanup | Existing parent deletion plus exact absence readback; not a new native builder deletion lifecycle | PTY refusal; existing deletion scope/absence tests |
| `flows` | Output-controller command summary | JSON envelope instead of raw console output; no default mutation | Root output-envelope test and help checks |
| `flows list`, `ls` | Existing flow picker and inspection | Existing query/fields/depth and JSON behavior retained | Existing command/output tests |
| `flows executions`, `runs`, `contexts` | Existing executions report | Existing filtering/aggregation behavior unchanged; read-only | Existing execution/context tests |
| `flows show`, `get` | Omitted identifier picks a flow | Explicit name/ID inspection unchanged | Handler cancellation, binary usage and existing inspection tests |
| `flows status` | Pick flow and read readiness | Explicit identifier and diagnostic contract retained | Handler cancellation; existing status tests |
| `flows publish`, `activate` | Pick flow, or action with `--action`; explicitly confirm activation | Requires explicit force or existing profile skip-confirmations when prompts unavailable; lifecycle unchanged | PTY refusal; existing lifecycle/version readback tests with force |
| `flows test` | Pick flow, derive actual record-trigger table and provider display field, pick a record, confirm | Explicit identifier/record supported; no guessed table; read-only and execution confirmation retained | PTY record picker and refusal; trigger-table picker unit test; existing exact test-envelope tests |
| `flows doctor` | Existing read-only health report | No mandatory arguments added | Existing health-check tests |
| `flows create` | Name, scope, then trigger CATEGORY and trigger, then that trigger's declared inputs, then published action schemas and inputs, final confirmation | Every declared trigger input is written from the instance's own `sys_hub_trigger_input` rows; the trigger is INSERTED by the same patch as the actions; inactive Draft, Autosave and readback only | Real PTY category-then-trigger picker for the record and scheduled families, trigger/action/value readback and version; unit tests for catalog grouping, declared-input assembly, unsupported-family exclusion and cancellation |
| `flows update`, `edit` | Pick inactive Draft, load saved definition; change trigger condition or an existing action input, confirm | Existing trigger/table/action-input update manifest retained; domain protects `jace-test-flow`; unspecified fields preserved | Real PTY confirmed trigger edit; input/type-discovery wizard tests; existing patch-preservation/version tests |
| `flows delete` | Pick a target, then report unsupported | Still unsupported; no GraphQL deletion invented | Omission/cancellation and read-only gates; unchanged unsupported handler |

## Limits and unverified behavior

This change has no live-instance write or execution evidence. All automated
persistence tests use disposable in-memory providers. PTY tests run real
Inquirer prompts and the real CLI adapter, and some traverse the real SDK
lifecycle, but that is not proof of ServiceNow persistence.

Independent live verification must use disposable actions/flows and read back
parent, executable steps, scripts, mappings, versions, runtime outputs and
update-set capture. Do not modify or run existing live flows/actions just to
verify this UX. Keep `jace-test-flow` protected.

The action wizard accepts provider step schema arrays and their `step_types` or
`stepTypes` envelopes. It does not supply a built-in guessed Script template.
Variable templates come from returned schemas. Scalar strings/references,
choices, numbers, booleans, document IDs, nested objects with child schemas and
scripts are guided. Other complex/secret types are not silently skipped; use a
complete JSON definition when the wizard reports an unsupported type. Provider
schema/version differences and configured external editors still need live
verification. Script-file UX is exercised in a real PTY; editor selection is
not an end-to-end editor-platform test.

Flow creation supports the trigger families this CLI has live-verified:
`record_create` / `record_update` / `record_create_or_update`, `daily` /
`weekly` / `monthly` / `repeat` / `run_once`, and `email` /
`knowledge_management` / `service_catalog` / `sla_task` /
`remote_table_query`. The picker's categories and members come from the
instance (`sys_hub_trigger_category` and each definition's own `category`
reference) intersected with that verified set, so a family that is offered is a
family that can actually be created; anything else is reported in
`trigger_guidance.excluded_families` rather than silently hidden. Each trigger's
inputs are read from `sys_hub_trigger_input` (the owning definition is the
`var__m_sys_hub_trigger_input_<definitionId>` name suffix) and every declared
input is written, using the instance's own default where the operator supplies
nothing. Predicate metadata is derived by the instance from the `condition`
input, not rebuilt by this CLI. Trigger/action persistence, input values and the
Autosave version have been read back from a live instance; publish/activation,
execution and deletion remain out of scope. Guided flow editing offers the
condition and existing action inputs, not every field that the scripted update
manifest supports. Flow Logic, subflows, variables,
error handling and native flow deletion remain unsupported. Action step
insertion/removal during guided edit is not implemented; use the existing full
JSON update path for schema-supported definition changes.

## Reproduce local verification

```bash
node --experimental-test-module-mocks --test test/flow-designer-interactive.test.js test/flow-designer-pty.test.js test/actions.test.js test/flows-command.test.js test/flow-create.test.js test/flow-test.test.js test/sdk-processflow-actions.test.js
npm test
npm run lint
git diff --check
node bin/jsn.js actions create --help
node bin/jsn.js flows edit --help
```

PTY tests require Python 3 and Unix PTYs and explicitly skip when unavailable.
Python is a test driver only, not a JSN runtime dependency. No dependencies,
package version or lockfile are changed.
