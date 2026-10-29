# #317 connected-PDI metadata verification

Date: 2026-10-28 (America/Chicago). Branch: `codex/dynamic-metadata`.

## Terminal proof

Immediately before the live read, this branch ran:

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
```

Sanitized result at 2026-10-29 04:30:30 UTC: exit 0, `ok:true`,
`authenticated:true`, `verified:true`, `probe_status:succeeded`.
Credential contents were not read or printed. An earlier doctor had stopped at
`refresh_required`; the coordinating task subsequently performed a separately
user-approved OAuth renewal. This metadata worker performed no login or refresh.

The real CLI then ran the bounded read-only command below; its JSON was consumed
in memory and only this sanitized summary was retained:

```sh
node bin/jsn.js forms show incident --profile pdi --json
```

Terminal result at 2026-10-29 04:31:02 UTC:

```json
{
  "exit_code": 0,
  "parseable_json": true,
  "ancestor_count": 2,
  "form_present": true,
  "inherited_layout": false,
  "section_count": 4,
  "element_count": 44,
  "configured_related_count": 7,
  "discovered_related_count": 306,
  "queryable_related_count": 299,
  "platform_required_count": 6,
  "coverage_state": "partial",
  "coverage_warning_sources": ["sys_ui_related_list_entry"],
  "record_values_retained": false
}
```

One configured list could not be resolved from visible/supported metadata and
remains explicitly unavailable. This is partial coverage, not a promise that all
relationships can be counted or that scripts/ACL-hidden records were evaluated.
No related record collections, actual record values, relationship filters,
scripts, credentials or private identifiers are included in this document.
Metadata discovery used table GETs; no instance record mutations were performed.

## Fix found by live verification

The PDI has both the canonical empty-name Default view and a distinct view whose
name is literally `default`. Treating the broad result as ambiguous suppressed
the layout. The reader now prefers an exact view id/name or canonical Default
view before title/alias matches; duplicate matches at the same precedence still
fail safely. The regression test reproduces this metadata shape. The successful
rerun above retrieved the actual form-section joins and bulk element records.

## Local regression proof

```sh
node --test test/record-metadata.test.js test/forms-metadata-cli.test.js
npm run lint
```

The 14 targeted tests pass, including a real CLI against isolated local HTTP
using explicit nondefault read-only profile selection. It exercises JSON, `--get`
and human output through `forms show`, checks the section join and bulk element
endpoints, and observes exactly nine table reads for the one-section fixture.
The generic `records get` case still performs exactly one record-table read and
no metadata discovery. Session bootstrap traffic is excluded from metadata read
counts and is handled only by the isolated fixture.

Fixtures also cover optional GET-only batch grouping/result IDs, individual/batch
equivalence, no item replay, inherited/custom layouts, bounded bulk ids, scripts
marked platform-required, ACL/shape/limit uncertainty, missing ids, ambiguity,
cache isolation/invalidation, injection, authentication, cycles and depth limits.
The local docs fixture doctor/drive/cleanup also passed.

The live PDI run proves the default incident layout and current visible relation
metadata. Inherited/custom views, denial cases and batch behavior are validated
by local fixtures here; their full range was not exercised on the connected PDI.
