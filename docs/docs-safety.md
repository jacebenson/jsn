---
title: Use JSN safely
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

Use a read-only profile while exploring. Setup's default preset allows writes;
read-only mode is an explicit profile setting. ServiceNow roles and ACLs still
control access. A compact help menu is not an access boundary.

```bash
jsn auth modify <profile> --read-only
jsn records list --table incident --query "active=true" --limit 5 --json
```

Writes do not all offer the same confirmation or preview behavior. Read each
command's help before enabling writes. Deletion normally asks for confirmation;
`--force` or an explicitly configured skip-confirmations policy can bypass that
prompt. A read-only profile still blocks instance mutations.

Treat `--force` as a deliberate boundary, not a convenience flag. Test against the correct profile, scope, and update set before changing an instance.

[Read about safe deletion](/features/safe-servicenow-record-deletion-cli/).
