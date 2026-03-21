# ServiceNow CLI (jsn) - Outstanding Items

## High Priority

### UI List Layouts
- [ ] `jsn lists list --table <table>` - List UI list layouts
- [ ] `jsn lists show <table> [--view <view>]` - Show list columns
- Uses `sys_ui_list` and `sys_ui_list_element` tables

### Workspaces
- [ ] `jsn workspaces list` - List workspaces
- [ ] `jsn workspaces show [<name>]` - Show workspace details

### Quick Access
- [ ] `jsn open <table> <sys_id>` - Open record in browser
- [ ] `jsn open <table>` - Open table list in browser

## Medium Priority

### Attachments
- [ ] `jsn attachments list --table <table> --record <sys_id>` - List attachments
- [ ] `jsn attachments download <sys_id> [--output <path>]` - Download attachment

### Diagnostics
- [ ] `jsn doctor` - Run diagnostics (check auth, connectivity, permissions)

## Low Priority

### Developer Experience
- [ ] Install script (curl | bash style)
- [ ] `--help --agent` structured JSON output for AI integration

### Future Ideas
- Table relationship diagrams
- UI Builder / Next Experience commands
- Batch operations
- Analytics & stats
