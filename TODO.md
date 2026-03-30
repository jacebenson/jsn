# JSN CLI — Command Simplification Plan

## Philosophy

The command hierarchy, in priority order:

1. **Specific commands** — when they render domain objects in ways `records` can't (curated views, unique APIs, domain-aware formatting)
2. **`records`** — generic CRUD on any table (the workhorse)
3. **`rest`** — raw escape hatch for anything
4. **Ask the human / log an issue / search docs** — if none of the above work. Never generate scripts as a fallback.

A specific command earns its place when it does something `records` can't: curated rendering of domain-specific fields, unique API endpoints, multi-table joins that produce a meaningful view, or actions that aren't CRUD (like triggering a job or switching scope).

### The New Pattern: No `list` or `show` Subcommands

Domain commands become the verb themselves. The root of each command handles both lookup and search:

```
jsn flows <sys_id_or_name>        # direct lookup → curated show
jsn flows --search "emergency"    # fuzzy LIKE → pick one → curated show
jsn flows --query "active=true"   # raw encoded query → pick/list
jsn flows                         # no args → interactive picker (TTY) / help (non-TTY)
jsn flows executions <name>       # action subcommands stay as-is
```

**Root command Run logic:**

1. If positional arg → direct show (current `show` logic)
2. If `--search` or `--query` → fetch filtered list:
   - TTY interactive → picker → show selected
   - Non-TTY / `--json` / `--md` → output list (markdown list w/ count for agents, JSON for `--json`)
3. No args, no flags:
   - TTY → interactive picker (fetch all, browse/filter)
   - Non-TTY → show usage/help

**Both `--search` and `--query` are available.** `--search` does fuzzy LIKE matching on domain-appropriate fields. `--query` passes raw ServiceNow encoded queries through. They compose together.

**Per-command search fields stay domain-specific:**

| Command | `--search` queries against |
|---------|--------------------------|
| `flows` | `name` |
| `rules` | `name` |
| `jobs` | `name` |
| `script-includes` | `name` |
| `client-scripts` | `name` |
| `ui-scripts` | `name` |
| `acls` | `name` (encodes operation.table.field) |
| `ui-policies` | `short_description` |
| `portals` | `title` OR `url_suffix` |
| `widgets` | `name` OR `id` |
| `pages` | `id` OR `title` |
| `catalog-item` | `name` (add --search, currently missing) |
| `choices` | (uses positional args for table/column) |

---

## Execution Plan

### Phase 1: Kill Dead Commands

Remove entirely: `compare`, `export`, `import`, `generate`.
Remove registrations from `root.go`.

**Files to delete:**
- `internal/commands/compare.go`
- `internal/commands/export.go`
- `internal/commands/generate.go`

### Phase 2: Refactor Domain Commands

Do `flows` first as the template. Once confirmed working, apply to the rest.

**Per command, the refactor is:**
1. Remove `list` subcommand function
2. Remove `show` subcommand function
3. Add `RunE` + flags (`--search`, `--query`, `--limit`, `--order`, `--desc`, `--all`, plus any command-specific like `--active`, `--table`) to the root command
4. Root `RunE` implements the 3-mode logic above
5. Keep all action subcommands (`executions`, `execute`, `script`, `code`, `create`, etc.)
6. Keep all styled list rendering functions (they render domain-specific columns)
7. Keep all picker functions (they use domain-specific title/description)

**Commands to refactor:**

| Command | Remove | Keep subcommands |
|---------|--------|-----------------|
| `flows` | `list`, `show` | `executions`, `execute` |
| `jobs` | `list`, `show` | `executions`, `run` |
| `rules` | `list`, `show` | `script` |
| `script-includes` | `list`, `show` | `code` |
| `client-scripts` | `list`, `show` | `script` |
| `ui-scripts` | `list`, `show` | `script` |
| `acls` | `list`, `show` | `script`, `check` |
| `ui-policies` | `list`, `show` | `script` |
| `choices` | `list` | `create`, `update`, `delete`, `reorder` |
| `forms` | `list`, `show` | (none) |
| `lists` | `list`, `show` | (none) |
| `catalog-item` | `list`, `show` | `variables`, `create`, `create-variable` |
| `variable` | `show` | `choices`, `add-choice`, `remove-choice` |
| `portals` (sp) | `list`, `show` | (none) |
| `widgets` (sp-widgets) | `list`, `show` | (none) |
| `pages` (sp-pages) | `list`, `show` | (none) |

### Phase 3: Move `variable-types` to docs topic

Static reference data currently hardcoded in Go. Should be `jsn docs variable-types`.

### Phase 4: Cleanup

- Update `root.go` registrations (remove killed commands)
- Update `commands.go` catalog
- Update `SKILL.md` with new command patterns
- Verify build compiles

---

## Notes from Review

- **logs command**: Keep. Curated time-based syslog search is genuinely useful beyond `records list syslog`.
- **auth/config/setup**: Leave as-is for now. Could consolidate later.
- **commands command**: May be unnecessary if `jsn --help` is good enough. Low priority.
- **version command**: `jsn --version` flag is standard. Standalone command is redundant but harmless.
- **script-includes**: Add common pattern awareness (plain function, class-based, extended class) to show output.
- **catalog-item**: Complex multi-table hierarchy justifies its own namespace.
- **forms/pages**: Terminal rendering of layouts is high-value future work.
- **choices**: Inheritance visualization (task.state → incident.state) would be valuable in show output.


--- 
While this was running i was building it and jsn flows is showing commands like `jsn flows show flow-name` in line it response we shouuld updat ethat 

hints show old commands
