# JSN - ServiceNow CLI

A command-line interface for ServiceNow that follows the Unix philosophy: simple, composable, and scriptable.

## Installation

```bash
# Download the latest release
curl -L https://github.com/jacebenson/jsn/releases/latest/download/jsn-linux-amd64 -o jsn
chmod +x jsn
sudo mv jsn /usr/local/bin/

# Or install with go
go install github.com/jacebenson/jsn/cmd/jsn@latest
```

## Quick Start

### 1. Setup

Run the interactive setup to configure your first ServiceNow instance:

```bash
jsn setup
```

This will:
1. Ask for your ServiceNow instance URL
2. Open a browser for OAuth authentication
3. Set the instance as your default

### 2. Verify Authentication

```bash
jsn auth status
```

### 3. Start Using

```bash
# List all incidents
jsn incidents

# Show a specific incident
jsn incidents INC0010001

# Create a new incident
jsn incidents create --description "Server down" --priority 1

# List change requests
jsn changes

# Query any table
jsn records list --table incident --query "priority=1^active=true"
```

## Configuration

JSN uses a layered configuration system:

| Source | Priority | Description |
|--------|----------|-------------|
| Flags | Highest | `--instance`, `--profile`, `--format` |
| Environment | High | `SERVICENOW_INSTANCE_URL`, `SERVICENOW_FORMAT` |
| Local config | Medium | `./.servicenow/config.json` |
| Global config | Low | `~/.config/servicenow/config.json` |
| Defaults | Lowest | Built-in defaults |

### Profiles

Work with multiple ServiceNow instances using profiles:

```bash
# Login to a new instance
jsn auth login https://dev12345.service-now.com

# List all profiles
jsn profiles list

# Switch to a different profile
jsn profiles use dev12345

# Show current profile
jsn profiles show
```

## Commands

### Work Commands (Day-to-day operations)

| Command | Aliases | Description |
|---------|---------|-------------|
| `incidents` | `incident`, `inc` | Manage IT incidents |
| `changes` | `change`, `chg` | Manage change requests |
| `requests` | `request`, `req`, `ritm` | Manage service catalog requests |
| `tasks` | `task`, `sctask` | Manage service catalog tasks |
| `users` | `user` | Manage users |
| `groups` | `group` | Manage user groups |
| `records` | - | Generic Table API access |

### Dev Commands (Development artifacts)

| Category | Command | Description |
|----------|---------|-------------|
| **Automations** | `dev flows` | Manage Flow Designer flows |
| | `dev actions` | Manage action definitions |
| **Scripts** | `dev includes` | Manage script includes |
| | `dev rules` | Manage business rules |
| | `dev clientscripts` | Manage client scripts |
| | `dev uiactions` | Manage UI actions |
| | `dev uipolicies` | Manage UI policies |
| **Data** | `dev tables` | View table definitions |
| | `dev columns` | Manage column definitions |
| | `dev import` | Manage import sets |
| **Security** | `dev acls` | Manage access controls |
| | `dev roles` | Manage roles |
| **Platform** | `dev updatesets` | Manage update sets |
| | `dev scopes` | Manage application scopes |
| | `dev properties` | Manage system properties |
| | `dev logs` | Query system logs |
| | `dev rest` | Raw REST API calls |
| | `dev eval` | Execute background scripts |

## Usage Examples

### Incidents

```bash
# List all incidents
jsn incidents

# List critical incidents
jsn incidents list --query "priority=1"

# Show specific incident
jsn incidents INC0010001

# Create incident
jsn incidents create --description "Server down" --priority 1

# Update incident
jsn incidents update INC0010001 --data '{"state": "6"}'

# Delete incident
jsn incidents delete INC0010001
```

### Changes

```bash
# List all change requests
jsn changes

# List high-risk changes
jsn changes list --query "risk=high"

# Create change request
jsn changes create --description "Deploy feature" --risk medium

# Update change
jsn changes update CHG0010001 --data '{"state": "3"}'

# Delete change
jsn changes delete CHG0010001
```

### Development Artifacts

