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

JSN asks for your instance, a profile name (prefilled from the instance), and an authentication method. Accept the compact defaults confirmation to connect, or choose No to customize. Basic authentication also asks for your username and password. The first profile becomes your default automatically.

The default preset allows writes, asks before deleting records, and includes result totals. To block writes while learning, run `jsn auth modify <profile> --read-only`. Saved defaults and explicit flags are respected.

Change defaults later with `jsn setup --configure-defaults`, or choose **JSN settings → Defaults and documentation** in the setup hub. Use `jsn setup --configure-docs` to choose a documentation source; until then JSN uses hosted documentation. These switches bypass the hub and run the same settings questions.

On a fresh interactive installation, bare `jsn` shows a small welcome pointing to `jsn setup`. Use `jsn --help` for the complete command catalog.

```bash
jsn auth status
jsn auth modify <profile>
```

[Read the full authentication feature](/features/servicenow-cli-auth-setup/).
