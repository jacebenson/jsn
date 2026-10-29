# Records engine verification

Terminal evidence captured against the connected `pdi` profile on 2026-10-28
(America/Chicago), using the repository binary. Sanitized command/results are in
[records-engine-live.json](records-engine-live.json); opaque record identifiers
are masked. No instance create/update/delete operations were performed.

The mandatory doctor initially stopped with `authenticated: false` and
`refresh_required`; no live reads ran in that state. Following separately
approved credential renewal, this command exited 0 immediately before the smoke:

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
```

Doctor reported authenticated/verified true and probe_status succeeded. Cleanup
retained local doctor evidence `doctor-2026-10-29T04-28-38-409Z.json`.

## Actual connected-instance results

- Generic exact lookup of built-in incident table metadata returned name incident,
  label Incident. An unambiguous sys_id prefix resolved the same metadata record.
- An explicitly missing metadata name returned exit 1, code not_found and
  resolution `{field: name, mode: exact, matches: 0}`.
- Profile-built `tables show incident --json --get data.name` returned the
  expected `{display_value: incident, value: incident}` pair, as did explicit
  generic `--display-values both`.
- Existing active incident UI policy show returned `_essential.actions.loaded`
  equal to 1 and status loaded. Only those scalar projections were printed;
  policy contents, scripts, conditions, users and child payloads were not dumped.

## Local fixture results and limits

The shared-engine full suite passed 1,447 tests (2 skipped); profiles passed
1,450 (2 skipped); essential relationships passed 1,455 (2 skipped). Lint passed.
The local docs doctor/drive/cleanup lane also passed. Subsequent raw-ID safety
regression tests passed 18 focused tests, including the actual CLI fixture.

Local HTTP CLI tests cover custom/legacy identifiers, exact/prefix/suffix,
ambiguity and zero matches, display representations, selected profiles,
read-only blocking, confirmations, resolved mutation targets and HTTP call
counts. Essential-child tests verify one bounded child read, raw parent ids,
truncation, explicit ACL/unavailable states, JSON/--get/styled output and opt-out.
These mutation/error fixtures are not claims of live mutation coverage. No live
legacy-id, ambiguous-id, write, ACL-denied or truncation experiment was run.

## Per-PR terminal proof after registry compaction

Each source revision below ran its own mandatory authenticated/verified doctor
immediately before read-only PDI commands, followed by cleanup. Separate detached
source snapshots kept the combined full-suite checkout stable.

| PR | Source revision | Sanitized terminal proof | Actual read coverage |
| --- | --- | --- | --- |
| #338 | f8052ce | [pr338-live.json](pr338-live.json) | Exact metadata lookup, same-record prefix, structured zero match |
| #340 | 5c780b2 | [pr340-live.json](pr340-live.json) | Compact 66-line registry; tables command and table alias |
| #342 | e24b299 | [pr342-live.json](pr342-live.json) | Existing essential action loaded=1/status=loaded; opt-out keeps parent |
| #344 | 503de71 | [pr344-live.json](pr344-live.json) | Combined current-main integration of all the above; 70-line registry with UI policies |

Opaque IDs are masked; schema labels and scalar child counts are retained. These
checks performed no live writes. The earlier PRs merged into dependency branches;
#344 is the explicit main-targeted integration of their reviewed implementations.
