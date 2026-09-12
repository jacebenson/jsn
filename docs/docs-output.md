---
title: JSN output and automation
layout: comparison.njk
subtitle: Use readable terminal output for people and JSON output for scripts and agents.
docStep: 5
docLabel: Output
docPrev: /docs/agents/
docPrevLabel: ← Add an agent
permalink: /docs/output/
---

## Human output first, structured output when needed

Most commands are designed to be useful at a terminal. Add JSON output when another tool needs stable structured data.

```bash
jsn records list --table incident --limit 10
jsn records list --table incident --limit 10 --json
```

Keep the command and profile visible in scripts. That makes automation easier to review and reduces accidental cross-instance changes.

[Browse the full feature catalog](/features/).