```bash
# AUTOMATIONS
# List Flow Designer flows
jsn dev flows

# List action definitions
jsn dev actions

# SCRIPTS
# List script includes
jsn dev includes

# Get a specific script include
jsn dev includes MyScriptInclude

# List business rules
jsn dev rules

# List client scripts
jsn dev clientscripts

# List UI actions
jsn dev uiactions

# List UI policies
jsn dev uipolicies

# DATA
# View table definition
jsn dev tables incident

# List table columns
jsn dev columns --table incident

# SECURITY
# List access controls (ACLs)
jsn dev acls

# List roles
jsn dev roles

# PLATFORM
# List update sets
jsn dev updatesets

# Set current update set
jsn dev updatesets set "My Update Set"

# List application scopes
jsn dev scopes

# Query system properties
jsn dev properties

# Query system logs
jsn dev logs --level error
jsn dev logs --source "Business Rule" --level warn

# Execute background script
jsn dev eval "gs.info('Hello World')"
```

### Generic Table API

```bash
# List any table
jsn records list --table incident --limit 10

# Query with encoded query
jsn records list --table incident --query "priority=1^active=true"

# Show specific columns
jsn records list --table incident --columns "number,short_description,priority"

# Get a record by sys_id
jsn records get --table incident --sys-id abc123

# Create a record
jsn records create --table incident --data '{"short_description": "Test"}'

# Update a record
jsn records update --table incident --sys-id abc123 --data '{"priority": "1"}'

# Delete a record
jsn records delete --table incident --sys-id abc123
```

## Output Formats

JSN supports multiple output formats:

| Format | Flag | Description |
|--------|------|-------------|
| Auto (default) | `--format=auto` | JSON for pipes, styled for TTY |
| JSON | `--json` or `--format=json` | Machine-readable JSON |
| Styled | `--styled` | ANSI-styled tables (for humans) |
| Markdown | `--markdown` | Markdown tables |
| Quiet | `--quiet` or `-q` | Data only, no envelope |

```bash
# JSON output
jsn incidents --json

# Styled table output
jsn incidents --styled

# Markdown output for documentation
jsn incidents --markdown

# Quiet mode for piping
jsn incidents -q | jq '.[].number'
```

## Authentication

JSN uses OAuth 2.0 with PKCE for secure authentication:

```bash
# Login to an instance
jsn auth login https://dev12345.service-now.com

# Check authentication status
jsn auth status

# Logout
jsn auth logout
```

Credentials are securely stored in your OS keychain (or file fallback at `~/.config/servicenow/credentials/`).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SERVICENOW_INSTANCE_URL` | Default instance URL |
| `SERVICENOW_FORMAT` | Default output format |
| `SERVICENOW_OAUTH_TOKEN` | OAuth token (for CI/CD) |

## CI/CD Integration

For automated environments, use the OAuth token:

```bash
export SERVICENOW_INSTANCE_URL="https://dev12345.service-now.com"
export SERVICENOW_OAUTH_TOKEN="your-oauth-token"

# Now run commands without interactive auth
jsn incidents list
```

## Shell Completion

```bash
# Bash
source <(jsn completion bash)

# Zsh
source <(jsn completion zsh)

# Fish
jsn completion fish | source
```

## Getting Help

```bash
# General help
jsn --help

# Command help
jsn incidents --help

# Subcommand help
jsn incidents create --help
```

## Troubleshooting

### Not authenticated

```bash
⚠️  Not authenticated to https://dev12345.service-now.com

To get started, run:
  jsn setup           # Interactive setup
  jsn auth login      # Login to instance
```

**Solution**: Run `jsn setup` or `jsn auth login <instance>`

### Instance URL required

```bash
Error (usage): Instance URL required. Set via --instance flag, SERVICENOW_INSTANCE_URL env, or config file.
```

**Solution**: Set the instance with one of:
- `jsn setup`
- `jsn auth login <instance>`
- `--instance` flag
- `SERVICENOW_INSTANCE_URL` environment variable

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

This project follows the architectural patterns from [basecamp-cli](https://github.com/basecamp/basecamp-cli).
