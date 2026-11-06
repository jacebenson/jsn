# Legacy Workflow Editor inspection (read-only)

`jsn workflows` inspects existing **legacy Workflow Editor** workflows — the
`wf_workflow`, `wf_workflow_version`, `wf_activity`, `wf_transition` and
`wf_condition` records — for troubleshooting and migration evidence.

It is not an authoring tool. It never checks out, edits, publishes, discards or
deletes a workflow, and it never converts or executes one. Reading does not
require a checkout.

## `flows` is Flow Designer; `workflows` is the legacy editor

The two engines have separate records and separate commands:

| Command | Engine | Records |
| --- | --- | --- |
| `jsn flows …` | Flow Designer | `sys_hub_flow`, `sys_flow_context`, … |
| `jsn workflows …` | Legacy Workflow Editor | `wf_workflow`, `wf_workflow_version`, `wf_activity`, … |

`workflow` (singular) and `workflows get` are aliases for the same read-only
command; `flows` is unchanged and keeps its existing mutation surface.

## Commands

```bash
jsn workflows list --table incident                 # published + checked-out state per workflow
jsn workflows list --name approval --limit 50 --offset 50
jsn workflows show "Incident approval"              # published version, else newest
jsn workflows show <workflow_sys_id> --version <version_sys_id>
jsn workflows show "Incident approval" --json       # structured definition with every ID
jsn workflows show "Incident approval" --json --get data.activities.0.sys_id
jsn workflows show "Incident approval" --config     # content and activity types under numbered steps
jsn workflows show "Incident approval" --no-config  # skip activity variables/scripts
```

`show` accepts a workflow name, a `wf_workflow` sys_id, or a
`wf_workflow_version` sys_id. A name that matches more than one workflow is an
`ambiguous` error naming each candidate, never an arbitrary pick.

Selection is explicit in the output:

- `--version` — the requested version, which must belong to that workflow;
- otherwise the **published** version (the active one if several are marked
  published);
- otherwise the **newest** version, which is a draft or retired version.

`list` uses one-row lookahead with `limit`/`offset`; `has_more` is a fact about
the next row, not a guess. `show` bounds activities with `--limit` (default 200)
and reports `coverage.activity_sample.truncated` when the bound was reached.
A truncated sample never turns absent links into `dangling` claims — those are
reported as `outside_sample` instead.

## Human outline and structured output

Human output is an outline: workflow and version provenance, every version with
its published/checked-out status, numbered steps, exceptional transitions,
stages and integrity warnings. Record IDs stay in JSON. Without `--config`,
step content stays hidden. With `--config`, each step shows its activity type
when known and every nonempty configured element beneath it, sorted by field
name and aligned as `field: value`. Multiline values preview three lines;
individual lines preview at most 160 characters. Explicit omission markers
point to `--json` for the full value. Comment-only scripts retain per-step
omission notes rather than printing their bodies. There is no trailing
configuration section.

Configuration reads and the flat JSON `configuration` objects are unchanged;
`--no-config` still skips those reads. Rendering adds no instance queries.

`--json` returns the same facts with stable field names, including:

- `workflow`, `versions[]`, `version`, and `selection.reason`;
- `activities[]` with `definition_id`, `definition_name`, `definition_status`,
  `position`, `parent_id`, `stage_id`, `conditions[]` and `configuration`;
- `transitions[]` with `from_id`, `to_id`, `condition_id`, `condition_status`
  and `status` (`ok`, `dangling`, `outside_sample`);
- `transitions_by_activity[]` with activity `sys_id`, `name`, and outgoing
  `transitions[]`, including empty groups. Groups sort by name then sys_id;
  edges sort by destination name then transition sys_id. The existing flat
  `transitions[]` is unchanged and duplicate edges remain distinct;
- `loops[]` with `members[]` (sys_id and name), `edges[]` (all internal SCC
  edges), and `entry_points[]` (members with incoming edges from outside);
- `integrity` — `missing_activity_definitions`, `unset_activity_definitions`,
  `dangling_transitions`, `unresolved_transition_conditions`,
  `dangling_start_activity`, `inaccessible`;
- `coverage` — per-component read state and whether the activity sample was
  truncated. `loops_found` counts observed SCC loops; `loop_detection_complete`
  is false if graph reads failed, activities were truncated, any transition read
  reached its bound, or any endpoint is outside the loaded activities.
  `transitions_truncated` records a reached transition bound and also makes
  overall `coverage.complete` false.

