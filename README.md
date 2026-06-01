# JSN - ServiceNow CLI

A command-line interface for ServiceNow that follows the Unix philosophy: simple, composable, and scriptable.

## Installation

### npm (recommended — cross-platform)

```bash
npm install -g @jacebenson/jsn
```

No compilation needed. Works on macOS, Linux, and Windows with Node.js 18+.

> **Note:** As of v0.1.0, the `latest` dist-tag points to the Node.js implementation. This is the version you get with `npm install -g @jacebenson/jsn`.

### Quick Start

```bash
# Interactive setup
jsn setup

# Check auth status
jsn auth status

# List incidents
jsn incidents

# Check for updates
jsn version --check
```

## What's New in v0.1.0

Full feature parity with the original Go implementation — 128 tests, lint clean:

| Feature | Status |
|---------|--------|
| Incident management (CRUD) | ✅ |
| Change request management (CRUD) | ✅ |
| Service catalog requests (with attachments + variables) | ✅ |
| Catalog tasks, generic tickets | ✅ |
| User management (CRUD) | ✅ |
| Group management (CRUD) | ✅ |
| Group memberships and roles | ✅ |
| Generic Table API (`jsn records`) | ✅ |
| OAuth PKCE with keychain (Go-compatible auth store) | ✅ |
| Bot/CI/CD auth flags (`--code`, `--print-url`) | ✅ |
| Dev commands: flows, actions, includes, rules, ACLs, etc. | ✅ |
| Script execution (`jsn dev eval`) via OAuth session flow | ✅ |
| Interactive search-as-you-type pickers | ✅ |
| Output formats: JSON, styled, markdown, quiet | ✅ |
| Enriched `requests show` with attachments + variables | ✅ |
| Categorized help system (CORE, DATA, DEV, CONFIG) | ✅ |

### New Commands

- **`jsn version --check`** — Check npm registry for newer versions
- **`jsn skill`** — Manage the jsn AI agent skill file (for Hermes, Claude Code, etc.)
  - `jsn skill show` — Display the bundled skill
  - `jsn skill fetch` — Download latest skill from GitHub
  - `jsn skill path` — Show skill file locations
  - `jsn skill install` — Download + save to Hermes skills directory

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

### CORE

| Command | Aliases | Description |
|---------|---------|-------------|
| `incidents` | `incident`, `inc` | Manage IT incidents |
| `changes` | `change`, `chg` | Manage change requests |
| `requests` | `request`, `req`, `ritm` | Manage service catalog requests |
| `tasks` | `task`, `sctask` | Manage service catalog tasks |
| `tickets` | `ticket` | Query generic tickets |

### DATA & ADMIN

| Command | Aliases | Description |
|---------|---------|-------------|
| `records` | - | Generic Table API for any table |
| `users` | `user` | Manage users |
| `groups` | `group` | Manage user groups |
| `groupmembers` | `gm` | Manage group memberships |
| `grouproles` | `gr` | Manage group roles |

### DEVELOPMENT

| Command | Description |
|---------|-------------|
| `dev flows` | Manage Flow Designer flows |
| `dev actions` | Manage action definitions |
| `dev includes` | Manage script includes |
| `dev rules` | Manage business rules |
| `dev clientscripts` | Manage client scripts |
| `dev uiactions` | Manage UI actions |
| `dev uipolicies` | Manage UI policies |
| `dev tables` | View table definitions |
| `dev columns` | Manage column definitions |
| `dev import` | Manage import sets |
| `dev acls` | Manage access controls |
| `dev roles` | Manage roles |
| `dev updatesets` | Manage update sets |
| `dev scopes` | Manage application scopes |
| `dev properties` | Manage system properties |
| `dev logs` | Query system logs |
| `dev rest` | Raw REST API calls |
| `dev eval` | Execute background scripts |

### CONFIGURATION

| Command | Description |
|---------|-------------|
| `setup` | Interactive first-time setup |
| `auth` | Manage OAuth authentication |
| `profiles` | Manage instance profiles |

### UTILITY

| Command | Description |
|---------|-------------|
| `version` | Show version (use `--check` for update check) |
| `skill` | Manage the jsn AI agent skill file |

## Usage Examples

### Incidents

```bash
jsn incidents                              # List all
jsn incidents list --query "priority=1"    # Critical only
jsn incidents INC0010001                   # Show specific
jsn incidents create --description "Server down" --priority 1
jsn incidents update INC0010001 --data '{"state": "6"}'
```

### Requests (with enriched details)

```bash
jsn requests show RITM0010001
# Output includes attachments + catalog variables:
# ─ Attachments ─
#   onboarding_form.pdf  (by John Smith, 2026-05-15 14:23:10)
# ─ Catalog Variables ─
#   Department:  Engineering
#   Urgency:  High
```

### Development

