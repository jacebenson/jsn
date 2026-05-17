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
  curl -fsSL https://jsn.jace.pro/install | bash
  Works with Claude Code, OpenCode, Cursor, and agentskills-compatible tools.
  
  Windows users: Download from GitHub releases. If jsn is not in your PATH, the setup
  command will automatically detect its location and show the correct command path
  (e.g., `.\jsn.exe tables list` instead of `jsn tables list`).
metadata:
  author: jacebenson
  version: "1.0.0"
  repository: https://github.com/jacebenson/jsn
---

# Jace's ServiceNow CLI

Explore and manage ServiceNow instances. Works standalone or with AI agents.

## Discovery

Commands are self-documenting. Use these to learn what's available:

```bash
jsn commands --md         # Full catalog with descriptions, actions, and hints
jsn <command> --help      # Detailed usage, flags, and examples for any command
```

## Agent Rules

1. **Output modes** — `--json` when parsing data; `--md` when presenting to humans; `--agent` for automation
2. **Use sys_id for updates** — All update/delete operations require sys_id
3. **Check auth first** — Run `jsn auth status` before operations
4. **NEVER logout** — Only run `jsn auth logout` if the user explicitly asks
5. **Use `--profile <name>`** to target a specific instance, or `jsn config switch <name>` to change default
6. **Before using `eval` or `rest`** — Ask yourself: *"Have I checked if there's a more specific jsn command?"* Verify `jsn records --table <name> create` won't work first. Prefer specific over generic over escape hatch over eval.

## ⚠️ AVOID `jsn eval` for Record Creation

**Why:** `jsn eval` runs server-side JavaScript in the global scope. It returns HTTP 200 even when:
- The insert fails due to ACL violations
- Mandatory fields are missing
- The record lands in the wrong scope
- Logic errors prevent the insert entirely

**The AI trap:** Agents see "success" and assume the record was created. It wasn't.

**Always use instead:** `jsn records --table <name> create` — it returns the created record with sys_id or an explicit validation error.

**Only use `eval` when:** No specific command exists, `records` lacks required fields, and `rest` doesn't work. This is rare.

## Command Hierarchy

Pick the most specific tool for the job. **Never default to eval** — it's the last resort:

1. **Specific commands** — `jsn flows`, `jsn rules`, `jsn jobs`, etc. — curated views with domain-aware formatting and validation
2. **`jsn records --table <name>`** — generic CRUD on any table (the workhorse, preferred for record creation)
3. **`jsn rest`** — raw Table API escape hatch when records command lacks required fields
4. **`jsn eval`** — ⚠️ **LAST RESORT ONLY** — server-side script execution when no other option exists
5. **Ask the human** — if none of the above work. Never generate standalone GlideRecord scripts as a fallback.

## JSON Envelope

All commands support `--json`. The envelope structure:

```json
{
  "ok": true,
  "data": [ ... ],
  "summary": "5 records",
  "breadcrumbs": [
    {"action": "show", "cmd": "jsn records --table incident <sys_id>", "description": "View details"}
  ]
}
```

Breadcrumbs suggest next commands — follow them for navigation.

## Configuration

```
~/.config/servicenow/
├── config.json               # Profiles and settings
└── credentials.json          # Auth tokens (fallback)

.servicenow/                  # Per-repo config (optional)
└── config.json               # Project-specific settings
```

**Environment variables:**
- `SERVICENOW_TOKEN` — Override stored token
- `SERVICENOW_INSTANCE` — Override instance URL
