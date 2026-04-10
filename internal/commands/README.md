# Flow Designer CLI Commands

This directory contains the commands for the Flow Designer CLI.

## File Structure

- **flows.go** - Main flows command and legacy commands (add-action, add-trigger)
- **flows_triggers.go** - Trigger management commands (triggers add/list/remove)
- **flows_actions.go** - Action management commands (actions add/list/remove/move)
- **flows_variables.go** - Flow variable management commands (variables add/list)

## Commands

### Main Flow Commands
- `jsn flows` - List/show flows
- `jsn flows create` - Create new flow/subflow
- `jsn flows execute` - Execute/test flow
- `jsn flows executions` - Show execution history
- `jsn flows add-action` - Legacy: add action
- `jsn flows add-trigger` - Legacy: add trigger

### Trigger Management
- `jsn flows triggers list <flow>`
- `jsn flows triggers add <flow>`
- `jsn flows triggers remove <flow> <trigger_id>`

### Action Management
- `jsn flows actions list <flow>`
- `jsn flows actions add <flow>`
- `jsn flows actions remove <flow> <action_id>`
- `jsn flows actions move <flow> <action_id> --parent <parent_id>`

### Variable Management
- `jsn flows variables list <flow>`
- `jsn flows variables add <flow> --name <name> --type <type>`

## Future Commands

### Action Reordering
```bash
jsn flows actions move <flow> <action_id> --order 3
```

### Trigger Management
```bash
jsn flows triggers remove <flow> <trigger_id>
```
