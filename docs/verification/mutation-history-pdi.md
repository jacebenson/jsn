# PR #337 terminal validation

Executed 2026-10-29 from the PR checkout after merging current main
(`00be2b7`). This is real terminal output against the selected `pdi` profile;
credentials and private records are omitted.

```text
$ node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
ok: true
profile.name: pdi
authenticated: true
verified: true
probe_status: succeeded

$ JSN_NO_HEADER=1 JSN_NO_VERSION_CHECK=1 JSN_NO_SKILL_CHECK=1 node bin/jsn.js --profile pdi records list --table sys_db_object --query name=incident --columns name,label --limit 1 --json
ok: true
data.table: sys_db_object
data.count: 1
data.records[0].name: incident
data.records[0].label: Incident
data.pagination.total: 1
```

The PDI request above is read-only and proves the merged CLI still reaches the
connected instance through its selected OAuth profile. It does **not** prove a
live mutation was recorded. No ServiceNow record was created, updated or deleted
for this verification. Write-history behavior was tested with an isolated local
HTTP fixture using the actual CLI, including custom records, incidents and the
factory property command, create/update/delete, supplied reasons, redaction,
authentication replay and local storage failure.

```text
$ node --experimental-test-module-mocks --test test/mutation-history.test.js test/capabilities.test.js test/mutation-context.test.js
25 tests passed; 0 failed

$ npm test
1470 tests; 1468 passed; 2 skipped; 0 failed

$ npm run lint
exit 0
```

The two skipped tests are existing optional docs-search cases. No credentials,
record payloads or tokens are included in this evidence. A live-write test would
require a deliberately chosen disposable record and approved mutation scope.
