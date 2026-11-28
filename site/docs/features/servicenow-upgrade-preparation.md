---
title: Read-only upgrade preparation
---

`jsn upgrade prep` collects evidence for an AI-assisted platform or Store application upgrade briefing. Use it when preparing a family release, functional patch, security update or hotfix, as well as Store updates; the command does not infer those classifications or advisories from version strings. It does not upgrade an instance, choose a future target, generate a preview, run tests or scans, schedule a clone, resolve skips, or change feature settings. Bare `jsn upgrade` and `jsn update` still update the npm CLI.

```sh
jsn upgrade prep --profile production --format markdown
jsn upgrade prep --profile production --json
jsn upgrade prep --instance https://example.service-now.com --get data.sources
jsn upgrade prep --profile production --target 'Exact local target label' --json
jsn upgrade prep --profile production --related-profile test --related-profile development --json
jsn upgrade prep --profile production --customizations existing-capture-id --json
```

Explicit `--profile` or `--instance` is required. Read-only production inspection is allowed. A related profile is an explicit operator declaration, not a relationship inferred from its name. Related profiles use their own session and credential binding. A local customization capture must match the primary instance exactly.

## Evidence collected

- Local platform targets and scheduling/lifecycle metadata. A target is optional; an exact supplied label, value or record ID is matched against the bounded local catalog. This does not guarantee current upgrade eligibility.
- Last completed platform history, filtered by `to_versionSTARTSWITHglide` and nonempty `upgrade_finished`. It is historical evidence, not the live node build, and excludes ordinary update-set applications.
- Installed Store app versions and update flags. Equal versions with a true flag and different versions with a false flag are reported as metadata conflicts, not silently reconciled. Only explicit `true`/`1` or `false`/`0` flags and two nonempty readable versions can establish a conflict. Omitted, blank and unrecognized flags remain missing evidence, not false flags. Different versions do not prove a newer, compatible or authorized update.
- Existing preview and preview-log records. Dictionary discovery gates preview fields; the briefing retains actual severity, priority and disposition values without assigning invented severity labels. Preview scope, age and relation to the target still need review.
- Unresolved historical skips whose base changed (Changed true), through the existing skipped-update reader; unchanged skips are not counted. Historical skips are not predictions of what the next upgrade will skip.
- A bounded clone-table catalog and dictionary-established fields for up to four tables. Clone request/history/preservation/exclusion semantics and applicability need operator confirmation. Missing or denied schema is a gap, never a guessed schema.
- Existing recent ATF result IDs and Instance Scan execution IDs, each capped at three per result family. Existing readers inspect them; no test or scan is dispatched. ATF status can be inferred by its reader. Verify scope, age and relation to the selected target.
- Local customization evidence when an existing capture is supplied. No new capture is written.
- Update-set and retrieved-update-set evidence for explicitly supplied related profiles. Missing retrieval evidence does not mean there is no backup or recovery path.

## Machine-readable contract

The normal output envelope contains `data.sources`, `data.findings`, `data.activities`, `data.limitations`, and the optional `data.target`. Use `--get data.sources` to extract reproducible reads.

Each source names its exact profile and instance, table, requested fields, encoded query, record IDs, observed time, source timestamps, raw records, HTTP method/path/parameters, and a GET-only CLI read command. Empty `fields` means a single-record reader requested all provider-readable fields. The parameters are the exact Table API read parameters, including reference-link handling. Read commands omit counts and preserve display mode; the method/path/parameters remain authoritative.

Bounds include the requested limit and offset. A full page means possible truncation, not a total count. The default limit is 50, configurable from 1 to 200; dictionary reads cap at 200, clone table discovery at five, and ATF/scan discovery at three. Findings point back to source IDs. Source timestamps older than 30 days produce `stale` findings; that threshold is a review prompt, not a vendor validity rule. Missing requested fields are reported separately from blank values.

Statuses distinguish `verified_problem` for a directly observed metadata contradiction, reader-reported ATF failure or existing scan finding from `observed`, `missing`, `stale`, `inaccessible`, `error`, and `not_checked`. Empty or inaccessible evidence never certifies absence of problems. Every briefing remains `incomplete` and provides no readiness score.

Activities have IDs, source references, dependencies, pending status, and completion checks. They cover evidence retrieval, workflow preservation, target review, recovery and UAT. Official target-specific defaults, optional features, deprecations, migrations and security advisories remain actionable human gaps. A version suffix is not a security advisory.

## Technical upgrade versus feature activation

First preserve existing workflows and identify unavoidable behavior changes. Review target-specific documentation, customization and preview decisions, lower-environment work, clone preservation rules, recovery ownership and business testing. Plan optional feature activation separately after the technical upgrade, with its own owners, tests and rollback decisions. Some changes are unavoidable; the briefing does not promise behavior preservation or disable new features.

## Safety and limitations

Collectors expose only Table API GET methods, including to reused readers. Normal authentication bootstrap may use POST. The command does not call stateful GET processors, background scripts, preview creation, clone scheduling, scan/test dispatch, install or upgrade endpoints. Read-only profile settings remain intact.

A complete-looking bounded result is still not a readiness certification. Obtain authoritative target release and security notes, verify fresh eligibility and Store compatibility, review recovery rehearsals and backup ownership, and get business-owner UAT approval before scheduling changes.

## Sanitized demo

The fixture helper in `cli/test/support/upgrade-prep-fixture.js` serves synthetic loopback Table API records and rejects non-allowlisted data requests. Tests invoke the actual CLI with isolated synthetic configuration. Screenshot evidence must come from those real invocations and be labeled fixture data; never substitute live profiles, domains or records.