```bash
jsn dev flows                              # List flows
jsn dev includes MyScriptInclude           # Show a script include
jsn dev rules                              # List business rules
jsn dev updatesets set "My Update Set"     # Set current updateset
jsn dev eval "gs.info('Hello World')"      # Run background script
```

### Generic Table API

```bash
jsn records list --table incident --limit 10
jsn records list --table incident --query "priority=1^active=true"
jsn records get --table incident --sys-id abc123
jsn records create --table incident --data '{"short_description": "Test"}'
```

## Output Formats

| Format | Flag | Description |
|--------|------|-------------|
| Auto (default) | `--format=auto` | JSON for pipes, styled for TTY |
| JSON | `--json` or `--format=json` | Machine-readable JSON |
| Styled | `--styled` | ANSI-styled tables |
| Markdown | `--markdown` | Markdown tables |
| Quiet | `--quiet` or `-q` | Data only, no envelope |

```bash
jsn incidents --json | jq '.[].number'
jsn incidents --styled
jsn incidents -q | jq '.[].number'
```

## Authentication

OAuth 2.0 with PKCE. Credentials stored in `~/.config/servicenow/credentials/` — shared with the legacy Go version.

```bash
jsn auth login https://dev12345.service-now.com

# Bot-friendly: print auth URL instead of opening a browser
jsn auth login https://dev12345.service-now.com --print-url

# Paste code from browser
jsn auth login https://dev12345.service-now.com --code ABC123
```

### CI/CD Integration

```bash
export SERVICENOW_INSTANCE_URL="https://dev12345.service-now.com"
export SERVICENOW_OAUTH_TOKEN="***"
jsn incidents list   # No interactive auth needed
```

## AI Agent Integration

JSN includes a built-in skill file for AI agents:

```bash
# View the skill file
jsn skill show

# Download the latest skill from GitHub
jsn skill fetch | head -30

# Install to Hermes skills directory
jsn skill install

# Install to a custom location
jsn skill install /path/to/skills/
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SERVICENOW_INSTANCE_URL` | Default instance URL |
| `SERVICENOW_FORMAT` | Default output format |
| `SERVICENOW_OAUTH_TOKEN` | OAuth token (for CI/CD) |
| `JSN_NO_HEADER` | Suppress context header |

## Getting Help

```bash
jsn                          # Categorized help with command groups
jsn incidents --help         # Command details
jsn version                  # Show version
jsn version --check          # Check for npm updates
```

## Development

```bash
git clone https://github.com/jacebenson/jsn.git
cd jsn
git checkout nodejs
npm install
npm test           # 128+ tests
npm run lint       # ESLint
npm run start      # Run CLI locally
```

### Project Structure

```
├── src/
│   ├── cli.js              # Root CLI (yargs setup)
│   ├── app.js              # App context
│   ├── auth.js             # OAuth PKCE manager
│   ├── sdk.js              # ServiceNow REST API client
│   ├── output.js           # Output formatting
│   ├── config.js           # Configuration loader
│   ├── context.js          # Runtime context
│   ├── errors.js           # Structured error types
│   ├── helpers.js          # Shared utilities
│   ├── help.js             # Custom grouped help renderer
│   └── commands/           # CLI command modules
├── skills/
│   └── servicenow/
│       └── SKILL.md        # AI agent skill file
├── test/                   # Test suite
└── package.json
```

### Releasing

```bash
npm run release -- patch    # or minor, major
# Creates node-v* tag, pushes to GitHub, publishes to npm
```

## Troubleshooting

### Not authenticated

```
⚠️  Not authenticated to https://dev12345.service-now.com

To get started, run:
  jsn setup
  jsn auth login
```

### Instance URL required

```
Error (usage): Instance URL required. Set via --instance flag,
               SERVICENOW_INSTANCE_URL env, or config file.
```

### Outdated version

```bash
jsn version --check
# → jsn 0.0.10 — newer version 0.1.0 available
npm install -g @jacebenson/jsn
```

## Historical Note

JSN was originally implemented in Go (on the `main` branch) and migrated to Node.js for broader cross-platform support and simpler installation. As of v0.1.0, the Node.js version has full feature parity. The Go source remains available on the `main` branch for reference.

## License

MIT License — see LICENSE file for details

## Acknowledgments

This project follows architectural patterns from [basecamp-cli](https://github.com/basecamp/basecamp-cli).

| Project | What we learned |
|---------|----------------|
| [Abey's `sn` CLI](https://github.com/tehubersheezy/servicenow-cli) (Rust) | Table API patterns, aggregate stats, raw REST passthrough |
| [ServiceNow `now-sdk`](https://www.npmjs.com/package/@servicenow/sdk) | OAuth session flow for UI pages |
| [ServiceNow VS Code Extension](https://marketplace.visualstudio.com/items?itemName=ServiceNow.now-vscode) | `sys.scripts.do` CSRF extraction |
| [Getting Real](https://basecamp.com/gettingreal) by Basecamp | Build less, start with no, embrace constraints |
