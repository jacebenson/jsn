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
  version: "4.3.6"
  repository: https://github.com/jacebenson/jsn
---

# Jace's ServiceNow CLI (jsn)

Explore and manage ServiceNow instances. Interactive paginated pickers with server-side search on all list commands.

## Discovery

```bash
jsn --help                # All commands grouped by domain
jsn <command> --help      # Flags, subcommands, and examples
```

## Interactive Picker

All `list` subcommands use a paginated interactive picker in TTY mode:
- Arrow through items (10 per page)
- Type to search (server-side LIKE query)
- Scroll past last loaded item to load next page
- Enter to select, Esc to cancel
- Falls back to table output with `--json`

## Agent Rules

1. **Output modes** — `--json` when parsing data; text when presenting to humans
2. **Use sys_id for updates** — All update/delete operations require sys_id
3. **Check auth first** — Run `jsn auth status` before operations
4. **NEVER logout** — Only run `jsn auth logout` if the user explicitly asks
5. **Use `--profile <name>`** to target a specific instance, or `jsn auth switch <name>` to change the default
6. **Before using `eval` or `rest`** — Ask: *"Is there a more specific jsn command?"* Prefer specific over generic over escape hatch over eval.
7. **CONFIRM before destructive operations** — Show what will be created/updated/deleted and ask for approval.

## Command Hierarchy

Pick the most specific tool for the job. **Never default to eval** — it's the last resort:

1. **Specific commands** — `jsn flows`, `jsn rules`, `jsn catalogitems`, etc.
2. **`jsn records --table <name>`** — generic CRUD on any table
3. **`jsn docs <query>`** — hosted ServiceNow documentation search (no instance needed)
4. **`jsn rest`** — raw Table API escape hatch
5. **`jsn eval`** — ⚠️ **LAST RESORT ONLY**
6. **Ask the human** — if none of the above work

## Key Commands

| Domain | Commands |
|--------|---------|
| **Core** | `incidents`, `changes`, `requests`, `tasks` |
| **Catalog** | `catalogitems list/show/create` — items with variables and flow info |
| **Automation** | `flows`, `actions`, `rules`, `triggers`, `scheduledjobs` |
| **Access** | `acls`, `b4rules`, `roles`, `groups`, `users` |
| **UX** | `forms` (section/element layout), `lists`, `clientscripts`, `uipolicies` |
| **Data** | `tables`, `columns`, `includes`, `logs`, `properties`, `records` |
| **Config** | `setup`, `auth`, `updatesets`, `scopes` |
| **Docs** | `docs search`, `docs show`, `docs status` |
| **Developer** | `eval`, `rest`, `skill`, `version` |

### Customization evidence

```sh
jsn customizations capture --label review --customer-scope x_acme_app --json
jsn customizations list --json
jsn customizations show <run_id> --get data.categories
jsn customizations show <run_id> --get data.triage
jsn customizations html <run_id> [--out review.html]
jsn customizations compare <baseline_id> <new_id> --json
```

Capture performs bounded GET-only table reads and saves local reports. It never
evals or creates, updates or deletes instance records. Standard authentication
may refresh OAuth tokens, store refreshed credentials locally and bootstrap a
session/GCK using authentication POSTs. List/show/compare are offline.
Declare customer ownership with repeatable `--customer-scope` values or sys_ids;
never infer customer ownership from a non-global scope. The declaration is
caller evidence, not independent publisher verification. OOTB findings reflect
historical upgrade skips, not a current verified baseline deviation. The upgrade
history is read server-side for the skip dispositions and every observed skipped
`file_name` is resolved against `sys_metadata` by chunked
`sys_update_nameIN<chunk>` lookups, so the OOTB inventory covers the observed
skipped artifacts; the broad `sys_metadata` read is an arbitrary `sys_id`-ordered
slice and is reported as a bounded sample, not an inventory, describing only the
unclassified and declared-customer categories. Unresolved skipped names and
failed lookup chunks stay explicit rather than becoming absent artifacts, and a
resolved artifact can lack a scope name when its scope record was outside the
bounded `sys_scope` read. Missing
ACL access, pagination limits and unmatched evidence remain explicit. All
reports are incomplete; no findings is not proof of no customizations.
Comparisons cover captured metadata/evidence, not source payloads. Removals mean
no longer observed, not proven deletion. Reversion impact and dependencies
remain unknown until separately investigated. Never recommend automatic reversion.

Upgrade history joins `file_name` to metadata `sys_update_name`. Raw disposition
`4` or `104` is skipped-customization evidence; resolution `reviewed_reverted`
excludes that history row. Use raw values, not display labels or other skip reasons.

### Complete an update set

```bash
jsn updatesets complete "My Feature" --notes "Fixed validation" --force --json
```

`complete [name]` defaults to the current set when the name is omitted. Explicit
names must be unique. Supply nonempty `--notes` in automation; real newlines
separate bullets. A human terminal opens a notes editor when `--notes` is absent.
Existing Description text is preserved and appended after confirmation. Use
`--force` only after approval, or the profile's `skip_confirmations` policy.
Notes apply only to the selected set. ServiceNow's normal batch rules can complete
child sets when the parent completes; their descriptions are not replaced.
Both selected-set Description and state are read back before success. On
verification failure, inspect the set before retrying.

### Table and raw REST examples

```bash
# Query a table with the normal records command
jsn records list --table incident --query "active=true" --limit 5 --json

# Get a single record
jsn records get --table incident --sys-id abc123... --json

# Raw endpoint access when no specific command fits
jsn rest "/api/now/table/incident?sysparm_limit=3" --json
```

### `jsn docs` — hosted documentation search

No ServiceNow instance or account is required. Search and read through the public
REST service; internet access is required. The server owns daily GitHub sync and
indexing. Nothing is downloaded or indexed locally.

```bash
jsn docs "GlideRecord query" --limit 5 --json
jsn docs --path "api-reference/c_GlideRecordClientSideAPI.md" --json
jsn docs status
```

Use exact paths from search for stable references. When using numeric IDs, pass
`--revision` with the revision returned by search to detect index changes.
`JSN_DOCS_URL` selects another deployment (for local development,
`JSN_DOCS_URL=http://localhost:3000`). Local sync, serve, refresh, embed and
community commands have been retired from the CLI.

## Troubleshooting Field Behavior

Check order (priority):

1. **Before-query business rules** — `sys_script` with `when=before`, `action=query`
   ```bash
   jsn b4rules list --query "collection=sys_user"
   ```
2. **ACLs** — `jsn acls list --query "name=incident"`
3. **Dictionary overrides** — `jsn records list --table sys_dictionary --query "name=incident^element=caller_id"`
4. **Client scripts** / **UI policies** — form-level field behavior

## Configuration

```
~/.config/servicenow/
├── config.json               # Profiles and settings
└── credentials/              # Auth tokens (fallback, one file per key)
```
