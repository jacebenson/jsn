---
name: servicenow
description: Use the jsn CLI for ServiceNow development, administration, and data exploration.
license: MIT
metadata:
  author: jacebenson
  version: "4.3.14"
  repository: https://github.com/jacebenson/jsn
---

# ServiceNow with JSN

Discover commands with `jsn --help`, `jsn discover "search words"`, and
`jsn <command> --help`.
A choice field's valid values are in `jsn columns show <table>.<column>`, which
names the table they come from when they are inherited from a parent.

- Verify the intended instance and select it explicitly with `--profile <name>`.
- Prefer purpose-built or records commands over `eval`. Explain the need and get
  approval before using eval; avoid bypassing ServiceNow protections.
- Honor delete confirmations. Get approval for destructive work and Global +
  Default mutations; use `--force` only for the approved operation.
- Restoring a deleted record is `jsn records undelete --table <t> --sys-id <id>`,
  not `eval`. It brings back the newest copy in Deleted Records with its sys_id;
  attachments and records its delete cascaded to stay deleted.
- Deleting several records by filter is `jsn records delete-many`, not `eval`.
  It previews without `--yes`, and a real delete requires the exact
  `--expect-count` from that preview.
- Copying records between instances as XML starts with `jsn records export`,
  which keeps sys_ids and refuses a query the instance would widen or truncate.
  `jsn records import <file>` loads that file into the target (admin; it skips
  business rules and overwrites matching sys_ids). It previews without `--yes`
  and re-reads every record afterwards, exiting nonzero unless each one landed.
- Why a user holds a role is `jsn users roles <user> --why --role <name>`, not
  `eval` or raw REST: every path (direct, contained role, group) from the
  platform's User Role Inheritance API, which needs `user_admin`.
  Add `--preview-cascade` to see the records in other tables the delete would
  cascade to before asking for approval. It is a write: it creates and deletes
  one Data Management delete job (admin), and leaves its count rows behind.
- The decision a decision table picks is
  `jsn decisiontables evaluate <name> --input <name>=<value>`, not `eval`. It
  refuses an input the table does not have, a missing mandatory input and a
  choice label where the value belongs, which the evaluator would otherwise
  answer with its default decision.
- Finding a REST endpoint is `jsn scrapi search <words>`, which lists every API on
  the instance, out of the box and scripted, with its method and route; then
  `jsn scrapi spec "<API name>"` prints its OpenAPI document.

For development:

1. Choose or create the application scope and update set.
2. Supply task-owned `--expect-scope <scope/name/id>` and
   `--expect-update-set <name/id>` on customization writes, or explicitly save
   profile-and-instance-bound `write_context` in local `.servicenow/config.json`.
   Never derive intended values from current preferences. `--force` cannot bypass
   missing intent, unknown context or mismatches. Domain-scoped customization
   currently refuses, including `--expect-domain`, because `X-Now-Domain` does not
   prove effective domain. Inspect with `auth status --context`; `--local` is offline.
   Reads never print or fetch automatic context. Ordinary ticket/data edits do not
   need customization expectations. Keep related development changes together.
3. Verify the results on the instance and report where changes were captured.
4. Offer to run relevant existing ATFs and instance scans, or create missing checks.
5. Ask whether anything else belongs in the update set. If the user confirms
   it is finished, complete it with notes.

Tracking a record: when the user asks to track, watch or be told about changes
to an incident, task, change request or other record, use
`jsn records watch --table <table> --sys-id <id> --timeout <seconds> --json`.
It streams newline-delimited JSON (`record_change`, `gap`, `watch_summary`),
so run it for a bounded window and report what arrived; schedules and user
notifications belong to your runtime, not to the command. Use `--max-events 1`
for a single-change check. A `gap` or `"complete": false` means events were
missed — read the record's current state rather than assuming continuity.
To watch every record matching a query, use `--query "<encoded query>"`
instead of `--sys-id`; each event's `match` is `entry`, `change` or `exit`
(`exit` means the record stopped matching or was deleted). Narrow it with
`--operation insert|update|delete` and `--on-change <field,field>`. Basic,
OAuth and browser profiles all work.

Configuration history: to see what an earlier version of a script, rule or other
update-set-tracked record held, or which update set captured it last, use
`jsn records versions <table> <sys_id> [--diff N]`. It reads saved versions,
not the live record; no versions does not mean unchanged.

Checking what a user can see: add `--impersonate <user_name>` to a read, for
example `jsn records list --table incident --impersonate abel.tuter --json`,
instead of an eval with `gs.getSession().impersonate`. It needs the admin or
impersonator role. A record write as that user stops with
`confirmation_required` before any request; ask the human, then re-run with
`--impersonate-writes`. Customization writes, `eval` and `rest` writes are
refused under `--impersonate`; make those as the profile's own user.

For incoming update sets: import the XML, preview the set, and resolve preview
errors with the human where needed. Once the preview is clear, commit the set
and verify the results.

Slow queries and scripts: to see what the platform logged as slow, use
`jsn perf slow [--type queries|scripts|transactions|events|mutex|cache]`, ranked
by total time, then `jsn perf slow show <sys_id>` for the full SQL and the stack
trace naming the code that issued it. Both are reads; an empty list does not
prove nothing is slow.

Search documentation with `jsn docs "query"` or read with `jsn docs --path <path>`.
Documentation source and defaults for future connections are configured in `jsn setup`.
