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

## Command Hierarchy

Pick the most specific tool for the job:

1. **Specific commands** — `rules`, `flows`, `jobs`, etc. — curated views with domain-aware formatting
2. **`records --table <name>`** — generic CRUD on any table (the workhorse)
3. **`rest`** — raw escape hatch for any REST endpoint
4. **Ask the human** — if none of the above work. Never generate scripts as a fallback.

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
