---
title: CLI guide
---

The command surface, discovery paths and conventions for finding the right command before using it.

## JSN CLI guide

A command-line interface for ServiceNow. Type `jsn` and start working — no web UI needed.

Works standalone or with AI agents (Claude Code, OpenCode, Hermes, Cursor, Copilot).

## Install

```bash
npm install -g @jacebenson/jsn
```

Current Node.js LTS release. macOS, Linux, Windows.

The install also copies an AI agent skill file to `~/.agents/skills/servicenow/SKILL.md`.

### Install from GitHub (test unreleased builds)

The publishable package lives in `cli/`, not the repository root. To test an
unreleased branch, clone the repository, check out the exact branch or revision,
and install its dependencies before running the checkout's executable:

```bash
git clone https://github.com/jacebenson/jsn.git
cd jsn
git checkout <branch-or-revision>
npm --prefix cli ci
node cli/bin/jsn.js version
node cli/bin/jsn.js --help
```

For the published development channel, use `npm install -g @jacebenson/jsn@dev`.
To install a checkout globally, run `npm install -g ./cli` from the repository
root. Direct `github:jacebenson/jsn#<branch>` installs address the private root
package and do not install the CLI.

Go back to the released version with:

```bash
npm install -g @jacebenson/jsn
```

Requires Node.js 24 or newer. SQLite is built into Node.js, so npm and git installs do not need Python, make, or a C++ compiler. Local docs indexing/search requires FTS5 in the installed Node build and checks this at runtime. Use a current official Node.js 24 LTS or newer build if FTS5 is unavailable. Hosted docs search does not load SQLite.

## Document instance configuration

Generate an offline Markdown report with restrained Mermaid diagrams from the
explicitly selected profile. Read-only profiles work. This workflow reads metadata,
not business records, and does not modify provider data. Normal authentication may
bootstrap a session or refresh local OAuth credentials.

```sh
jsn document instance --profile development --output instance-configuration.md
jsn document instance --profile development --json
jsn document instance --profile development --get data.sources
jsn document instance --profile development --format markdown
```

`--output` creates a new file with owner-only mode `0600` on POSIX. On Windows,
the file inherits directory ACLs; choose a private directory with appropriate
access restrictions. Node does not implement POSIX owner/group/other permission
distinctions on Windows. Existing files, directories and symlinks are refused
without overwriting. The parent directory must already exist.
Invalid budgets and existing destinations are rejected before instance reads.
JSON includes the projected evidence and Markdown. `--get data.markdown --raw`
extracts the rendered report. Identical saved evidence renders identically offline;
new collection timestamps naturally differ between runs. No AI or remote assets
are required. A Markdown viewer must support Mermaid to draw the optional diagrams.

| Budget | Default | Accepted range |
| --- | --- | --- |
| `--page-size` | 25 | 1–100 rows per request |
| `--discovery-pages` | 2 | 1–5 application discovery pages |
| `--applications` | 3 | 1–6 selected applications |
| `--detail-pages` | 1 | 1–3 pages per detail source |
| `--max-requests` | 96 | 1–200 Table API requests, including dictionary reads |

Discovery uses application records and exact scope/package references, never an
application-name or namespace-prefix filter. Distinct apps sharing a namespace
remain separate. A representative Global application and scoped application are
selected first, then remaining identities in stable order within the budget.
Store/vendor class is not evidence of customer authorship. Missing, conflicting or
unknown ownership remains unresolved rather than being merged into Global.
Unassigned Global `u_` tables are separate development leads, not proof of shipped
baseline changes. At most two returned Global leads receive detail.

Selected sections cover table/field definitions, direct rules, client scripts, UI
policies/actions, Script Includes, flow metadata, portal pages/widgets, REST/SOAP
message names/active flags and scheduled-script names/active/run-type metadata.
Exact target matches are configured applicability, not executed behavior. Portal
page-to-widget diagrams require dictionary-verified references through container,
row, column and instance records. Ordinary layout children stay in supporting
tables. At most 20 collapsed page/widget relations per app are drawn.

Every source receipt retains its actual query, selected fields, observation time,
page bounds, returned count, continuation and reasons. All inventories remain
incomplete with unknown completeness because no provider count is collected.
Short or empty pages do not prove exhaustion. ACL denial, unavailable/malformed
sources, missing fields, duplicate records and budget truncation remain explicit;
one source gap does not erase the others. Partial evidence exits successfully,
with `data.status` equal to `incomplete`. Authentication, server and transport
failures exit nonzero instead of manufacturing empty evidence.

Scripts, conditions, defaults, endpoints/URLs, secrets, payload bodies and business
records are not requested or retained. Provider over-return is projected through
an allowlist again locally. Release/build identity and customization evidence are
explicitly unknown/not collected. Inherited behavior, flow internals, nested portal
rows, inbound integration contracts, catalog configuration, effective access,
execution history and unsupported standalone/OOTB changes remain gaps.

The regression fixture in `cli/test/support/document-fixture.js` is entirely
synthetic and runs the real CLI against an isolated loopback provider. It is not a
live instance capture. No private evidence is included in the package.

## Direct MID installation

```sh
jsn midservers add --install-method direct --name worker1
```

