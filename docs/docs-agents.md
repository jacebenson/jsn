---
title: Use JSN with AI agents
layout: comparison.njk
subtitle: Give Hermes, OpenCode, VS Code, Claude Code, Cursor, Codex, Copilot, or any shell-capable language-model harness a safe ServiceNow tool.
docStep: 4
docLabel: Agents
docPrev: /docs/safety/
docPrevLabel: ← Make it safe
docNext: /docs/output/
docNextLabel: Learn the output →
permalink: /docs/agents/
---

## One CLI. Many agent harnesses.

JSN does not require a hosted MCP server. An agent uses the same local CLI a person uses, with the ServiceNow skill providing command knowledge, safety rules, and output expectations.

The integration has two parts:

1. Install JSN so the harness can execute `jsn`.
2. Install the ServiceNow skill so the harness knows when and how to use it.

```bash
npm install -g @jacebenson/jsn
jsn setup
jsn skill install
```

The default interactive installer lets you choose one or more supported targets.

## Supported harnesses

| Harness | Target | Install command |
|---|---|---|
| Hermes Agent | `hermes` | `jsn skill install --target hermes` |
| OpenCode | `opencode` | `jsn skill install --target opencode` |
| VS Code / GitHub Copilot instructions | `vscode` | `jsn skill install --target vscode` |
| GitHub Copilot | `copilot` | `jsn skill install --target copilot` |
| Claude Code | `claude` | `jsn skill install --target claude` |
| Cursor | `cursor` | `jsn skill install --target cursor` |
| Codex CLI | `codex` | `jsn skill install --target codex` |
| OpenClaw | `openclaw` | `jsn skill install --target openclaw` |
| Agents-compatible tools | `agents` | `jsn skill install --target agents` |

Install to several targets at once:

```bash
jsn skill install --target hermes,opencode,claude,cursor
```

Or install everywhere JSN knows how to write:

```bash
jsn skill install --target all
```

## How the agent should use JSN

The skill tells an agent to use the most specific command first, then fall back deliberately:

1. Use a domain command such as `jsn flows`, `jsn catalogitems`, `jsn forms`, or `jsn logs`.
2. Use generic records for a table that does not have a dedicated command.
3. Use `jsn docs search` for offline ServiceNow documentation.
4. Use `jsn rest` when the CLI does not expose the endpoint yet.
5. Treat `jsn eval` as a last resort.

For machine-readable results, add `--json`:

```bash
jsn records list --table incident --query "active=true" --json
```

The agent should use `sys_id` for mutations, identify the target profile, and ask for approval before creating, updating, deleting, or executing anything that changes an instance.

## Hermes, OpenCode, Claude Code, Cursor, and Codex

These harnesses can use the installed skill as local instructions. The normal workflow is:

```bash
jsn skill install --target hermes
jsn skill install --target opencode
jsn skill install --target claude
jsn skill install --target cursor
jsn skill install --target codex
```

Run only the targets you use. Re-running the command refreshes the installed skill from the current JSN release.

## VS Code and GitHub Copilot

Install the VS Code instruction target or the Copilot target depending on how your workspace is configured:

```bash
jsn skill install --target vscode
jsn skill install --target copilot
```

The CLI writes the ServiceNow instructions into the corresponding user-level instruction location. The agent still calls the local `jsn` executable; the instruction file is the guide, not a second API.

## Any other language-model harness

A harness only needs two capabilities:

- It can run a local shell command.
- It can read a Markdown instruction file or accept system/tool instructions.

Install JSN for the harness user, then give the model the bundled ServiceNow skill or the repository copy:

```bash
npm install -g @jacebenson/jsn
jsn setup
jsn skill path
```

If the harness has a project-level instruction mechanism, copy or reference the skill at `skills/servicenow/SKILL.md`. Tell the agent to use `jsn --help` and `jsn <command> --help` when it needs to discover a command instead of inventing flags.

A minimal generic tool contract looks like this:

```text
Tool: shell
Command: jsn <specific command> --json
Rules:
- Check jsn auth status first.
- Use --profile when the target instance matters.
- Prefer read-only commands.
- Ask before mutations.
- Never run logout unless explicitly requested.
```

That is enough to use JSN from a homegrown agent, a CI task, or another model runner without building a custom ServiceNow connector.

## What JSN does not do

JSN does not give an agent permission to bypass ServiceNow ACLs, approvals, or instance policy. It does not hide mutations behind an agent abstraction. The command, profile, scope, update set, and output remain visible and inspectable.

[Install JSN](/docs/install/) · [Configure authentication](/docs/setup/) · [Use JSN safely](/docs/safety/) · [Agent skill feature](/features/servicenow-agent-skill-installer/)
