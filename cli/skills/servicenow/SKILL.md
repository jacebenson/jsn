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
- `eval` and `fixscripts run` are the last resort: explain why, get approval, never
  bypass ServiceNow protections for an answer.
- Honor delete confirmations; get approval for destructive and Global + Default
  mutations. `--force` is for the approved operation only.

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
| A record's versions, or revert to base | `jsn records versions <table> <sys_id>`, `records revert`, `customizations revert` |
| Watch a record or a query | `jsn records watch --table <t> --sys-id <id>` or `--query` |
| Copy records between instances | `jsn records export`, then `jsn records import <file>` |
| Load an import set | `jsn import load <table> --file rows.json\|csv` |
| What a user can see | `--impersonate <user_name>` on a read |
| Why a user cannot reach a record | `jsn access-analyzer check --user <u> --table <t> --record <id>` |
| Documentation | `jsn docs "query"` or `jsn docs --path <path>` |

Every write in that table previews first; `--yes` on a delete needs the count its
preview printed. `--preview-cascade` writes too (one Data Management job), and
impersonated writes need the human's approval plus `--impersonate-writes`.

Watching streams NDJSON (`record_change`, `gap`, `watch_summary`); run it for a bounded
window and report what arrived. A `gap` or `"complete": false` means events were missed,
so re-read the record.

For development:

1. Choose or create the application scope and update set.
2. Supply task-owned `--expect-scope <scope/name/id>` and `--expect-update-set <name/id>`
   on customization writes, or save profile-and-instance-bound `write_context` in local
   `.servicenow/config.json`. Never derive intended values from current preferences, and
   `--force` cannot bypass missing intent, unknown context or mismatches. Domain-scoped
   customization refuses, including `--expect-domain`, because `X-Now-Domain` does not
   prove effective domain; inspect with `auth status --context`. Reads never print or
   fetch automatic context, and ordinary ticket/data edits need no expectations.
3. Verify the results on the instance and report where changes were captured.
4. Read the target's effective preferences with `jsn preferences show --profile <p> --json`
   (or `--instance <URL>`): an `operations` denial cannot be forced past, `testing` names
   the checks to offer (none when `recommend` is false or methods are empty), and
   `suggestMissing` gates proposing new ones. `jsn atf` and `jsn scan` stay available;
   never auto-create or auto-run tests.
5. Ask whether anything else belongs; when finished, complete it with notes.

For incoming update sets: import the XML, preview it, resolve preview errors with the
human, then commit and verify.
