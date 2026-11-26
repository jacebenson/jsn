---
name: servicenow
description: Use the jsn CLI for ServiceNow development, administration, and data exploration.
license: MIT
metadata:
  author: jacebenson
  version: "4.3.15"
  repository: https://github.com/jacebenson/jsn
---

# ServiceNow with JSN

Discover commands with `jsn --help`, `jsn discover "search words"`, and
`jsn <command> --help`. Help is the reference; this file is the shortcuts.

- Verify the intended instance and select it explicitly with `--profile <name>`.
- `eval` is the last resort. Explain why it is needed and get approval; never
  bypass ServiceNow protections to get an answer.
- Honor delete confirmations. Get approval for destructive work and Global +
  Default mutations; use `--force` only for the approved operation.

## Before you reach for eval

| You want | Use |
| --- | --- |
| A choice field's values | `jsn columns show <table>.<column>` |
| A REST endpoint, or its spec | `jsn scrapi search <words>`, `jsn scrapi spec "<API>"` |
| Why a user holds a role | `jsn users roles <user> --why --role <name>` |
| What the platform logged as slow | `jsn perf slow`, `jsn perf slow show <sys_id>` |
| A decision table's outcome | `jsn decisiontables evaluate <name> --input k=v` |
| Delete by filter | `jsn records delete-many` (needs the previewed `--expect-count`) |
| Stop auditing a field or deletes | `jsn tables audit exclude <table> <field>`, `audit deletes <table> off` |
| Undo a delete | `jsn records deleted`, then `records undelete` |
| Undo a background script | `jsn eval rollback <execution>` |
| A record's versions, or revert to base | `jsn records versions <table> <sys_id>`, `records revert` |
| Watch a record or a query | `jsn records watch --table <t> --sys-id <id>` or `--query` |
| Copy records between instances | `jsn records export`, then `jsn records import <file>` |
| Load an import set | `jsn import load <table> --file rows.json\|csv` |
| What a user can see | `--impersonate <user_name>` on a read |
| Why a user cannot reach a record | `jsn access-analyzer check --user <u> --table <t> --record <id>` |
| Documentation | `jsn docs "query"` or `jsn docs --path <path>` |

Every write in that table previews without `--yes`, and `--yes` on a delete needs
the count its preview printed. Cascade previews and impersonated writes are
writes too: `--preview-cascade` creates and deletes one Data Management job, and
writing as another user needs the human's approval plus `--impersonate-writes`.

Watching streams newline-delimited JSON (`record_change`, `gap`,
`watch_summary`). Run it for a bounded window and report what arrived; a `gap` or
`"complete": false` means events were missed, so re-read the record.

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
5. Ask whether anything else belongs in the update set; if it is finished,
   complete it with notes.

For incoming update sets: import the XML, preview the set, and resolve preview
errors with the human where needed. Once the preview is clear, commit the set
and verify the results.
