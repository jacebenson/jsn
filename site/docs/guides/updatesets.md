---
title: Update sets and transfers
---

Transfer update sets between instances and read compact update-set diffs.

## Intended write context

Reads have no automatic context banner and make no automatic user, scope or
update-set context requests. Inspect context explicitly:

```sh
jsn --profile dev auth status --context
jsn --profile dev auth status --context --local --json
```

`--context` selects one profile, defaulting to the active profile. The existing
all-profile status output is unchanged without this option. `--local` makes zero
requests and never reports live context as verified. Domain output distinguishes
the requested header from effective domain verification.

Bots must supply independently intended scope and capture set before customization:

```sh
jsn --profile dev includes create -f name=TaskHelper --expect-scope x_example_app --expect-update-set "Task feature" --json
```

Use the scope, application name or sys_id and update-set name or sys_id from the
task, not values copied from the current preferences. Names must resolve uniquely.
Unknown, ambiguous, incomplete, completed, mismatched or unreadable context blocks
before mutation. Fresh preferences and effective session picker selections must
agree. Nothing automatically switches context. Select explicitly with `scopes set`
or `updatesets set` and retry. `--force` cannot bypass intent or mismatch checks.
Global + Default still requires separate approval for the exact operation. Human
interactive use can confirm fresh context when expectations were omitted.

For a task directory, explicitly write `.servicenow/config.json`:

```json
{
  "write_context": {
    "profile": "dev",
    "instance_url": "https://example.service-now.com",
    "scope": "x_example_app",
    "update_set": "Task feature"
  }
}
```

These are illustrative task-owned values, not discovered defaults. CLI expectation
flags override individual saved fields. A present local binding must exactly match
the selected profile and instance URL, even when flags override its values. Global
config never supplies write expectations, and normal configuration saves never
promote these task-local expectations into global settings.

Ordinary ticket/data edits do not require capture context. Generic records and
table factories classify customization through `sys_db_object` ancestry to
`sys_metadata`, not command spelling. Unreadable ancestry refuses classification.
Resolved action/flow targets and generic metadata record targets must match the
verified intended scope before mutation. Explicit metadata `sys_scope` payloads
cannot redirect writes; bulk updates preflight every selected target. Transaction
scope flags are capability-declared. `scopes create --scope` names the new scope,
not the transaction scope.
Raw mutation APIs and eval conservatively require customization context. Operational
metadata exemptions cover identity/membership administration, approvals, ATF runs,
attachments, MID runtime operations, catalog ordering, Store installation, domain
selection, and flow test/lock release. Explicit scope selection and update-set
creation/selection/import/preview/commit/reopen keep their own safety gates. Scope
creation is customization and is not exempt.

Successful JSON write envelopes include `context.mutation`, reusable with `--get`.
Interactive writes show one compact context line from that same guard result.
Quiet output remains data-only. Context checks supplement, not replace, command
confirmations, read-only profiles and write-back verification.

### Domain limitation

`--expect-domain` expresses intent but currently refuses customization writes.
Configured domain headers and profiles known to use domain separation also refuse.
The SDK propagates `X-Now-Domain`; this does not prove effective server selection.
No verified provider contract connects that header to every customization transport,
so domain-scoped customization remains unsupported rather than silently trusted.
Ordinary domain-header reads/data edits remain available. No live domain mutation
semantics were verified by this change.

## Transfer an update set

Export without changing the source set's state or your selected capture context:

```sh
jsn --profile source updatesets export "Digital Helpdesk 0.1.77"
# In a terminal: Digital-Helpdesk-0.1.77.xml in the current directory.
jsn --profile source updatesets export "Digital Helpdesk 0.1.77" --out-dir ./exports
jsn --profile source updatesets export "Digital Helpdesk 0.1.77" --stdout > transfer.xml
```

Piped output remains raw XML. `--out FILE` selects an exact filename; `--out-dir`
selects a directory that already exists. Export refuses to overwrite a file.
Explicit JSON output without a file option retains the XML in its data envelope.

Inspect before loading:

```sh
jsn updatesets import transfer.xml --dry-run --json
jsn --profile target updatesets import transfer.xml --yes --json
```

The dry run is entirely local: it lists members with target names and actions,
primary table counts, and subsidiary payload operations such as translation or
flow cleanup. An omitted payload action is labeled `platform_default` rather than
guessed. Imports support one retrieved set per file, up to 50 MiB, and require an
admin session with native XML upload access. Without `--yes`, a terminal prompts;
noninteractive calls return a confirmation-required error with a rerun command.
Normal target selection (`--profile` / `--instance`) and read-only guards apply.

Successful import verifies the loaded set and every member ID/name/action. It
**does not apply the changes**: the set is left `loaded` and uncommitted so the
target can be previewed and reviewed first. Existing retrieved sets or member IDs
cause refusal before upload. A timeout or failed verification may mean partial
loading; inspect Retrieved Update Sets before retrying. The command does not
silently replace an existing set, rename one, convert it to a local set, or
change its state, and it refuses `--name`, `--local`, and `--state` rather than
quietly ignoring them.

