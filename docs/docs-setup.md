---
title: Set up JSN
layout: comparison.njk
subtitle: Connect JSN to a ServiceNow instance with a named profile and safe defaults.
docStep: 2
docLabel: Connect
docPrev: /docs/install/
docPrevLabel: ← Install
docNext: /docs/safety/
docNextLabel: Make it safe →
permalink: /docs/setup/
---

## Connect an instance

Run the setup wizard and choose OAuth when available:

```bash
jsn setup
```

JSN stores named profiles so you can switch between instances without rewriting commands. Start with read-only mode while you learn the command surface.

```bash
jsn auth status
jsn auth modify <profile>
```

[Read the full authentication feature](/features/servicenow-cli-auth-setup/).
