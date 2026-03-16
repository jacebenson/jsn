# ServiceNow CLI (JSN CLI)

**Agent-first, agent-native** █

This CLI is designed for AI agents that run in your terminal. Claude, Codex, OpenCode, Cursor — all are welcome. If you're using an AI assistant to help you understand, fix, or build on ServiceNow, this tool gives your agent the same access you have through the UI.

```bash
# Install in seconds
curl -fsSL https://getaiinabox.com/install-jsn | bash

# Let your agent explore
jsn tables list
jsn tables schema incident
jsn rules list --table incident
```

---

## Why This Exists (Or: The Graveyard of ServiceNow Dev Tools)

I've been working on [getaiinabox.com](https://getaiinabox.com) and trying to use tools that actually, you know, work. I've been using [OpenCode](https://opencode.ai) to interact with ServiceNow via the Table API, which is "fine"—except these APIs were designed for systems integration, not for humans (or agents) trying to understand their instance.

If we want real innovation in this space, we have to stop hiding tools behind enterprise licensing agreements and convoluted setup processes. This is my attempt to build the CLI I actually want to use — and that my AI agent can use to help me.

### The Official Corpse

**[ServiceNow's "Official" CLI](https://github.com/ServiceNow/servicenow-cli)** – Last meaningful update: 2 years ago. Requires you to install a server-side application on your instance just to use it. Abandoned before it ever really lived.

### The Over-Engineered Monstrosity

**[ServiceNow Fluent SDK](https://github.com/ServiceNow/sdk)** – Follow the link rabbit hole and you eventually hit the [docs](https://www.servicenow.com/docs/r/application-development/servicenow-sdk/servicenow-sdk-landing.html). I actually tried to use this. For YEARS this thing had dependency issues that made it break on different operating systems. It took me meeting with what was effectively a Fluent evangelist just to get it running.

Then I spent a day migrating a global scope app to a "proper" scoped app using Fluent, only to discover it made everything WORSE. Why? Because once you ship an import, you can only fix it through the SDK—not in the instance UI. Oh, and the auth configuration? Completely baffling. I can't stand it.

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

I'm building this with three principles that seem obvious but apparently nobody else has tried:

### 1. Actually Fucking Useful

Not "deploy a scoped app" useful—**"explore and understand your instance"** useful. The kind of tool that answers questions like:
- "What business rules fire on the Incident table?"
- "What widgets are in this Service Portal?"
- "Show me the schema of this table without clicking through 12 UI screens"

### 2. Zero Bullshit Setup

One binary. No server-side plugins. No dependency hell. No auth configuration that requires a PhD.

```bash
jsn setup  # Interactive first-time setup
jsn tables list
```

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

```bash
# Agent-friendly JSON output
jsn tables list --format json
jsn tables schema incident --format json
jsn rules list --table incident --format json
```

---

## Command Reference

> **Note:** Arguments in `[brackets]` are optional. When omitted, an interactive picker will help you select from available options.

### Configuration & Auth
```
jsn setup                                    # Interactive first-time setup
jsn config add <name> --url <url> --username <user>
jsn config switch <name>
jsn config list
jsn auth login                               # Authenticate with g_ck token
jsn auth status                              # Check authentication status
```

### Tables (Table metadata & schema)
```
jsn tables list [--scope <scope>]
jsn tables show [<name>]                     # Picker if name omitted
jsn tables schema [<name>]                   # Shows inheritance (extends FROM and TO)
jsn tables columns [<name>]                  # Picker if name omitted
```

### Records (CRUD operations)
```
jsn records query <table> [--where <encoded-query>] [--fields <fields>] [--limit <n>]
jsn records get <table> [<sys_id>]           # Picker if sys_id omitted
jsn records create <table> --data '<json>'
jsn records update <table> <sys_id> --data '<json>'
jsn records delete <table> <sys_id>
jsn records count <table> [--where <encoded-query>]
```

### Attachments
```
jsn attachments list --table <table> --record <sys_id>
jsn attachments download <sys_id> [--output <path>]
jsn attachments upload --table <table> --record <sys_id> --file <path>
```

### Imports
```
jsn imports list
jsn imports show <id>
jsn imports status <id>
```

### Choices (sys_choice values)
```
jsn choices list <table> <column>              # List choice values ordered by sequence
jsn choices create <table> <column> --value <val> --label <label> [--sequence <n>] [--dependent <val>]
jsn choices update <sys_id> [--label <new>] [--sequence <n>] [--inactive|--active]
jsn choices delete <sys_id> [--force]
jsn choices reorder <table> <column> --mode <hundreds|alpha>
```

### Flows (Process automation)
```
jsn flows list [--active]
jsn flows show [<name>]                      # Picker if name omitted
```

### Rules (Business rules)
```
jsn rules list --table <table>
jsn rules show [<id>]                        # Picker if id omitted
```

### Jobs (Scheduled/script jobs)
```
jsn jobs list [--type scheduled|script]
jsn jobs show [<id>]                         # Picker if id omitted
```

### Actions (Flow/Workflow actions)
```
jsn actions list
```

### Integrations
```
jsn integrations rest list
jsn integrations soap list
jsn integrations email list
```

### Access (Roles, ACLs, policies)
```
jsn roles list
jsn roles show [<name>]                      # Picker if name omitted
jsn acl list --table <table>
jsn acl show <id>
jsn policies list
jsn criteria list
```

### Portals (Service Portal)
```
jsn portals list
jsn portals show [<id>]                      # Picker if id omitted
jsn portal-widgets list [--portal <id>]
jsn portal-themes list
```

### Forms (UI Forms)
```
jsn forms list [--table <table>]
jsn forms show <table>
```

### Lists (UI Lists)
```
jsn lists list [--table <table>]
```

### UI Policies
```
jsn ui-policies list [--table <table>]
```

### UI Scripts
```
jsn ui-scripts list [--table <table>]
jsn ui-scripts show [<name>]                 # Picker if name omitted
```

### Workspaces
```
jsn workspaces list
jsn workspaces show [<name>]                 # Picker if name omitted
jsn workspace-pages list [--workspace <name>]
jsn workspace-components list
```

### Script Includes
```
jsn script-includes list [--scope <scope>]
jsn script-includes show [<name>]            # Picker if name omitted
```

### API Documentation
```
jsn api docs <api-name>                      # gliderecord, glideajax, etc.
```

### Scopes & Applications
```
jsn scopes list
jsn scopes show [<name>]                     # Picker if name omitted
jsn apps list
jsn apps show [<name>]                       # Picker if name omitted
```

### Update Sets
```
jsn updateset list [--scope <scope>] [--state <state>]
jsn updateset show [<name>]                  # Picker if name omitted
jsn updateset use [<name>]                   # Picker if name omitted
jsn updateset create <name> [--scope <scope>] [--description <desc>]
jsn updateset parent [<child> <parent>]      # Picker if args omitted
```
