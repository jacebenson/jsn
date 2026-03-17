THIS IS Rough.  

only tested on arch linux but would love others input.

# JSN - ServiceNow CLI

**Agent-first, agent-native** 

A CLI for exploring and managing ServiceNow instances. Works standalone or with any AI agent (Claude, Codex, Cursor, etc.).

```bash
# Install in seconds
curl -fsSL https://raw.githubusercontent.com/jacebenson/jsn/main/scripts/install.sh | bash
```

## Quick Start

```bash
jsn setup                           # Interactive first-time setup
jsn tables list                     # List all tables
jsn tables schema incident          # Show incident table schema
jsn records list incident           # List incident records
jsn rules list --table incident     # Show business rules
```

---

## Why This Exists (Or: The Graveyard of ServiceNow Dev Tools)

I've been working with ServiceNow for years and trying to use tools that actually, you know, work. The Table API is "fine"—except these APIs were designed for systems integration, not for humans (or agents) trying to understand their instance.


If we want real innovation in this space, we have to stop hiding tools behind enterprise licensing agreements and convoluted setup processes. This is my attempt to build the CLI I actually want to use — and that my AI agent can use to help me.

### The Official Corpse

**[ServiceNow's "Official" CLI](https://github.com/ServiceNow/servicenow-cli)** – Last meaningful update: 2 years ago. Requires you to install a server-side application on your instance just to use it. Abandoned before it ever really lived.

### The Over-Engineered Monstrosity

**[ServiceNow Fluent SDK](https://github.com/ServiceNow/sdk)** – Follow the link rabbit hole and you eventually hit the [docs](https://www.servicenow.com/docs/r/application-development/servicenow-sdk/servicenow-sdk-landing.html). I actually tried to use this. For YEARS this thing had dependency issues that made it break on different operating systems.

Then I spent a day migrating a global scope app to a "proper" scoped app using Fluent, only to discover it made everything WORSE. Why? Because once you ship an import, you can only fix it through the SDK—not in the instance UI. Oh, and the auth configuration? Completely baffling.

### The Syncer Cemetery

Before the SDK killed them (for scoped apps only), we had file syncers. Mostly VS Code extensions that have all rotted away:

- **[sn-filesync](https://github.com/dynamicdan/sn-filesync)** – Last updated 7 years ago
- **[codesync](https://github.com/cern-snow/codesync)** – Last updated 9 years ago  
- **[now-sync](https://github.com/Accruent/now-sync)** – Last updated 6 years ago

Today there's basically one survivor: **[SNICH by Nate Anderson](https://marketplace.visualstudio.com/items?itemName=NateAnderson.snich)**—and it's VS Code only.

### The Pattern Is Clear

Every tool either:
1. Requires proprietary server-side components
2. Locks you into specific IDEs or workflows
3. Dies from complexity and maintenance burden
4. Forces you to abandon the ServiceNow UI entirely

**I'm tired of it.**

---

## How This Is Different

### 1. Actually Useful

Not "deploy a scoped app" useful—**"explore and understand your instance"** useful. The kind of tool that answers questions like:
- "What business rules fire on the Incident table?"
- "What flows are currently active?"
- "Show me the schema of this table without clicking through 12 UI screens"

### 2. Zero Bullshit Setup

One binary. No server-side plugins. No dependency hell. No auth configuration that requires a PhD.

### 3. Works With Reality

Global scope? Scoped apps? Direct instance editing? **Yes.** I'm not forcing you to choose between the CLI and the ServiceNow UI. Use both. Fix things wherever it's faster.

---

## For AI Agents

This CLI is designed to be **agent-native**. Your AI assistant can:

- **Explore**: List tables, schemas, business rules, flows — understand your instance structure
- **Query**: Fetch records, analyze data patterns, check configurations  
- **Verify**: Confirm changes, check dependencies, validate before deploying
- **Document**: Generate reports on instance configuration, security policies, automation logic

The command structure is predictable and machine-readable. JSON output available for everything.

<details>
<summary>Other installation methods</summary>

**Homebrew (macOS/Linux):**
```bash
brew tap jacebenson/jsn
brew install jsn
```

**Go install:**
```bash
go install github.com/jacebenson/jsn/cmd/jsn@latest
```

**GitHub Release:**
Download from [Releases](https://github.com/jacebenson/jsn/releases).

**From source:**
```bash
git clone https://github.com/jacebenson/jsn.git
cd jsn
go build -o jsn ./cmd/jsn/main.go
```

</details>

## Usage

```bash
# Explore your instance
jsn tables list                                    # List all tables
jsn tables schema incident                         # Show table inheritance
jsn tables columns incident                        # Show all columns

# Query records
jsn records list incident                          # List records
jsn records list incident --query "priority=1"     # Filter with encoded query
jsn records show incident <sys_id>                 # Show specific record

# Manage data
jsn records create incident --field short_description="Server down"
jsn records update incident <sys_id> --field priority=1
jsn records delete incident <sys_id> --force

# Business logic
jsn rules list --table incident                    # List business rules
jsn flows list                                     # List flows
jsn script-includes list                           # List script includes

# Update sets
jsn updateset list                                 # List update sets
jsn updateset use <name>                           # Set current update set

# Configuration
jsn config list                                    # List profiles
jsn config switch <name>                           # Switch profile
jsn auth status                                    # Check auth status
```

## Output Formats

```bash
jsn tables list                   # Styled output in terminal
jsn tables list --json            # JSON with envelope and breadcrumbs
jsn tables list --quiet           # Raw JSON data only
jsn tables list --md              # Markdown format
```

### JSON Envelope

Every command supports `--json` for structured output:

```json
{
  "ok": true,
  "data": [...],
  "summary": "5 tables",
  "breadcrumbs": [
    {"action": "show", "cmd": "jsn tables show incident", "description": "View table details"}
  ]
}
```

Breadcrumbs suggest next commands, making it easy for humans and agents to navigate.

## Authentication

Supports two authentication methods:

**Basic Auth** (recommended for CI/CD):
```bash
jsn auth login                     # Enter username/password
```

**g_ck Token** (browser cookie):
```bash
jsn auth login                     # Choose g_ck option
```

Credentials are stored securely using your system keyring (macOS Keychain, Windows Credential Manager, Linux Secret Service). Falls back to file storage with restricted permissions if keyring is unavailable.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `SERVICENOW_TOKEN` | Override stored token/password |
| `SERVICENOW_INSTANCE` | Override instance URL |
| `XDG_CONFIG_HOME` | Custom config directory |

## Configuration

```
~/.config/servicenow/         # Global configuration
├── config.json               #   Profiles and settings
└── credentials.json          #   Auth tokens (fallback when keyring unavailable)

.servicenow/                  # Per-repo configuration (optional)
└── config.json               #   Project-specific settings
```

## Discover Commands

Use `--help` to explore all commands and flags:

```bash
jsn --help                    # List all top-level commands
jsn tables --help             # Show tables subcommands
jsn records list --help       # Show records list flags
```

Or use `jsn` with no arguments for an interactive command picker.

## Global Flags

These flags work with any command:

```
--config <path>       # Use specific config file
--profile <name>      # Use specific profile
--json                # Output as JSON
--quiet, -q           # Output data only (no envelope)
--md                  # Output as Markdown
--agent               # Agent mode (JSON + quiet + no interactive prompts)
```

## Development

```bash
make build            # Build binary
make test             # Run Go tests
make lint             # Run linter
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## License

[MIT](LICENSE)
