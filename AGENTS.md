# Agent Documentation for JSN CLI

This document provides guidance for AI agents using the JSN CLI to interact with ServiceNow.

## Design Philosophy

JSN is designed for **safe, composable automation**:

1. **Read-only by default** - List and get operations are safe
2. **Explicit mutations** - Create/update/delete require explicit flags
3. **Idempotent operations** - Running the same command twice produces the same result
4. **Structured output** - JSON output can be piped to other tools
5. **Error handling** - Clear error messages with hints for resolution

## Common Workflows

### Workflow 1: Incident Management

```bash
# List all open critical incidents
jsn incidents list --query "priority=1^active=true^state!=6" --json

# Get details of a specific incident
jsn incidents INC0010001 --json

# Create a new incident (returns the created record)
jsn incidents create --description "Issue description" --priority 2 --json

# Update an incident status
jsn incidents update INC0010001 --data '{"state": "2", "assigned_to": "user_id"}'

# Add a work note to an incident
jsn records update --table incident --sys-id <sys_id> --data '{"work_notes": "Updated status"}'
```

### Workflow 2: Change Request Management

```bash
# List pending changes
jsn changes list --query "state=-5" --json

# Create a standard change
jsn changes create --description "Monthly maintenance" --risk low --json

# Approve a change (move to assessment)
jsn changes update CHG0010001 --data '{"state": "1"}'
```

### Workflow 3: User Management

```bash
# Search for users
jsn users "John Smith" --json

# Get user details
jsn users list --query "user_name=john.smith" --json

# Find user's group memberships
jsn records list --table sys_user_grmember --query "user.name=john.smith" --columns "group.name,group.manager" --json
```

### Workflow 4: Development Tasks

```bash
# List script includes in a scope
jsn dev includes list --query "sys_scope.scope=x_myapp" --json

# Get script include code
jsn dev includes MyScriptInclude --json | jq -r '.script'

# List business rules on a table
jsn dev rules list --query "collection=incident^active=true" --json

# List client scripts on a table
jsn dev clientscripts list --query "table_name=incident^active=true" --json

# List UI actions on a table
jsn dev uiactions list --query "table=incident^active=true" --json

# List update sets
jsn dev updatesets list --query "state=in progress" --json

# Set current update set
jsn dev updatesets set "My Development" --json

# List access controls (ACLs) for a table
jsn dev acls list --query "name=incident" --json

# Query system properties
jsn dev properties list --query "nameLIKEglide.encryption" --json
```

### Workflow 5: Data Queries

```bash
# Generic table query with jq processing
jsn records list --table incident --query "active=true^opened_at>javascript:gs.daysAgo(7)" --json | \
  jq -r '.[] | "\(.number): \(.short_description)"'

# Count records
jsn records list --table incident --query "priority=1" --json | jq 'length'

# Export to CSV (using jq)
jsn records list --table incident --limit 100 --json | \
  jq -r '.[] | [.number, .short_description, .priority, .state] | @csv'
```

## Best Practices for Agents

### 1. Always Use --json for Automation

```bash
# Good - structured output for parsing
jsn incidents list --json | jq '.[].number'

# Avoid - parsing human-readable output
jsn incidents list | grep "INC" | awk '{print $1}'
```

### 2. Handle Errors Gracefully

```bash
# Check if command succeeded
if jsn incidents INC0010001 --json > /dev/null 2>&1; then
    echo "Incident exists"
else
    echo "Incident not found"
fi
```

### 3. Use --limit for Large Tables

```bash
# Prevent timeouts on large tables
jsn records list --table sys_audit --limit 100 --json
```

### 4. Batch Operations

```bash
# Get multiple records efficiently
jsn records list --table incident --query "numberININC0010001,INC0010002,INC0010003" --json
```

### 5. Safe Update Patterns

```bash
# Always verify before updating
INCIDENT=$(jsn incidents INC0010001 --json)
if [ $? -eq 0 ]; then
    SYS_ID=$(echo "$INCIDENT" | jq -r '.sys_id')
    jsn records update --table incident --sys-id "$SYS_ID" --data '{"state": "6"}'
fi
```

## Safety Guidelines

### Safe Operations (Read-Only)

These operations are always safe:

