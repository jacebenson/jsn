---
title: Use JSN safely
layout: comparison.njk
subtitle: JSN defaults to inspection first and puts explicit gates around destructive ServiceNow changes.
docStep: 3
docLabel: Safety
docPrev: /docs/setup/
docPrevLabel: ← Connect
docNext: /docs/agents/
docNextLabel: Add an agent →
permalink: /docs/safety/
---

## Safe by default

Use a read-only profile while exploring. Deletes require an explicit force flag, and mutation commands show what they are going to change.

```bash
jsn auth modify <profile>
jsn records list --table incident --query "active=true"
jsn records delete --table incident --sys-id <id> --force
```

Treat `--force` as a deliberate boundary, not a convenience flag. Test against the correct profile, scope, and update set before changing an instance.

[Read about safe deletion](/features/safe-servicenow-record-deletion-cli/).