Preview, inspect the problems a human must decide, then commit:

```sh
jsn --profile target updatesets preview "Digital Helpdesk 0.1.77" --yes
jsn --profile target updatesets problems "Digital Helpdesk 0.1.77"
jsn --profile target updatesets commit "Digital Helpdesk 0.1.77" --yes
```

`preview` and `commit` run the platform's own steps through the CICD Update Set
API (`sn_cicd`), which needs the CICD plugin and the `sn_cicd.sys_ci_automation`
role. If that API is unavailable, jsn reports it and starts nothing; use System
Update Sets > Retrieved Update Sets instead. Both commands follow the platform
progress tracker (`--timeout` seconds, default 600) and then read the retrieved
set back: `preview` must show `previewed`, `commit` must show `committed`. A
successful call whose state does not match is reported as an error, not assumed.

`problems` is read-only. It lists unresolved preview problems with their
description, missing item/table, and available actions; `--include-resolved`
also shows rows a human already accepted or skipped. jsn **never** accepts,
skips, or ignores a problem, and `commit` refuses while any problem is
unresolved. It also refuses when the problem read reaches its 500-row bound,
because a resolved sample does not prove that unread problems are resolved.
Review and commit such sets in ServiceNow. Resolve problems in ServiceNow, rerun
`preview`, then commit. A commit
resolves the local update set it created through the retrieved record's
`update_set` reference, falling back to a name lookup only when that reference is
absent; an ambiguous or missing local copy is reported, never guessed.

Neither command changes the selected update set or scope.

Reopen a complete or ignored **local** update set explicitly:

```sh
jsn --profile source updatesets reopen "Digital Helpdesk 0.1.77"
```

This verifies `in progress` after the write and leaves selection unchanged. It
does not accept committed sets. Export and import never reopen or complete sets.

## Cross-instance update-set diff

```sh
jsn updatesets diff --source pdi --target vendor
jsn updatesets diff --source pdi --target vendor --from 2w --json
jsn updatesets diff --source pdi --target vendor --from 2026-10-01
jsn updatesets diff --source pdi --target vendor --get data.sets
```

`--source` and `--target` are independent configured profiles; the active profile is not changed. `--from` is a UTC date window, not a profile: default `2w`, relative positive days/weeks (`14d`), or an exact calendar date. Selection is **currently complete** local source sets with `sys_updated_on >= cutoff`. It does not reconstruct completion transitions. Targets are searched across all dates.

Identity follows the existing export/import model: `sys_remote_update_set.remote_sys_id` identifies the original local `sys_update_set.sys_id`. Never match on name. Multiple retrieved candidates for one origin are Unknown, even when names agree. A committed retrieved candidate is Matching only when count-verified `sys_update_xml` captures joined by source `update_set` and target `remote_update_set` have the same unique artifact `name`, `action`, and exact `payload`. Envelope capture IDs, set references, timestamps and updater metadata are not compared. Payload XML is not normalized: representation differences conservatively report Different. This is captured-content evidence, not current-record comparison, preview, dependency analysis or deployment readiness.

Machine statuses remain Matching, Missing (only with complete inventories), Retrieved not committed, Different and Unknown. Default human output labels these **Committed, matching**, **Missing in target**, **Loaded, not committed**, **Content differs** and **Unable to verify**. Each named batch shows its base first, with children indented beneath parents; standalone sets have their own heading. Names are preserved exactly. Older and incomplete members show `Context only (source state)` and do not contribute to the status-count footer. Different sets list only changed artifact names and reasons; Unknown sets show one reason and a next step. The short shared note describes the selection window and captured-content boundary once.

`--verbose` retains full per-set evidence, IDs, source states, capture counts and coverage errors. JSON and `--get` retain the same statuses, identities and evidence regardless of verbosity. Base is derived from the oldest observable `parent` ancestor, not a guessed base field. Cycles and unreadable ancestry remain visible without unbounded traversal. “No selected sets” appears only after a complete source selection; unreadable selection explicitly leaves absence unestablished. The command requires no default profile and suppresses the unrelated active-profile context header.

Operational bounds: each table query uses at most 20 pages of 200 rows, a provider Stats count before and after, stable sys_id ordering, unique identities, strict response arrays and required fields. Short pages continue until the count is met. ACL errors, omitted fields, changing counts and budgets retain error/partial coverage rather than implying absence. These reads are not an atomic snapshot: same-count concurrent changes remain possible. Source hierarchy and the all-dates target inventory can exceed the budget; inspect coverage before using the report. No instance-record writes or eval occur; ordinary SDK authentication refresh/bootstrap remains permitted.

The fixture test uses the real CLI with two distinct profile identities and a local HTTP server; no live ServiceNow verification or live fixture creation is claimed.