- `jsn incidents list`
- `jsn incidents <number>`
- `jsn changes list`
- `jsn records list`
- `jsn users list`
- `jsn groups list`

**Dev Commands:**

- `jsn dev flows list`
- `jsn dev actions list`
- `jsn dev includes list`
- `jsn dev rules list`
- `jsn dev clientscripts list`
- `jsn dev uiactions list`
- `jsn dev uipolicies list`
- `jsn dev tables list`
- `jsn dev columns list`
- `jsn dev import list`
- `jsn dev acls list`
- `jsn dev roles list`
- `jsn dev updatesets list`
- `jsn dev scopes list`
- `jsn dev properties list`
- `jsn dev logs list`

### Operations Requiring Confirmation

These operations modify data:

- `jsn incidents create`
- `jsn incidents update`
- `jsn incidents delete`
- `jsn changes create`
- `jsn changes update`
- `jsn changes delete`
- `jsn records create`
- `jsn records update`
- `jsn records delete`
- `jsn dev updatesets set`
- `jsn dev eval`

**Agent Rule**: Always verify with the user before running mutation commands.

## Output Format Reference

### JSON Output Structure

```json
{
  "ok": true,
  "data": { ... },
  "summary": "Description of result",
  "breadcrumbs": [
    {
      "action": "create",
      "cmd": "jsn incidents create --description \"...\"",
      "description": "Create a new incident"
    }
  ],
  "meta": { ... }
}
```

### Error Response Structure

```json
{
  "ok": false,
  "error": "Description of error",
  "code": "error_code",
  "hint": "How to fix this error",
  "meta": { ... }
}
```

## Common Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| `auth` | Authentication error | Run `jsn auth login` |
| `usage` | Invalid usage | Check command syntax with `--help` |
| `not_found` | Record not found | Verify the identifier exists |
| `api_error` | ServiceNow API error | Check instance status and permissions |
| `network` | Network error | Check connectivity |

## Working with Encoded Queries

ServiceNow uses encoded queries for filtering:

```bash
# Operators
^          AND
^OR        OR
^NQ        New query (OR group)
=          Equals
!=         Not equals
>          Greater than
<          Less than
>=         Greater or equal
<=         Less or equal
LIKE       Contains
NOT LIKE   Does not contain
STARTSWITH Starts with
ENDSWITH   Ends with
EMPTY      Is empty
NOT EMPTY  Is not empty
IN         In list (comma-separated)

# Examples
"priority=1^active=true"                          # Critical and active
"priorityIN1,2^state!=6"                          # Priority 1 or 2, not closed
"short_descriptionLIKEserver^ORnumber=INC0010001" # Contains "server" OR specific number
"opened_at>javascript:gs.daysAgo(7)"              # Opened in last 7 days
```

## Integration Patterns

### With jq (JSON processing)

```bash
# Extract specific fields
jsn incidents list --json | jq '.[].number'

# Filter results
jsn incidents list --json | jq '.[] | select(.priority == "1")'

# Transform to different format
jsn incidents list --json | jq -r '.[] | "\(.number): \(.short_description)"'
```

### With grep/awk

```bash
# Simple text filtering (on styled output)
jsn incidents list --styled | grep "INC001"

# Count results
jsn incidents list --json | jq 'length'
```

### With Other CLIs

```bash
# Create incident and send notification
INCIDENT=$(jsn incidents create --description "Issue" --json)
NUMBER=$(echo "$INCIDENT" | jq -r '.data.number')
echo "Created $NUMBER" | mail -s "New Incident" admin@example.com
```

## Testing Commands

When testing or exploring:

```bash
# Use --limit to prevent timeouts
jsn records list --table sys_audit --limit 5 --json

# Use quiet mode to see just the data
jsn incidents list --limit 5 -q

# Combine with head/tail
jsn incidents list --json | jq -r '.[].number' | head -5
```

## References

- [ServiceNow Table API Docs](https://docs.servicenow.com/bundle/tokyo-application-development/page/integrate/inbound-rest/concept/c_TableAPI.html)
- [ServiceNow Encoded Query Docs](https://docs.servicenow.com/bundle/tokyo-platform-administration/page/administer/table-administration/concept/c_EncodedQueryStrings.html)
- [jq Manual](https://stedolan.github.io/jq/manual/)
