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

- Verify the intended instance and select it explicitly with `--profile <name>`.
- Prefer purpose-built or records commands over `eval`. Explain the need and get
  approval before using eval; avoid bypassing ServiceNow protections.
- Honor delete confirmations. Get approval for destructive work and Global +
  Default mutations; use `--force` only for the approved operation.

For development:

1. Choose or create the application scope and update set.
2. Do the work, keeping related changes together.
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
Watching needs a browser session (`jsn auth login --browser`).

For incoming update sets: import the XML, preview the set, and resolve preview
errors with the human where needed. Once the preview is clear, commit the set
and verify the results.

Search documentation with `jsn docs "query"` or read with `jsn docs --path <path>`.
Documentation source and defaults for future connections are configured in `jsn setup`.
