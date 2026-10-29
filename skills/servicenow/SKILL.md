---
name: servicenow
description: Use the jsn CLI for ServiceNow development, administration, and data exploration.
license: MIT
metadata:
  author: jacebenson
  version: "4.3.13"
  repository: https://github.com/jacebenson/jsn
---

# ServiceNow with JSN

Discover capabilities with `jsn --help`, `jsn discover "search words"`, and
`jsn <command> --help`. Command help owns options, examples and workflows.

- Verify the intended instance and use `--profile <name>` explicitly; never
  assume the default connection is correct.
- Prefer purpose-built or records commands. Explain why `eval` is necessary and
  obtain explicit human approval before running it. Never use it to bypass
  business rules, ACLs or other ServiceNow protections.
- Do not treat permission for ordinary changes as authorization for destructive
  operations. Honor delete confirmation preferences; they do not authorize
  mutations in Global scope plus the Default update set. Obtain explicit human
  approval for that context, and use `--force` only for the approved operation.
- Identify the application scope and update set before development changes.
  Keep related changes together and report where they were captured; not every
  record change is update-set tracked.
- Complete an update set only when the human explicitly asks, including sets
  you created. Completing the current set selects Default; identify the intended
  capture context again before further development.
- Investigate field symptoms across access controls, dictionary inheritance and
  overrides, server rules, client scripts and UI policies. Inspect conditions
  and related records; there is no universal check order. Explain the cause
  before proposing a change, without bypassing protections to make writes work.
- Treat customization interpretation and triage as evidence with coverage limits.
  Verify ownership and current behavior before proposing changes; findings never
  authorize automatic reversion.
