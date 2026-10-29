# #317 metadata verification

Date: 2026-10-28 (America/Chicago). Branch: `codex/dynamic-metadata`.

## Connected PDI prerequisite

Command run from this branch:

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
```

Sanitized terminal result: exit 2, `ok:false`, `authenticated:false`,
`probe_status:not_attempted`, `probe_code:refresh_required`.
The selected connection uses OAuth. Credential contents were not read or printed.

No connected-instance metadata or forms request was attempted after this result.
No login, OAuth refresh or write was performed. This is a blocked live-verification
prerequisite, not evidence that live form or relationship endpoint shapes work.
The local doctor evidence remains under `.verification/evidence/`; it is not
committed with hostnames, identity details or private record content.

Once a fresh connection is separately authorized and available, rerun the doctor
without `--allow-unauthenticated` immediately before these bounded read-only
recipes, capture only counts/status/field-presence summaries, and preserve errors
as coverage gaps:

```sh
node bin/jsn.js forms show incident --profile pdi --json --get data.coverage
node bin/jsn.js forms show incident --profile pdi --json --get data.hierarchy
```

Avoid publishing form field values, relationship filters or private records.
Do not run an expired connection through automatic renewal without authorization.

## Local endpoint-shape proof

```sh
node --test test/record-metadata.test.js test/forms-metadata-cli.test.js
npm run lint
```

The 13 targeted tests pass, including a real CLI against isolated local HTTP
using explicit nondefault read-only profile selection. It exercises JSON, `--get`
and human output through `forms show`, checks the section join and bulk element
endpoints, and observes exactly nine table reads for the one-section fixture.
The generic `records get` case still performs exactly one record-table read and
no metadata discovery. Session bootstrap traffic is excluded from metadata read
counts and is handled only by the isolated fixture.

Unit fixtures cover optional GET-only batch request grouping and response IDs,
individual/batch equivalence, no item replay, inherited/custom layouts, bounded
bulk ids, scripts marked platform-required, source ACL/shape/limit uncertainty,
ambiguity, cache isolation/invalidation, injection, authentication and cycles.

This verifies the CLI/transport contract locally. It cannot prove current PDI
ACLs, populated metadata, live inheritance configuration or batch availability.
