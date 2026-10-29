---
name: servicenow
description: |
  Interact with ServiceNow instances via the jsn CLI. Use when working with ServiceNow
  development, administration, or data exploration. Handles tables, records, business rules,
  flows, script includes, ACLs, update sets, and more. Triggered by ServiceNow URLs
  (service-now.com, servicenow.com) or when the user mentions ServiceNow, jsn, servicenow,
  or related terms like tables, records, business rules, flows, script includes, ACLs,
  update sets, or encoded queries.
license: MIT
compatibility: |
  Requires jsn CLI (github.com/jacebenson/jsn). Install via:
  npm install -g @jacebenson/jsn
  Works with Claude Code, OpenCode, Cursor, and agentskills-compatible tools.
metadata:
  author: jacebenson
  version: "4.3.13"
  repository: https://github.com/jacebenson/jsn
---


# ServiceNow with JSN

Use `jsn --help`, `jsn discover "search words"`, and `jsn <command> --help` for the
installed CLI's capabilities, options and examples. Use `--json` for machine
parsing and text for people.

## Agent decisions

- Verify the intended instance and use `--profile <name>` explicitly; never
  assume the default connection is correct. Use `jsn setup` and `jsn auth`
  for configuration and authentication operations.
- Use supported human identifiers or partial IDs where available. Let the CLI
  resolve them; on an ambiguous or missing match, inspect candidates and narrow
  the target rather than guessing. Generic record views keep their presentation;
  specialized views provide domain-specific context.
- Ordinary creates and updates need no additional confirmation. Deletes confirm
  by default unless the profile's single skip-delete preference is enabled.
  Mutations in Global scope plus the Default update set require explicit approval even for
  creates/updates; the skip-delete preference does not authorize that context.
  Use `--force` only after the human has approved the exact operation and context.
- Prefer purpose-built or records commands. Never use `eval` to bypass a blocked
  business rule, ACL or other ServiceNow protection. If eval is genuinely needed,
  explain why and obtain explicit user approval before running it.
- All raw REST requests remain blocked on read-only profiles, including GET.
  Follow actionable authentication errors; no status preflight is required before
  each operation.

## ServiceNow development workflow

Identify the intended application scope and update set before making development
changes. Keep related changes together, use the appropriate update-set or
application deployment mechanism, and report where changes were captured.
Not all record changes are update-set tracked.

Only complete an update set when the human explicitly asks, including sets you
created. Completing the current set returns its selection to Default; identify
the intended capture context again before further development.

## Investigating behavior

For field visibility, read-only or persistence problems, investigate the symptom:
access controls, dictionary inheritance/overrides, server rules, client scripts
and UI policies can contribute. Use the relevant command help and inspect actual
conditions and related records; there is no universal check order. Explain the
cause before proposing a change, and do not bypass a protection to make a write
succeed.

Use `jsn customizations --help` for bounded read-only evidence capture and offline
review. Read interpretation, coverage and triage before drawing conclusions;
verify ownership and current behavior before proposing changes, and never treat
triage as approval for automatic reversion.

JSN provides optional local, searchable ServiceNow documentation without an
instance connection; discover it with `jsn docs --help`.
