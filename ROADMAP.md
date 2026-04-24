# JSN 1.0+ Roadmap

## 1.0 Release (Current Focus)

### Core Data Commands (Full CRUD)
- [x] incidents - List, show, create, update, delete
- [x] changes - List, show, create, update, delete  
- [x] requests - List, show, create, update, delete
- [x] records - Generic table access (power user tool)

### Core Dev Commands (Read-Only for Complex Objects)
- [x] updatesets - List, show, set (daily use)
- [x] scopes - List, show, use (daily use)
- [x] logs - Tail, search (debugging)
- [x] eval - Quick script execution (testing)
- [x] spwidgets - List, show Service Portal widgets (builders touch these)
- [x] uipages - List, show classic UI pages (builders touch these)
- [x] appmenu - List, show application menu/modules (builders touch these)
- [x] scrapi - List, show scripted REST APIs (builders touch these)

### Infrastructure
- [x] auth - Login/logout/status
- [x] profiles - Multi-instance management
- [x] context header - Show current scope/updateset

### Deferred to 1.1+
- [x] Interactive pickers (lipgloss/charm) - incidents list now uses bubbletea picker in TTY mode
- [ ] groups/users management - Full CRUD
- [ ] tasks - Service catalog tasks

## 1.1 Release (Post-Launch)

### Read-Only Complex Objects
These need special handling because they're not simple tables:

- [ ] flows - Read Flow Designer flows (complex structure)
- [ ] decision-tables - Read decision table rules
- [ ] choices - Read choice lists (sys_choice)
- [ ] script-includes - Read with syntax highlighting
- [ ] business-rules - Read with table context

Why read-only? Creating these in ServiceNow UI is actually good. 
Reading them is painful (too many clicks). JSN wins on inspection.

### Interactive Pickers (Bring Back)
Replace this:
```
$ jsn dev updatesets list
1. Default | Global | in progress
2. My Fix | My App | in progress
Enter number: 2
```

With this:
```
$ jsn dev updatesets set
  Select update set:
> ⏱ Default | Global | in progress  
  ⏱ My Fix | My App | in progress
  ✓ Complete Set | Global | complete
```

Implementation: bubbletea list picker with single-line layout

## 1.2+ Release (As Needed)

### Maybe Never (UI is Better)
- Creating flows (use Flow Designer)
- Creating decision tables (use UI)
- Complex table schema changes (use Studio)

### Maybe Later (If Requested)
- import sets
- scheduled jobs
- notifications
- data policies

## Decision Framework

For any new command, ask:

1. **Is reading it painful in ServiceNow UI?** 
   - Yes → Build read command
   - No → Skip

2. **Is creating it painful in ServiceNow UI?**
   - Yes → Build create command  
   - No → Skip (use UI)

3. **Do I use this daily?**
   - Yes → 1.0
   - Weekly → 1.1
   - Monthly → Maybe never

## Current Status

**1.0 is feature complete when:**
- [ ] All core data commands tested manually
- [ ] All core dev commands tested manually
- [ ] JSON output pipes cleanly to jq
- [ ] Help text is helpful
- [ ] No TODOs in main code path

**Then ship. Everything else is 1.1.**