The outline groups transitions under source activities, marks every internal
cycle edge with `↺`, and lists loop members, cycle/closing edges and entry points
in `▶ LOOPS`. SCCs with multiple members and self-loops both count. All internal
SCC edges participate in a cycle; this is not a claim that each edge is a unique
DFS back-edge or that every simple cycle is enumerated. Analysis uses loaded
rows only, with no additional queries or writes.

A complete acyclic graph says `no loops detected`. An incomplete graph instead
says detection is incomplete, even if no cycle was observed. Observed loops
remain visible in partial samples, but their membership and entry points may be
incomplete. Missing conditions/configuration/type definitions do not invalidate
known graph topology; existing integrity warnings remain separate. Consequently
`coverage.complete` and `loop_detection_complete` intentionally answer different
questions (for example a dangling endpoint invalidates loop completeness even
when all component reads succeeded).

## Missing and inaccessible definitions are explicit

A denied or missing component is never rendered as empty data:

- HTTP 401/403 on a component becomes `inaccessible` with `http_status` in
  `coverage.components` and `integrity.inaccessible`, while the rest of the
  readable definition is still returned;
- a missing `wf_*` table is `unavailable` (layout difference, not an empty
  workflow);
- an activity whose `wf_element_definition` row was not returned is listed in
  `integrity.missing_activity_definitions` and has `definition_status: "missing"`;
- transitions or a start pointer that reference an activity outside the read
  set are listed rather than silently dropped.

## Definition inspection is not runtime history

Every response carries `definition_scope`: the selected version's **design-time
configuration**. This is not evidence that this version executed, and this
command does not read runtime contexts or history. A published version can
differ from the configuration that produced a past execution; treat migration
or troubleshooting conclusions accordingly.

## Supported platform layout and permissions

Supported legacy editor layout (field names follow the Workflow Editor schema,
also used by the reference `WorkflowManager` implementation):

| Table | Fields read |
| --- | --- |
| `wf_workflow` | `sys_id,name,table,description` |
| `wf_workflow_version` | `sys_id,workflow,name,table,published,active,checked_out,checked_out_by,checked_out_by.name,condition,condition_type,start,full_sequences,sys_created_on,sys_updated_on` |
| `wf_activity` | `sys_id,name,activity_definition,activity_definition.name,parent,stage,x,y,width,height,input` |
| `wf_condition` | `sys_id,activity,name,condition,order,else_flag,error,event,event_name,short_description,skip_during_generate` |
| `wf_transition` | `sys_id,from,to,condition` |
| `wf_stage` | `sys_id,name,value,order` (optional) |
| `sys_variable_value` | `document_key,variable.element,value` for `document=wf_activity` (activity configuration and scripts) |
| `wf_element_definition` | `sys_id,name,description,sys_class_name` |

Required permissions are read-only: read ACLs on the tables above, including
`sys_variable_value` for activity configuration and `wf_element_definition` for
activity-type names. Workflow designers/administrators normally have these;
without them the affected component is reported as `inaccessible`. No write ACL
or checkout is required.

All requests are Table API `GET`s. Authentication session bootstrap requests are
the only non-GET traffic; no record is created, updated or deleted.

## Validated instances

Synthetic graph tests cover DAGs, SCCs, self-loops, disjoint loops, duplicate
edges, branch-only loops and incomplete reads, with JSON and outline assertions.
Read-only checks with the host's authenticated `demo` profile also verified:

- Standard Change Proposal (`3452d5259f2002002920bde8132e7028`): 13 activities,
  15 transitions, one SCC loop; both edges returning to Change Manager Group
  Approval are included.
- Change Request - Standard (`9c55dac2cb200200d71cb9c0c24c9c83`): 10 activities,
  11 transitions, zero loops, explicitly reported as `no loops detected`.
- On-Call: Assign by Acknowledgement per Rota
  (`ddfa60feb748230059e0b956ee11a937`): 65 activities, 103 transitions, one SCC
  loop; inspection completed normally.

All three reported complete graph detection. These checks validate the selected
definitions, not runtime execution or compatibility with every platform release;
no platform release version was established in these checks.

## Reuse from table-behavior discovery (#398)

`src/workflow-inspection.js` exports
`listPublishedWorkflowVersionsForTable(sdk, table, { limit })`. It reports the
published workflow versions whose `table` matches and explicitly states that it
does not discover script-started or condition-started workflows. Table-behavior
discovery can use it for the known table association without claiming a complete
automation inventory.
