---
title: Workflow preferences
---

Configure JSN's opinions about operations, testing guidance and update-set naming. Preferences are installation-wide and can be overridden per connection profile. Existing behavior is the default, so nothing changes until you set a value.

## Precedence

Values resolve per field:

1. built-in defaults
2. installation settings (`preferences` in the global config file)
3. the selected profile's override (`profiles.<name>.preferences`)

A narrower layer only replaces the fields it names; everything else inherits. An explicit `false`, an empty array, or `none` is a real value and wins over a broader layer.

Project-local `.servicenow/config.json` is **never** read for these settings. They are installation-wide opinions, not per-project trust.

```bash
jsn preferences show
jsn preferences show --profile production --json
jsn preferences set operations.delete false
jsn preferences set testing.methods atf,scan,fixscripts
jsn preferences set updatesets.initials JB --profile production
jsn preferences unset updatesets.initials
```

`show` reports the source of every value (`default`, `installation`, `profile`). `set`/`unset` write only the global config, atomically with mode `0600`; unrelated keys and other profiles are preserved.

## Operations

`operations.create`, `operations.update`, `operations.delete` default to `true`. When one is `false`, JSN refuses matching known operations before any handler runs, so no request is sent:

```bash
jsn preferences set operations.delete false
jsn records delete-many --table incident --query "active=true"   # operation_denied, no write
```

The guard is a workflow preference, not a security boundary. It classifies operations JSN itself declares (create/update/delete verbs, `records delete-many`, `attachments upload`, update-set lifecycle, raw REST with an explicit `DELETE`/`POST`/`PUT`/`PATCH` method, and `eval`, which is treated as update). It does not analyze scripts or arbitrary code and cannot stop mutations made through `fix scripts`, background scripts, GraphQL, or REST calls from other tools. A read-only profile still takes precedence and `--force` cannot bypass a disabled operation.

## Testing guidance

`testing.recommend` (default `true`) controls whether JSN offers testing. `testing.methods` (default `["atf","scan"]`) selects which methods appear in guidance and command hints:

- `atf` — ATF tests
- `scan` — instance scans
- `fixscripts` — fix scripts
- `backgroundscripts` — background scripts
- `none` — no method (guidance is suppressed)

`testing.suggestMissing` (default `true`) controls the "or create missing checks" wording. Setting `recommend` to `false` suppresses recommendation hints entirely; explicit `jsn atf` and `jsn scan` commands remain available. JSN never auto-creates or auto-runs tests.

```bash
jsn preferences set testing.methods fixscripts,backgroundscripts
jsn preferences set testing.suggestMissing false
jsn preferences set testing.recommend false
```

## Update-set naming

`jsn updatesets create` can render a name from a template instead of requiring `--name`:

| Field | Default | Meaning |
| --- | --- | --- |
| `updatesets.nameTemplate` | `{{tracker}}-{{date}}-{{initials}}-{{scope}}` | Tokens: `{{tracker}}`, `{{date}}`, `{{initials}}`, `{{scope}}` |
| `updatesets.initials` | empty | Your initials for `{{initials}}` |
| `updatesets.dateFormat` | `YYYY-MM-DD` | `YYYY`, `MM`, `DD` separated by `-`, `_` or `.` |

```bash
jsn preferences set updatesets.initials JB
jsn updatesets create --tracker STRY001
# STRY001-2026-11-23-JB-x_custom
```

`--name` is always used verbatim and is never templated. When `--name` is omitted, rendering happens locally with no network access. A template that uses a missing value (no tracker, unset initials, unknown local scope) or an invalid token is a usage error with an actionable hint, and **no create request is made**. `{{scope}}` uses only a locally known scope: `--scope`, the local profile scope, or the session context — it never fetches one.

## Limits

- Preferences live in the global config only; project config cannot set or override them.
- The operation guard understands JSN's declared commands, not arbitrary code paths or `records bulk`-style mixed batches.
- Testing guidance is text and hints, not enforcement; a user or agent can still run explicit test commands.
- No template rendering performs instance lookups, so scope must already be known locally.