Official x86-64 ZIPs for Linux and Windows, selected from the instance's
`mid.version`. Credentials are prompted and validated before installation.
Linux supports a user-owned background runtime. Windows currently prepares
private files and offers a foreground console, not native service registration.
See [direct MID installation](install.md#direct-mid-server-zip-installation) for security boundaries,
lifecycle commands and the untested Windows host phases. Docker remains available.

## Create an update set in a scope

```sh
jsn updatesets create --name "Workspace changes" --scope sn_sow
```

`--scope` accepts a scope value, application sys_id, or display name, using the
same resolver as `jsn scopes set`. JSN selects and verifies the application
before creating the update set in that application, then selects the new set.
An unknown, ambiguous, or unselectable scope stops creation. Omit `--scope`
to keep the existing behavior.

The scope switch persists if creation later fails. If creation succeeds but
selecting the new set fails, the output reports the created record and a warning.
Inspect that record rather than rerunning create and making a duplicate.

## Customization reports

```sh
jsn customizations capture --label before-upgrade --customer-scope x_acme_app
jsn customizations list
jsn customizations show <run_id>
jsn customizations html <run_id>                 # writes customizations-<run_id>.html
jsn customizations html <run_id> --out review.html
jsn customizations compare <baseline_id> <new_id> --json
jsn customizations show <run_id> --get data.coverage
jsn customizations show <run_id> --get data.triage
```

Capture data access uses Table API GET requests only. Captures never run
background scripts or create, update or delete instance records. Standard
authentication still applies, including OAuth refresh, local refreshed-credential
storage and session/GCK bootstrap, which can make authentication POST requests.
Expired credentials without a usable refresh token require login. Reports are private local JSON files in
`$JSN_DATA_HOME/customizations`, defaulting to `~/.jsn/customizations`. List,
show and compare work offline. Interactive terminals offer local report pickers;
pass explicit IDs with JSON, pipes or `--get`.

The bounded inventory joins visible `sys_metadata`, `sys_scope` and
`sys_upgrade_history_log` records. `ootb_modifications` contains artifacts
with historical skipped-upgrade evidence, not a verified current OOTB diff.
Because the broad `sys_metadata` read is an arbitrary `sys_id`-ordered slice
(994 of 621972 rows on a large instance), it is reported as a **bounded sample,
not an inventory**: it only ever describes the rows the page budget reached.
The skipped-upgrade artifacts are inventoried separately and completely for the
observed history: after the filtered upgrade-history read, every observed
`sys_update_name` is resolved with chunked GET-only
`sys_update_nameIN<chunk of names>` lookups on `sys_metadata`, so an artifact
with skipped-upgrade evidence appears in `ootb_modifications` even when it falls
far outside the sample. `coverage.upgrade_evidence` reports the skipped rows
observed, the distinct update names, how many resolved by direct lookup, the
unresolved name list and any failed lookup chunks.
`customer_app_artifacts` contains only scopes explicitly declared with repeatable
`--customer-scope` values or sys_ids. The instance verifies the scope identity,
not its ownership. Installed/vendor scopes are never automatically called
customer-built. Other visible artifacts remain `unclassified`, and both those
categories cover only what the bounded sample read.

Each item reports identity, scope, evidence, unknown risk with rationale and a
review recommendation. Historical OOTB findings include the known skipped-upgrade
impact and explicit unknown baseline, runtime impact and dependencies. No
reversion is performed or recommended as safe without further investigation.

`show` adds a computed `data.triage` view with evidence confidence, the reason for
the classification and concrete review steps; it does not alter saved captures or
pretend to score risk. `html` exports a self-contained offline report with search,
classification filters, grouping, evidence, coverage and links back to records.
The default output is `customizations-<run_id>.html`; existing files are never
overwritten. The report does not change ServiceNow records.

Defaults are 100 records per page and 10 pages per source. Adjust `--page-size`
and `--max-pages` within the documented limits. Source coverage compares the rows
fetched with the Stats API count for the same query and reports both. A page
shorter than the requested size never implies exhaustion; `exhausted` is reported
only when the fetched rows account for the available total, and an unavailable
count is reported as unknown rather than implied completeness. Other statuses
distinguish missing fields, unstable pagination and read failures. Both the count
and the rows reflect visible ACL-filtered records, so hidden rows cannot be ruled
out and reports remain `incomplete`. An empty category does not prove that no
customizations exist. A 2xx table body without a `result` array is treated as an
unavailable source, never as an empty table.

Comparisons show newly observed, no-longer-observed and changed metadata/evidence.
They ignore local capture IDs, labels, timestamps and enumeration order.
They do not prove record creation/deletion or detect source-body changes without
captured metadata changes. Changed entries render the concrete before/after field
values, and additions/removals list the artifact's name, table, scope, category
and evidence basis. When either report has an unavailable or empty source, the
comparison status is `unreliable` and those differences are labelled as missing
coverage instead of mass creation or deletion. Compare only reports from the same
instance.

Provider contract: [ServiceNow Customizations Unchanged](https://www.servicenow.com/docs/r/xanadu/platform-administration/customizations-unchanged-related-list.html)
explains that the `Skipped` disposition preserves customizations. Other skip
reasons are not treated as equivalent evidence. This command cannot establish a
trusted baseline from that history alone.

### Reverting an application's customised files

```sh
jsn customizations revert --app sn_hr_core --expect-scope sn_hr_core --expect-update-set "<set>"
jsn customizations revert --app sn_hr_core --expect-scope sn_hr_core --expect-update-set "<set>" --confirm <token>
```

`revert` is the one customizations subcommand that writes. It puts the
customised files of an application installed from the Store or a repository
back to their newest base system versions, one file at a time through
[`jsn records revert`](records.md#reverting-a-record), with the same script and
readback per file.

- A customised file is one whose `sys_update_xml` has `replace_on_upgrade=false`,
  the platform's mark for a file an upgrade skips. Each update name is resolved
  through `sys_metadata` and must name exactly one record, still in the
  application's scope.
- A run takes the first 100 files by update name; the preview says when more
  remain, and a second run after the first takes the rest.
- Files added on the instance have no base version. They are listed and never
  deleted. Files already at their base are listed too.
- Applications built on the instance (`sys_app`) and `global` are refused.
- It previews by default and writes nothing. The SHA-256 token covers the
  instance, the application and each file's current and target version, so a
  file that changes after the preview rejects the old token. A terminal asks
  one default-No confirmation instead. `--force` does not waive either.
- It is a mutation: read-only profiles refuse it, and noninteractive runs,
  previews included, need `--expect-scope` (the application's own scope) and
  `--expect-update-set`.
- A file that fails is reported with its error and the rest carry on; any
  failure exits nonzero, never with a success summary.

The verified provider join is `sys_upgrade_history_log.file_name` to
`sys_metadata.sys_update_name`, not the log's nonexistent `name` field. Capture
uses raw values from `sysparm_display_value=all`: disposition `4` or `104`
means Skipped or Skipped (second pass). Resolution `reviewed_reverted` excludes
that history row; a present empty resolution is distinct from a missing field.
The upgrade-history read is filtered server-side to those dispositions so a
bounded capture spends its pages on preserved-customization evidence instead of
arbitrary history rows, and `unmatched_upgrade_records` counts only that filtered
population, not all upgrade history. The filtered history is the unit of the
inventory claim: every observed `file_name` is then resolved against visible
`sys_metadata` with chunked GET-only `sys_update_nameIN<chunk>` lookups, so
skipped artifacts are inventoried from the history instead of from the arbitrary
`sys_id`-ordered metadata sample. `unmatched_upgrade_records` and
`coverage.upgrade_evidence.unresolved_update_names` describe only names no
visible metadata row matched; a failed lookup chunk is reported rather than
treated as an absent artifact.
These values were checked against the PDI dictionary, choices and actual joined
rows. Display labels are not used for classification.

## Quick Start

```bash
jsn setup                                    # Interactive: add, switch, remove, modify instances
jsn incidents list --query "priority=1"      # Critical incidents
```

## What It Does

jsn talks to the ServiceNow REST API. Read, create, update, delete — tickets, users, groups, records on any table. Inspect flows and business rules. Export update sets. Run background scripts.

Everything outputs JSON when piped, styled tables in a terminal.

```bash
# Core ticket work
jsn incidents list --query "active=true^priority=1"
jsn incidents INC0010001
jsn incidents create --description "Server down" --priority 1

# Admin tasks
jsn flows list                                # Interactive picker with pagination
jsn flows show "Assign Task"                  # Full flow detail
jsn flows executions                          # All states, newest first
jsn flows executions --active                  # Only waiting/running/queued
jsn flows executions --since "2026-08-25 00:00:00" --until "2026-08-26 00:00:00"
jsn flows executions --summary                 # Server totals + sampled duration metrics by flow
jsn flows executions --limit 100               # Inspect more rows from the matching population
jsn flows executions --record <sys_id>        # Executions for one source record
jsn flows executions show <context>           # One run: version, reporting level, failed step
jsn flows settings <flow> --reporting FULL     # Preview one flow's reporting level; --yes writes it
jsn flows create --data-file flow.manifest.json # Create a draft record-triggered flow
jsn workflows list --table incident             # Legacy Workflow Editor, read-only (wf_* tables)
jsn workflows show "Incident approval"          # Versions, activities, transitions, conditions, scripts
jsn rules list --query "collection=incident"
jsn tables audit incident --field work_notes   # Audited or not, and why (read-only)
jsn tables audit exclude x_case priority       # Preview; --yes writes no_audit and re-reads the status
jsn updatesets set "My Feature"

# Generic table access
jsn records list --table incident --limit 50 --json | jq '.data.records[].number'
jsn records create --table incident --data '{"short_description":"test"}'
jsn records list --table incident --limit 50 --get "data.records.0.number"   # no jq needed
jsn records list --table incident --query "active=true"                       # totals included by default
jsn records list --table incident --limit 10 --no-count                       # opt out of the total query
jsn records bulk --table incident --query "priority=1" --set '{"state":"3"}'  # dry-run by default
jsn records get --table incident --sys-id 8a1234abcd5678 --attachments        # record + its files
jsn records export --table incident --query "priority=1" --out p1.xml         # unload XML, sys_ids kept
jsn records import p1.xml                                                     # preview; --yes loads it and re-reads each record
jsn records list --table incident --limit 10 --csv                            # output CSV
jsn columns show incident.priority                                            # dictionary entry + choices; names the table they come from

# Import sets: load rows into a staging table; each row is transformed as it loads
jsn import load u_staging --file rows.csv                                   # preview: checks columns and transform maps, sends nothing
jsn import load u_staging --file rows.csv --yes                             # one row per request; prints inserted/updated/ignored/skipped/error
jsn import transform ISET0010001 --yes                                      # rerun the maps on a set; reports each row as read back

# Attachment transfers (standalone, also discoverable via jsn attachments --help)
jsn attachments list --sys-id <record-id> --json
jsn attachments download <attachment-id> --out ./report.pdf
jsn attachments upload ./report.pdf --table incident --sys-id <record-id>
# get/add alias download/upload; uploads require confirmation, or --force after approval.
# Downloads refuse existing files unless --overwrite is explicitly supplied.

# Read-only cross-profile record diff
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod --ignore state
jsn diff record --table incident --sys-id <sys_id> --profile-a dev --profile-b prod --no-ignore

# Script execution
jsn eval "gs.info('Hello World')"
cat script.js | jsn eval --stdin          # pipe a script in (no shell escaping)
jsn eval --file fix.js --timeout 600      # wait up to 10 minutes (default 30 s)
# On Ctrl-C or when --timeout passes, jsn cancels the script on the instance
# through cancel_my_transaction.do in the same session, as the UI's cancel link
# does, and says whether the platform confirmed it. Writes made before the
# cancel stay.

# Interactive background-script mode for trying successive scripts.
# Each .exec is its own server request: variables do not persist between
# submissions, while database writes do. .clear .help .exit; Ctrl+D exits.
jsn eval --repl --profile dev --scope x_my_app

# Sandbox mode evaluates one KittyScript expression instead of running a
# script. The platform allowlists what an expression may touch (GlideRecord
# writes are refused), so it needs no scope, update set or capture-context
# intent. A rejected expression is reported as a failure; a valid one still
# records execution history, but the platform does not return its value.
jsn eval --sandbox --script 'gs.getUserID()'
jsn eval --sandbox --script "new GlideRecord('incident').insert()"   # refused: no writes

# Undo what a background script wrote, from the rollback context the platform
# recorded. Use the execution id jsn eval reports (kept 7 days); preview first,
# then --yes (admin). Records changed by anything else since are left alone.
jsn eval rollback <execution>
jsn eval rollback <execution> --yes

# Now GraphQL (documents may contain mutations; read-only profiles are blocked)
jsn graphql --query '{ GlideRecord_Query { incident(pagination: {limit: 2}) { _results { number { value } } } } }'
cat incident.graphql | jsn graphql --stdin --variables '{"limit":2}'

# Saved query snippets (stored locally, run against the active profile)
jsn snippets save open-inc --table incident --query "active=true"
jsn snippets run open-inc

# Live log tailing (Ctrl+C to stop)
jsn logs follow --level error --tail 10

# Transactions running now on every node, oldest first (admin; your own request is left out)
jsn transactions active --older-than 5m --type scheduler
# Watch them, refreshing every 10 seconds until Ctrl+C
jsn transactions active --watch --interval 10
# Kill a runaway background job: preview it, then send the platform's Kill to the transaction it showed
jsn transactions kill glide.scheduler.worker.3
jsn transactions kill glide.scheduler.worker.3 --yes --expect-transaction 4ba972c9c3f0d71068353eec05013113
```

### Update set completion

```bash
jsn updatesets complete                         # Current set, opens a notes editor in a human terminal
jsn updatesets complete "My Feature" --notes "Fixed validation" --force --json
```

`complete [name]` saves concise bullet-list notes in the selected set's Description
and marks it complete. Omit the name to use the current set. Explicit names
must be unique; for duplicate names, select the intended set with `updatesets set`
and complete it without a name. ServiceNow's normal batch completion rules still
apply: completing a parent can complete its children. Notes are not copied to children.

Existing Description text is preserved exactly. The command shows it and asks
before appending notes, unless `--force` or the profile's `skip_confirmations`
policy explicitly allows the append. Scripts and JSON output must supply
nonempty `--notes`; they never open prompts. Separate multiple notes with real
newlines. Success requires readback of both Description and state. If verification
fails, inspect the set before retrying because the write may have partially succeeded.

### Update set transfer

```bash
jsn --profile source updatesets export "Digital Helpdesk 0.1.77"   # auto-named XML here
jsn --profile target updatesets import transfer.xml --dry-run --json
jsn --profile target updatesets import transfer.xml --yes
jsn --profile target updatesets preview "Digital Helpdesk 0.1.77" --yes
jsn --profile target updatesets problems "Digital Helpdesk 0.1.77"
jsn --profile target updatesets commit "Digital Helpdesk 0.1.77" --yes
```

Export never changes the set's state and keeps raw XML when piped. Import loads a
retrieved update set and stops; `preview` and `commit` drive the platform's own
CICD Update Set API steps and follow their progress trackers. `problems` is
read-only: jsn never accepts, skips, or ignores a preview problem, and commit
refuses while any remains unresolved. Both mutating steps verify `previewed` /
`committed` by readback. See [update-set-transfer.md](updatesets.md#transfer-an-update-set).

### Flow Designer actions

`actions` and `action` are the same command. `list`, `show`, and explicit
`delete` remain available. In a human terminal, omit the target to open a
searchable picker. Create and edit guide you through provider schemas and save
full Process Flow definitions, not ordinary table-field updates.

```bash
jsn actions create                 # Guided scope, name, schemas, inputs and script
jsn actions edit                   # Pick an action, edit its saved definition
jsn actions definition             # Pick and inspect a complete definition
jsn actions test --wait            # Pick an action, supply saved-schema inputs, confirm
jsn actions step-types             # Pick the exact transaction scope
```

Script inputs offer a file path or your `$VISUAL`/`$EDITOR`. New script steps can
declare outputs and map them to action outputs. Variable declarations reuse
provider schema templates and receive fresh UI identities. Unknown nested
schema fields are retained. Unsupported input types stop with instructions to
use `--data-file`; JSN does not silently omit them or invent schema defaults.
Creation waits for an explicit final confirmation before allocating a parent.
It saves a draft only and never publishes or runs it automatically.

For automation, keep using explicit identifiers and full JSON:

```bash
jsn actions step-types --scope <scope_sys_id> --get data > step-types.json
jsn actions create --scope <scope_sys_id> --data-file new-action.json --json
jsn actions definition <action_sys_id> --get data > action.json
# Edit action.json, retaining its ID, scope, lifecycle fields and all arrays.
jsn actions update <action_sys_id> --data-file action.json --json
jsn action edit <action_sys_id> --data-file action.json --json  # same operation
jsn actions test <action_sys_id> --force --output-map '{"response":"hello"}' --wait --timeout 60 --json
jsn actions test <action_sys_id> --force --data-file action.json --output-map '{"response":"hello"}' --wait --get data.outputs.response.value
jsn actions delete <action_sys_id> --force  # explicit cleanup, never automatic
```

Existing targets infer their exact transaction scope from the action record.
An explicit `--scope` must match that record byte-for-byte and exist in
`sys_scope`. For Global, use the literal sys_id `global`.

This **illustrative create document** shows an input/script/output mapping.
Replace `<SCRIPT_STEP_TYPE_SYS_ID>` with the target's `step-types` result.
Start from that step type's full input/output schemas, preserving runtime
settings, status outputs and any other required fields. The shortened example
is not a captured or instance-verified template. New steps/variables need their
own identifiers; do not clone another action's record IDs. Leave new steps'
`step_id` and `action` blank or omitted. Create binds their `action` to the newly
allocated parent; persisted step IDs or parent bindings are rejected before creation.

```json
{
  "name": "Echo response",
  "description": "Return the supplied response",
  "internal_name": "echo_response",
  "inputs": [{"name": "response", "label": "Response", "type": "string", "mandatory": true}],
  "outputs": [{"name": "response", "label": "Response", "type": "string", "value": "{{step[11111111-2222-4333-8444-555555555555].response}}"}],
  "steps": [{
    "cid": "11111111-2222-4333-8444-555555555555",
    "step_type": "SCRIPT",
    "step_type_id": "<SCRIPT_STEP_TYPE_SYS_ID>",
    "label": "Echo script",
    "order": 1,
    "inputs": [
      {"name": "required_run_time", "type": "choice", "value": "instance"},
      {"name": "script", "type": "script", "value": "(function execute(inputs, outputs) { outputs.response = inputs.response; })(inputs, outputs);"}
    ],
    "outputs": [],
    "extended_inputs": [{"name": "response", "type": "string", "value": "{{inputs.response}}", "extended": true}],
    "extended_outputs": [{"name": "response", "type": "string", "extended": true}]
  }]
}
```

Create first inserts the parent in `sys_hub_action_type_definition`, reads that
parent's own Process Flow defaults, then saves the inputs, outputs and nonempty
steps with the internal `/api/now/processflow/action/action_types/{id}` PUT.
It retains fresh lifecycle/status metadata instead of copying source snapshot
or status IDs. A subsequent definition GET plus `/step_instances` GET verifies
scripts, mappings and schemas. Update requires a complete document from
`definition`, including target-owned lifecycle fields. Omitted fields are
rejected before mutation. A PUT timeout triggers readback, not another PUT;
`persisted_after_timeout` means persistence was verified, not that HTTP success
was received. Failed creation reports the parent ID and leaves cleanup to you.

Test sends `action`, `outputMap`, `runOnThread` and `tracingEnabled` to `/test`.
Despite its wire name, `--output-map` supplies **action inputs**. Without
`--wait`, success means dispatch only, with `status: dispatched` and no outputs.
With `--wait`, JSN requires a `COMPLETE` context, blank `error_message`, and each
declared user output's actual value from `sys_flow_runtime_value`. Output entries
have `value`, `displayValue` and `hasValue`; false, zero and empty strings count.
Failures, denied/missing outputs and timeouts exit nonzero. The wait budget
starts after dispatch, defaults to 60 seconds, and is capped at 3600 seconds.
Timeout does not cancel the server execution. Draft actions can be tested without
publication. Testing runs their scripts and can have side effects. It requires
interactive confirmation or `--force`, unless the profile explicitly skips
confirmations. Read-only profiles block create/update/delete/test. No publish
or snapshot command is added.
These internal endpoints and runtime-table permissions can vary by instance.

### Flow execution fields

### Flow Designer terminal workflows

```bash
jsn flows create         # Guided record trigger and published action inputs
jsn flows edit           # Pick a flow, edit condition or existing inputs (drafts, and published flows you can write)
jsn flows show           # Pick a flow to inspect
jsn flows status         # Pick a flow to diagnose
jsn flows test           # Pick flow and a record from its actual trigger table, confirm
jsn flows publish        # Pick a flow, explicitly confirm activation
jsn flows unlock         # Release this user's stale safe-edit lease after a failed update
# Automation must explicitly confirm publication too:
jsn flows publish <flow_sys_id> --force --json
```

Wizards and omitted-target pickers require both a prompt-capable terminal and
`auto` output. `--json`, explicit formats, `--get`, `--data`, `--data-file`,
`--output-map`, pipes, `CI`, `NONINTERACTIVE` and `JSN_NO_PROMPTS=1` never open a
wizard. In those modes provide identifiers and required scope/record/data
explicitly. Tests, publish and deletion require `--force` or the profile's
existing explicit skip-confirmations setting when prompting is unavailable.
Read-only profiles still block mutations before authentication or prompting.
Press Escape in any prompt or record picker to cancel; Ctrl+C aborts as well.
Refusing a final confirmation leaves the instance untouched.

Existing action/flow scopes come from saved raw identifiers. New scopes offer
the active application preference if available, then a searchable scope picker.
No scope name is guessed. Input pills are passed through unchanged.

Flow edits are limited to the existing manifest contract. They do not rename
flows, add/remove steps, implement Flow Logic, subflows, variables or error
handling. Flow deletion remains unsupported. Action deletion retains its
existing explicit parent-record cleanup and absence readback, not a new native
builder deletion lifecycle. See [command coverage and local proof](flows.md#flow-designer-interactive-commands).

### Flow creation manifest

`jsn flows create` accepts `--data-file` or inline `--data`, or guides human
terminal users without those options. The supported slice
supports one `record_create_or_update` trigger and published Action types whose
input schemas are available from the instance. JSN resolves action metadata,
defaults, and typed inputs from ServiceNow; callers do not provide GraphQL or
editor-generated identifiers.

```json
{
  "name": "JSN-STUDY-ticket-log",
  "description": "Log JSN study tickets",
  "scope": "<SCOPE_SYS_ID>",
  "trigger": {
    "type": "record_create_or_update",
    "table": "ticket",
    "condition": "short_descriptionSTARTSWITHJSN-STUDY-"
  },
  "actions": [
    { "type": "Log", "inputs": { "log_level": "info", "log_message": "Ticket received" } }
  ]
}
```

`scope` is required; JSN never defaults it to a tenant-specific or captured
scope. The record-trigger condition currently accepts one simple encoded-query
predicate (`fieldSTARTSWITHvalue`, `field=value`, `fieldLIKEvalue`, and the
equivalent single-predicate operators). Compound `^`/`^OR` expressions are
rejected until their predicate AST mapping is proven against the instance.

Creation leaves the flow in Draft and inactive, then creates and reads back an
Autosave version. `flows publish` remains a separate lifecycle operation: it
reads the saved ProcessFlow definition, POSTs `/snapshot`, creates an
`Activate/Publish` version, reads version history, and verifies `active=true`.
Do not use it in a dry-run: publishing activates the flow.

`jsn flows test <identifier> --record <sys_id>` is also a mutating operation.
It requires confirmation (or `--force`), reads the saved definition, verifies
that the supplied record exists in the record-trigger table, and POSTs the full
definition to the ProcessFlow test endpoint. A response with only a context ID
is reported as accepted, not completed. Test runs execute actions and can have
side effects; this slice does not execute test flows during development.

Flow Logic, subflows, flow-variable lifecycle, and error handling are deferred
and rejected by this slice rather than silently ignored.

`jsn flows update <identifier> --data-file update.json` updates supported fields
of existing Draft flows, and of published or active flows whose ProcessFlow
definition reports `security.can_write=true`. The manifest may contain only `trigger` (with
`table` and/or `condition`) and `actions`. Each action selects one saved instance
by its one-based `order` and reusable action `type` (name or sys_id). Its `inputs`
object may change only inputs already present in that saved Action. The CLI reads
the saved component identities itself; manifests never carry UI UUIDs. Omitted
trigger fields, Action inputs, metadata, and other flow components are preserved.
Names must resolve to exactly one flow, and the protected `jace-test-flow` is
rejected. Update sends the captured GraphQL `triggerInstances.update` and/or
`actions.update` shapes, reads the full ProcessFlow definition back, creates an
Autosave version, and reports update-set captures. It never publishes or
activates the flow. A published flow is edited as its working definition: the
published snapshot, its version rows and the parent `active`, `status`,
`master_snapshot`, `latest_snapshot` and `version_record` pointers are compared
before and after, and a change fails the command loudly instead of being
reported as a safe edit. A published flow whose definition reports
`security.can_write=false` (or no `security.can_write`) is refused before any
edit session or content write, naming the permission rather than the lifecycle.
Unsupported Flow Logic, subflows, variables, error handling, new Action inputs
and ambiguous selectors are rejected before mutation.

`jsn flows executions` reads `sys_flow_context` and returns both the raw row and a normalized `execution` object. JSN discovers the runtime columns from `sys_dictionary` first, then uses these mappings:

- `started`: `started`, `start_time`, `started_at`, then `sys_created_on`
- `ended`: `ended`, `end_time`, `ended_at`, then `completed_on`
- `duration_seconds`: stored `duration`, `run_time`, or `execution_duration`, otherwise `ended - started`
- `waiting_age_seconds`: current time minus `started` while the status is waiting, queued, paused, or pending
- `execution_age_seconds`: current time minus `started` while the status is running, executing, or processing
- `status`: `state`, then `status`, then `execution_state`
- `error`: `error`, `error_message`, `exception`, then `message`

The timestamp fields are instance-dependent. `sys_created_on` is a fallback for when the context row was created, not a claim that it is the true runtime start time.

`jsn flows executions show <context>` reads one `sys_flow_context` row by sys_id and answers three questions about that run. Which version ran: the context's `snapshot` against the definition's current `latest_snapshot` (`sys_hub_flow` for flows and subflows, `sys_hub_action_type_definition` for actions). Whether step data was kept: the reporting level from the context's `attributes`, falling back to its `reporting` field; Basic keeps step states and durations, and only Full and Trace keep inputs and outputs. Which step failed: the Error rows in `sys_flow_log` (the first 20, ordered by `order`), whose `action` path names the run, then instance sys_ids from the outside in; JSN resolves the deepest `sys_hub_action_instance_v2` and `sys_hub_step_instance` in that path to their order, name and comment. The flow log is kept whatever the reporting level, so this works on runs that had reporting Off; step inputs and outputs are not, and the command says so instead of printing an empty list. When no Error row is readable it says that an empty read does not prove none were logged. JSON keeps each log message up to 16384 characters (the instance's own `com.snc.process_flow.reporting.serialized.val_size_limit` default) with `message_length` and `truncated`; the terminal shows the exception line or the first line, cut at 200 characters.

`jsn flows settings <flow>` shows or sets the flow's one `sys_flow_execution_setting` row (`source` is the flow, `source_type` its table), which overrides `com.snc.process_flow.reporting.level` for that flow as Workflow Studio's Reporting settings do. `--reporting` takes OFF, BASIC, FULL or TRACE and `--logging` DEBUG, INFO, WARN or ERROR, checked before any request; `--action` targets a custom action instead. Without `--yes` it prints the current row, the change and the exact rerun, and writes nothing. With `--yes` it creates the row or updates only the fields that change, then reads the row back and prints it as read; an unconfirmed write exits 1. An empty read is reported as no readable row, since a row the session cannot see may still exist. It refuses a flow with more than one row. A subflow or action called from a flow runs at the parent flow's setting. The row is runtime data, not a customization (`sys_flow_execution_setting` does not extend `sys_metadata` and has no `update_synch` attribute), so it needs no update set and is not captured in one.

## Commands

Run `jsn` for the full grouped list. Commands are organized by ServiceNow domain:

**Core** — `incidents`, `changes`, `requests`, `tasks`, `tickets`

**Automation** — `flows`, `actions`, `rules`, `scrapi`, `updatesets`, `eval`, `rest`

**Upgrade review** — [`skipped-updates`](safety.md#skipped-update-review) discovers existing unresolved skips, reviews current/base field changes and known dependencies, and processes only explicitly selected actions after an exact batch preview and one confirmation.

**Access** — `acls`, `roles`, `scopes`, `properties`, `privileges`

**User Experience** — `forms`, `lists`, `clientscripts`, `uipolicies`, `uiactions`

**Data** — `records` (list/get/create/update/delete/count/bulk), `attachments` (list/download/upload), `diff record` (cross-profile read-only comparison), `tables`, `columns`, `includes`, `import`, `logs` (list/show/follow), `snippets` (save/run), `users` (list/show/roles), `groups`
**Data** — `records` (list/get/create/update/delete/count/bulk), `attachments` (list/download/upload), `diff record` (cross-profile read-only comparison), `tables`, `columns`, `includes`, `import` (list/show/load), `logs` (list/show/follow), `snippets` (save/run), `users`, `groups`
**Data** — `records` (list/get/create/update/delete/count/bulk), `attachments` (list/download/upload), `diff record` (cross-profile read-only comparison), `tables`, `columns`, `includes`, `import` (list/show/load/transform), `logs` (list/show/follow), `snippets` (save/run), `users`, `groups`

**Platform** — `platform health` (cluster records) and `platform stats` (bounded, read-only `/xmlstats.do` summary; allowlisted metrics only)

Every command supports `--json`, `--query`, and `--help`.

For multiline script fields, `--data-file` parses the file as UTF-8 JSON and
passes the resulting values through unchanged. On Windows PowerShell, generate
the payload as JSON text and inspect it before invoking JSN, for example:

```powershell
$script = [string](Get-Content -Path .\Example.script.js -Raw)
$payload = @{ script = $script; description = 'Example' } |
  ConvertTo-Json -Depth 5 -Compress
Set-Content -Path .\Example.update.json -Value $payload -Encoding UTF8
Get-Content .\Example.update.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty script
jsn includes update Example --data-file .\Example.update.json --json
```

`JSON.parse` preserves a JSON string as a JavaScript string, and the SDK
serializes update payloads with `JSON.stringify`. If the file already contains
a `{value=...}` or FileSystem-provider representation, that text is external
to JSN and must be corrected before the update. Use a read-back command or
`records update --strict` where applicable to verify persisted fields.

## Instances

Switch between instances without re-authenticating.

```bash
jsn setup                    # Guided login and connection management
jsn auth status              # Compact profile status table
```

`jsn setup` is the human front door. It collects answers and calls the same
operations as `auth`: add, sign in again, status, choose a default, change
settings, sign out, and remove. For scripts and CI, use explicit commands
(Basic login below reads SN_USERNAME/SN_PASSWORD from the environment):

```bash
jsn auth login dev12345 --name work --basic --read-only --make-default --json
jsn auth refresh --profile work                   # Refresh an OAuth profile
jsn auth switch work                             # Explicitly choose the default
jsn auth modify work --read-only --no-include-counts --confirm-deletes --json
```

## Output Formats

| Flag | When to use |
|------|-------------|
| (default) | Terminal — styled tables |
| `--json` | Pipelines, scripts |
| `--markdown` | Documentation |
| `--quiet` / `-S` | Data only, no envelope |
| `--csv` | Spreadsheets (opens straight into Excel) |
| `--tsv` / `--format=tsv` | Compact flat lists separated by real tabs |
| `--get <path>` / `--select <path>` | Extract a value, e.g. `--select 'data.records[0].number'` |
| `--raw` | Print selected strings without JSON quotes |
| `--verbose` | Restore JSON summaries, breadcrumbs and two-space indentation |

JSON is compact by default and omits top-level `summary` and `breadcrumbs`.
It retains record data, pagination, context and error details. Human formats
are unchanged. Extraction accepts both `data.records[0].number` and
`data.records.0.number`; non-string `--raw` results remain compact JSON.

`-q` now means `--query`, not quiet. It works on commands that declare query
support and errors on commands that do not. For example:

```bash
jsn records list --table incident -q 'active=true' --json
jsn records list --table incident -q 'active=true' --select 'data.records[0].number' --raw
```

Table API list reads omit reference links by default. Add
`--include-reference-links` to request the provider's reference-link objects.
Counted list responses include `data.pagination.hasMore`; records lists omit
that field when totals are unavailable or disabled with `--no-count`. Ticket
lists can instead set it from page fullness, without a known total.

CSV stdout contains only the header and record rows, including on a terminal.
When a records envelope explicitly reports `pagination.hasMore: true`, one
notice goes to stderr with the returned page count, total if known, and next
offset when the envelope supplies a valid offset and limit. The next offset
advances by the requested limit, not the number of returned rows. A notice
with an unknown total does not establish how many records remain. Complete
results emit no pagination notice; absent `hasMore` is not proof of completeness.

```bash
jsn records list --table incident --limit 2 --csv > incidents.csv 2> pagination.log
```

A CSV reader consuming only stdout will **not** see this notice. Capture and
check stderr separately, and do not merge it into the CSV stream with `2>&1`.
For automation that needs structured pagination metadata, use `--json` instead.
CSV does not fetch subsequent pages automatically.

### TSV cells and terminal spacing

```bash
jsn records list --table incident --columns sys_id,number,state --limit 5 --tsv
```

`--tsv` and `--format=tsv` are equivalent. TSV shares CSV's row selection:
headers come from the first record's keys, reference objects prefer
`display_value`, then `value`, and other objects/arrays become JSON cell strings.
Null and missing cells become empty strings (indistinguishable from an empty
string); empty results emit no bytes, not a header. CSV/TSV do not preserve both
reference IDs and labels. JSON preserves reference objects only when the command
has retained them; an earlier scalar projection cannot recover discarded IDs.

Fields and headers escape backslash as `\\`, tab as `\t`, newline as `\n`,
and carriage return as `\r`. Each record occupies one physical line, with real
tabs between cells and LF between records. Quotes have no special meaning.
To parse, split lines and tabs **before** decoding those four backslash escapes
in one pass; decode JSON-valued cells separately afterward if needed.

Tabs use the viewer's tab stops, not padded column widths. Long values can cross
a tab stop, so TSV does not guarantee visually aligned columns. Use the default
styled terminal view for padded tables.

Like CSV, TSV keeps summaries and pagination footers off stdout and sends a
`TSV pagination:` notice to stderr only when `hasMore` is explicitly true.
Silence (including `--no-count`) does not prove completeness. Capture stderr
separately; use JSON when automation needs pagination metadata. Neither format
fetches additional pages. `--get`/`--select` extraction still takes precedence.

## Authentication

`jsn auth status` shows a compact table of profiles, methods, credential state,
connection verification, and read-only/delete-confirmation/count settings.
The selected and default profiles are labeled explicitly. Usernames and
instance URLs are hidden by default, including in JSON; add `--details` to
include the **User** and **Instance** columns and their JSON fields. Use
`jsn --profile <name> auth status` to focus on one profile, or add `--local`
to inspect saved state without contacting any instance. Scripts extracting
`default_instance`, `profiles.*.instance`, `username`, or `verified_as` must
include `--details`.

When `jsn auth login <instance>` creates a profile interactively, it offers the
same read-only, delete-confirmation, and result-count options as setup. Scripts
can supply `--read-only`, `--no-include-counts`, and `--confirm-deletes`.
The compatible `--skip-confirmations` disables delete prompts.
`jsn auth modify <profile>` accepts the same setting flags; repeating a request
sets the same values. Without flags, humans get a settings picker; scripts get
a structured usage error. Reauthentication preserves existing preferences.

Use `--name <new-name>` to create another connection, including a second user
on the same instance, and `--profile <existing-name>` to reconnect. Setup asks
whether to use a connection by default. Scripts must pass `--make-default` or
run `auth switch`; even a first login does not silently set a default.

JSN supports OAuth 2.0 with PKCE, Basic Auth, and browser-session auth.
Persisted credentials require the OS keyring (`secret-tool`/libsecret). If a save
or its exact readback fails, JSN refuses rather than silently writing plaintext.
Environment-only authentication does not require credential persistence.

For an explicitly accepted headless plaintext fallback, set
`JSN_ALLOW_PLAINTEXT_CREDENTIAL_STORAGE=1` on the individual JSN process (for
example, prefix your `jsn auth login` command). Only the exact value `1` enables
it; project/profile configuration cannot enable it. Do not put this override in
a project, shell startup file, or shared environment. A fallback read or write
warns on stderr, and loaded credentials report `auth_source: file`. The override
still prefers the keyring; it is not an encryption mode. Credential JSON under
`${XDG_CONFIG_HOME:-~/.config}/servicenow/credentials/` contains reusable secrets.
A directory copy or backup can transfer access, subject to provider token policy.
Exclude these files from sync, source control, shared volumes, and backups.

Existing fallback files do **not** implicitly enable insecure storage. Reads,
including local status, never migrate or persist credentials. With no keyring
entry, JSN refuses a fallback read unless the process explicitly opts in. To
migrate an existing credential, unlock/install the keyring, opt in for one
process, then save through login or an ordinary token refresh. Alternatively,
reauthenticate with the working keyring without opting in. Every secure save
verifies exact readback before unlinking that identity's old plaintext file;
failed verification preserves the original. Other users' entries are untouched.
Unlinking is **not secure erasure** and cannot remove
backups, snapshots, copied files, or filesystem remnants. If credentials were
copied unintentionally, revoke/rotate them at the provider and remove exposed
copies; deleting a local file does not revoke a token.

Credential and pending PKCE files use atomic same-directory replacement. On
POSIX, files require 0600 modes and leaf directories require 0700 modes.
Unsafe existing modes, unexpected ownership, hard-linked
files, symlinks, and writable ancestors are refused rather than automatically
chmodded or followed. Inspect and manually repair or move the exact owned path
before retrying (never apply recursive chmod to your home/config tree). JSN does
not change permissions on broad parent directories. PKCE state is necessarily a
local plaintext login secret; it receives the same path protections, independent
of the credential-storage override.

On Windows, POSIX mode/UID checks are not applied: Node's mode bits do not
validate Windows DACLs. Files and directories inherit their parent's ACL; JSN
does not set or verify those ACLs. Use a private per-user config directory and
verify its ACL separately; do not use shared or broadly writable locations.
Regular-file/directory, hard-link and lstat-detectable symlink/junction rejection
still apply, but Node cannot identify every reparse-point type or eliminate
same-user path races. PKCE remains a local plaintext login secret on Windows.
Persisted credentials still require verified keyring storage by default; using
portable plaintext on Windows requires the same explicit process-only opt-in
and warning. No Windows ACL protection or secure-erasure guarantee is implied.

```bash
jsn auth login https://dev12345.service-now.com
```

For Basic Auth, set `SN_USERNAME` and `SN_PASSWORD`, then run `jsn auth login --basic <instance>`.

If the instance requires TOTP MFA, Basic requests prompt for a masked six-digit
authenticator code before sending the operation. Escape cancels cleanly.
Noninteractive, `--json`, and `--get` invocations fail with `mfa_required` and
guidance instead of prompting. JSN never stores TOTP seeds or generates codes.
Configure OAuth or a browser session explicitly for unattended use. MFA failure
never switches authentication methods or sends the pending operation. See the
[authentication lifecycle](setup.md#basic-auth-totp-challenges-402) for
timeouts, identity verification, and the fixture-only verification boundary.
For browser-session auth, run `jsn auth login --gck <instance>` and paste the request headers when prompted.

### OAuth from scripts or a remote terminal

```bash
jsn auth login dev12345 --name work --oauth --print-url --json
jsn auth login dev12345 --name work --oauth --code "$CODE" --read-only --json
```

The first result contains `data.authorization_url` and a completion command.
Keep the same instance and profile name when exchanging the code. The existing
`--print-url --wait-file <path>` flow remains available. Progress goes to
stderr; JSON results and auth errors remain machine-readable. Noninteractive
login without a code or URL request returns a usage error instead of prompting.

### Log in using a browser (experimental)

Run `jsn setup`, enter the instance and profile name, and choose **Browser
session**. Choose an installed browser when prompted, then sign in in the
window JSN opens. JSN continues automatically after verifying your account.
There are no debugging-port or request-header prompts.

The direct command is:

```bash
jsn auth login dev12345 --browser
jsn auth login dev12345 --browser --browser-name chromium
```

Installed Chromium, Chrome, and Edge are detected. Chromium is the first
validated launch integration; Firefox is not supported yet. `--browser-name`
accepts `chromium`, `chrome`, or `edge`; without it, interactive login offers
installed browsers and noninteractive login selects the first available one.

JSN opens a fresh, temporary login window, so another window's account is not
silently reused. Finish signing in within five minutes. JSN verifies access to
the current user's `sys_user` record, saves standard GCK credentials, then
closes its login window and removes its temporary browser profile. Press Ctrl+C
or close the login window to cancel. Your normal browser windows stay open.
An existing profile's username must match the browser account.

When the session expires, log in again:

```bash
jsn auth login --profile limited --browser
```

Interactive `auth login` on an existing GCK profile launches browser login.
Bots must request that explicitly with `--browser`; JSON/piped commands never
open a browser implicitly.
Pages without a readable `g_ck` still need the explicit `--gck` paste flow.
Login is explicit; JSN does not renew browser sessions in the background.

For an already configured local debugging browser, the advanced connection
path remains available without launching or closing that browser:

```bash
jsn auth login dev12345 --browser --browser-url http://127.0.0.1:9222
```

That endpoint must be loopback-only. Chrome requires a non-default browser data
directory for this connection
([Chrome documentation](https://developer.chrome.com/blog/remote-debugging-port)).
Keep one logged-in application tab open for the instance; multiple matching
tabs are rejected. The debugging connection grants access to that browser
profile, so close it when finished.

For CI/CD, set environment variables:

```bash
export SERVICENOW_INSTANCE_URL="https://dev12345.service-now.com"
export SERVICENOW_OAUTH_TOKEN="***"
jsn incidents list
```

For the credential identity, auth-method, diagnostics, migration, and concurrency contract, see [`AUTH_LIFECYCLE.md`](setup.md#authentication-lifecycle-review).

GraphQL uses ServiceNow's `/api/now/graphql` endpoint and sends `{query, variables}` through the authenticated SDK transport. The command preserves GraphQL `data` and `errors`; introspection and available namespaces depend on the target instance.

`jsn platform stats` uses a fixed `GET /xmlstats.do` request. It never accepts a processor path, query parameters, or request body, and it does not emit raw XML, cookies, credentials, or full node identifiers. Oversized, HTML/login, permission, unsupported, timeout, and malformed responses are reported with bounded collector statuses; missing metrics remain unavailable rather than being reported as zero.

## Local data

JSN stores durable local data under `~/.jsn/`. Documentation lives in
`~/.jsn/docs/`, including `docs.db`, the ServiceNowDocs source checkout, and
community markdown. Configuration stays under `~/.config/servicenow/` and
credentials use the operating system's credential store, with a file fallback under `~/.config/servicenow/credentials/`.

Existing installations migrate documentation from
`~/.cache/servicenow-cli/docs/` automatically the first time the docs data is
accessed. The old directory is removed only after the destination is verified.

## AI Agents

jsn ships with a skill file that tells AI agents how to use it. Installed automatically to `~/.agents/skills/servicenow/SKILL.md`.

```bash
jsn skill show                  # View the skill
jsn skill install               # Install to Hermes
jsn skill install --target all  # All supported agents
```

## Development

```bash
git clone https://github.com/jacebenson/jsn.git
cd jsn
npm --prefix cli ci
npm test
npm run lint
```

Releases run from the GitHub Actions workflow. Dispatch `Release production` with `patch`, `minor`, or `major`. The workflow tests and lints the repo, bumps the version, pushes the commit and tag, dispatches the npm publish workflow, and creates the GitHub release.

## License

MIT

Auth and setup prompts show **Esc to cancel**, as does every other prompt. Press Esc to leave the current workflow without accepting the highlighted choice. `jsn auth status` includes hints for switching profiles, renewing OAuth/browser sessions, and changing profile settings.

## Additional command workflows

### Knowledge search

Use `jsn knowledge search "VPN setup" --profile work` (alias `kb`) to search
accessible articles, then `jsn knowledge show KB0000010 --profile work` to read
one. Search supports bounded `--limit`/`--offset`, knowledge-base sys_ids with
`--kb`, and `--language`. JSON preserves native HTML; human output uses Markdown.
Hints preserve an explicitly selected profile/instance. The Knowledge API plugin
(`sn_km_api`) must be available; access is evaluated by that API, with no fallback
to direct table reads. Reads do not request view-count updates. See the
[Knowledge API reference](https://www.servicenow.com/docs/r/yokohama/api-reference/rest-apis/knowledge-api.html).

### Instance Scan

`jsn scan` manages checks and suites and runs scans against an explicit target.
Use `jsn scan --help` and each subcommand's `--help` to discover the options.

```bash
jsn scan checks list --profile dev
jsn scan checks create --type table --data-file check.json --profile dev
jsn scan checks activate <check-id> --profile dev
jsn scan suites add-check <suite-id> --check <check-id> --profile dev
jsn scan run --update-set "My change" --suite "My suite" --wait --profile dev
jsn scan run --table sys_script_include --record <record-id> --profile dev
jsn scan results <execution-id> --profile dev
```

Check types are `table`, `column`, `linter`, and `script`. Definitions are created
inactive unless the payload explicitly sets `active: true`; activation never
starts a scan. Both checks and suites support list/show/create/update/delete and
activate/deactivate. Suites also support add-check/remove-check.

Runs require an update set, scope, record plus table, or explicit `--full`.
Instance-wide scans may traverse many tables even when a check's script only
examines a few records. Starting and cancelling a scan require confirmation;
use `--force` only after approving that operation. `--wait --timeout 120` bounds
the wait, not the scan's lifetime. A timed-out wait keeps the execution id and
does not cancel or resubmit the scan. Use `status`, `results`, or `cancel` next.

Update-set scans examine current instance records, not the historical XML
versions. Inactive records may be skipped. Script-only checks do not participate
in record/update-set scans; use an explicitly instance-wide suite run to execute
them. Execution success does not mean zero findings or complete test coverage:
results report recorded check executions, finding counts, unreadable sources,
and truncated lists separately. A result's rerun hint preserves the previous
target combination and requires `--full` again for instance-wide scans.

Every command returns next-step breadcrumbs in human and JSON output, retaining
an explicitly selected profile or instance. `updatesets show` also offers a scan
hint. Recommendation/generation of new checks is not part of this command;
JSN contains no AI and does not infer missing business requirements.

### CMDB search

`jsn cmdb search "web" --profile work` searches names, FQDNs, IP addresses and
serial numbers on `cmdb_ci`. Use `--class cmdb_ci_server` for an exact class
match (excluding subclasses), and bounded `--limit`/`--offset` pagination.
Search text is literal; encoded-query operators and query scripts are rejected.
Existing `cmdb list --query` remains available for deliberate encoded queries.
Results include show/relationship hints and preserve the selected connection.

### Commands for the connected account

Login and OAuth refresh check for the current account's `admin` role. Profiles
without that role show a compact command list focused on tickets, generic
records, people/groups, documentation, and connection management. If the role
check is unavailable, the profile also uses compact help; this does not assert
that the account lacks admin. Existing profiles keep full help until renewed.

This applies to root help, root JSON, `discover`.
Use `jsn --all-commands --help` or `jsn discover --all-commands --json` to inspect
every registered command. Explicit command paths remain available and ServiceNow
ACLs decide access. Reauthenticate (or refresh OAuth) after roles change.

### Ordering catalog items

Use `jsn catalogitems search "laptop" --profile work`, then
`jsn catalogitems describe <item-sys-id> --profile work` to inspect pricing and
variable definitions through the native Service Catalog API. Create a JSON file
mapping variable names to values, then preview with
`jsn catalogitems order <item-sys-id> --variables-file variables.json --dry-run --profile work`.
Omit `--dry-run` to submit after confirmation. `--quantity` defaults to one;
`--requested-for` accepts a user sys_id subject to instance delegation rules.

`show` is the one view of an item — `describe` and `inputs` are aliases for it.
It reads the item twice and answers once: the Table API gives the definition
(`sc_cat_item` plus `item_option_new`), and
`/api/sn_sc/servicecatalog/items/{id}` gives what this account can actually
request. The catalog API wins when it answers; the definition list keeps the
command working when it does not, with `variables_source` naming which one
answered and `variables_api_error` carrying the reason for the fallback.

Questions come back as `{name, label, type, friendly_type, mandatory,
instance_supplied}` with `required_variables` and `instance_supplied_variables`,
so a script can build the payload without guessing names or types. Layout
entries that draw the form but hold no value — containers, labels, HTML and rich
text blocks, breaks and UI macros — are not reported as questions; only their
container children are walked. `required_variables` excludes the
instance-supplied ones: "Requested for" (type 31) is mandatory in the API
payload, but the instance fills it from the session and `--requested-for`
overrides it. `order` refuses locally when a required question is missing and an
unknown variable name is reported as `unknown_variable_names` without blocking.
The server remains the authority.

What the API returns is what a caller can send: questions withheld by a catalog UI
policy are absent, and a policy-applied mandatory flag is not visible here, so the
server still decides at submission. Record producers and order guides expose their
variables but are not orderable through `order`.

Orders use `order_now`, preserving catalog fulfillment rather than inserting an
RITM directly. `order_now` returns the request (REQ); JSN then reads the request's
items and reports `request_id`, `request_number` and `requested_items`
(`sys_id`/`number`). If that follow-up read is denied, the order is still
reported as placed with `requested_items_readable: false` — inspect requests
rather than resubmitting. The command handles standard catalog items; record
producers and order guides require separate workflows. Server rules validate
dynamic variables at submission; a preview does not validate those rules.
Preview output lists variable names and required names, not entered values.
Previews only read, so they work on a read-only profile; submitting requires a
write-enabled profile and no development update set. Confirmation follows the
existing profile policy; automation can supply `--force` only for an approved
order. Timeout or incomplete response is an uncertain outcome: inspect requests
before retrying. JSN does not automatically submit a second order.
`create/list/show` retain their definition-management behavior.

See the [Service Catalog API reference](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html).

### Viewing service and HR cases

`jsn cases list`, `jsn cases show <number>` and `jsn cases search "<text>"` read
cases through the normal authenticated Table API. Which case table is meant
depends on the installed application, so JSN probes the known case tables in
order — `sn_customerservice_case` (Customer Service Management), then
`sn_hr_core_case` (HR Service Delivery) — and uses the first one the profile can
read. `jsn cases tables` reports each candidate without claiming access, and
`--table <name>` names any other case table.

```bash
jsn cases list --json
jsn cases list --hr --query "active=true"
jsn cases search "printer" --table sn_customerservice_case
jsn cases show CS0001001
```

Visibility is not widened by JSN: application roles and ACLs decide which
records are returned, and a denied table reports `forbidden` (HTTP 403) rather
than an empty list. An instance without a case application reports which tables
were unavailable instead of pretending there are no cases, and naming such a
table with `--table` fails the same way (`Reading <table> failed (HTTP 400)`,
exit 2) instead of printing an empty list. To scope a list to the connected
account, add a query term — field names differ per application, for example
`--query "opened_by=javascript:gs.getUserID()"`. These commands only read; case
work that changes state stays in the application UI or `jsn records update`.

HR cases are a thin addition over this generic path: `--hr` selects
`sn_hr_core_case`. Employee self-service visibility depends on the HR roles and
ACLs of the connected account — an administrator profile does not represent an
employee's view. HR case tasks, relations and the employee portal's widgets are
not exposed yet.

## Domain configuration and browser sessions

`jsn domains current` reports the selected profile's configured `X-Now-Domain`
header. `domains set <name-or-id>` and `domains set clear` configure that header
locally. Header effectiveness depends on the instance; clearing it does not
reset the actual server session domain.

With saved browser-session (`gck`) credentials, use these explicit commands:

```bash
jsn domains session-current --profile example --json
jsn domains session-list --profile example --search '*Internal' --limit 20 --offset 0 --json
jsn domains session-reset --profile example --json
jsn domains session-list --profile example --json
jsn domains session-set <domain-sys-id> --profile example --json
```

`session-list` returns one picker-visible page (`items`, `offset`, `limit`,
`next_offset`). Search matches a name prefix, or a substring with a leading `*`.
Visibility depends on the actual session domain. For cross-branch selection,
explicitly reset to global, then list and select a domain from that result.
Neither listing nor selecting silently resets the session. `session-current`
reports both `configured_domain` and `session_domain`.

**Session reset and selection may affect a browser sharing these credentials.**
Both commands verify the resulting domain with a separate readback. They leave
profile configuration unchanged and omit the configured domain header on picker
requests. Save the original domain ID from `session-current` if you intend to
restore it afterward. A failed readback can leave the session changed; inspect
`session-current` before retrying. These commands do not call `touch-session`.
Other authentication methods retain the existing profile configuration flow.
