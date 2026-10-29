# Connected PDI CRUD, capture-context and history proof

2026-10-29; actual CLI from main containing #336/#337, with an authenticated,
verified `pdi` profile. User explicitly requested each PR be tested against PDI.

The selected context was Global with an existing named, in-progress update set.
The test did not select a new scope/set, complete any set, change profile settings,
or override Global + Default. It created one uniquely named, inert
`sys_user_preference` belonging to the current user, updated its value, read it
back and removed only that returned record ID. A final read verified cleanup.
The preference name uses `jsn.validation.*` and has no application function.

```text
$ node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
ok: true; authenticated: true; verified: true; probe_status: succeeded

$ node docs/verification/pdi-crud-live.mjs pdi
records create: PASS; full resolved ID returned; ordinary context approval not required
records update: PASS
records get: PASS; updated value verified
records delete: PASS; explicit cleanup approval only for this test-created record
cleanup_verified: true
history: exactly 3 entries; create/update/delete all succeeded
history resolved ID matches: true
history supplied reason matches: true
ok: true
```

[pdi-crud-live.mjs](./pdi-crud-live.mjs) is the exact reproducible test with a
further context-stability check before forced cleanup. It performs writes and
requires explicit authorization for its disposable target profile. The
[sanitized result](./pdi-crud-live-result.json) contains no credentials, usernames,
instance hostname, record ID, real preference values or private record contents.

This validates #337's actual remote write history and #336's ordinary non-Default
context path. It does not induce Global + Default or alter the user's current
selection to test that branch. High-risk context blocking and no-write-on-decline
remain separate fixture assertions. The generic CLI path here predates the #338
resolver integration; do not claim it validates #338's ambiguity/human-ID cases.
