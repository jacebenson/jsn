# Update-set preview / problems / commit verification

Issue #298, follow-up to the merged retrieval/export/reopen work in PR #351.
Branch `feat/298-updatesets-import`.

## What was added

- `updatesets preview <name|sys_id>` — starts the platform preview through the
  CICD Update Set API and follows its progress tracker.
- `updatesets problems <name|sys_id>` (alias `preview-problems`) — read-only
  `sys_update_preview_problem` listing keyed by `remote_update_set`.
- `updatesets commit <name|sys_id>` — refuses an unpreviewed set or any
  unresolved preview problem, then commits through the same API and verifies the
  resulting state.
- `import` now refuses `--name`, `--local`, and `--state` explicitly, and points
  at preview/commit/reopen for the state transitions.

## Live verification — dev366743.service-now.com, 2026-11-05

Environment: `pdi` profile, user `admin`, OAuth, jsn 5.1.0 branch head, Node
26.8.1. The instance has the `sn_cicd` plugin and scope, the
`sn_cicd.sys_ci_automation` role is assigned to `admin`, and
`sys_update_preview_problem` started and ended the run empty.

### Endpoint behavior (verbatim)

`POST /api/sn_cicd/update_set/preview/{id}` returns **200** immediately with a
progress tracker, not a finished result:

```json
{"result":{"status":"0","status_label":"Pending","status_message":"","status_detail":"","error":"","links":{"progress":{"id":"ee54f3629358d35016c8fd18dd03d60c","url":"https://dev366743.service-now.com/api/sn_cicd/progress/ee54f3629358d35016c8fd18dd03d60c"}},"percent_complete":0}}
```

`GET /api/sn_cicd/progress/{id}` (terminal success):

```json
{"result":{"status":"2","status_label":"Successful","status_message":"Preview successful for Doom 0.1.0. Commit this update set to continue.","status_detail":"","error":"","links":{"progress":{"id":"ee54f3629358d35016c8fd18dd03d60c"}},"percent_complete":100,"remote_update_set_id":"437a09e4830c9b101f9ccfd6feaad3e9","was_previewed":"","has_preview_problem":"false","preview_problem_count":"","preview_problem_url":""}}
```

A preview that fails validation reports success at the HTTP layer and failure in
the tracker:

```json
{"result":{"status":"3","status_label":"Failed","status_message":"Preview problems for jsn-407-verify-...: 1 Errors | 0 Warnings.  To commit this update set you must address all problems.","status_detail":"","error":""}}
```

Unknown identifiers return **404** with an operation envelope, and unknown routes
return the generic error shape:

```json
{"result":{"status":"3","status_label":"Failed","status_message":"","status_detail":"","error":"Update set with id 11111111111111111111111111111111 cannot be found"}}
{"result":{"status":"3","status_label":"Failed","status_message":"","status_detail":"","error":"Unable to get the execution progress for progress id: 00000000000000000000000000000000"}}
{"error":{"message":"Method not Supported","detail":"GET method not supported for API"},"status":"failure"}
```

### Response shape beyond the parsed fields

The tracker carries `remote_update_set_id`, `was_previewed`,
`has_preview_problem`, `preview_problem_count`, and `preview_problem_url` in
addition to the parsed fields. In every response observed, `was_previewed` was
an empty string, `has_preview_problem` was the string `"false"` when clear, and
`preview_problem_count` was empty when zero. jsn does not rely on any of them:
state is still read back from `sys_remote_update_set` and problems from
`sys_update_preview_problem`.

### Preview → commit cycle

1. Created local set `jsn-407-verify-20261105075501`
   (`212537e29358d35016c8fd18dd03d6f0`) and one `sys_properties` row
   `x_jsn_407_probe_20261105075501`.
2. Exported it (3372 bytes) and loaded that XML as remote set
   `a3353be29358d35016c8fd18dd03d6f6`, which read back `loaded`.
3. The first preview produced one real problem because the source record had
   been deleted after export, leaving a newer local DELETE in the disposable
   set: `Found a local update that is newer than this one`. `preview` reported
   the failure, `problems` listed it, and `commit` would have refused it. The
   disposable set's payload was emptied and the preview rerun.
4. Second preview: `Successful`, 100%, set read back `previewed`, 0 problems.
5. Commit: `Successful`, `Update set committed`, set read back `Committed`,
   `commit_date` set, `inserted: 1`, and the property existed again with its
   original sys_id.
6. The retrieved record's `update_set` field pointed at the exact local copy the
   commit produced (`1675b3269358d35016c8fd18dd03d62f`). A name lookup found two
   local sets and reported ambiguity; the platform reference is authoritative.

Cleanup left nothing behind: property 0 rows, local `jsn-407*` sets 0 rows,
remote sets back to the original two (`Doom 0.1.0`, `AI in a Box 3.1.6`, both
`Committed`), preview problems 0 rows, current update set restored to
`NullEdge Pass`.

### Already-committed sets

Previewing a set that was already `Committed` returned `Successful` but left the
state `Committed`. The command refuses that state before calling the API, so this
is a platform observation, not a supported path: only `loaded`/`previewed` sets
are previewed.

## Defects the live run exposed, fixed here

| Defect | Before | After |
| --- | --- | --- |
| 404 classification | Unknown set id (404 with a `result.error` envelope) was reported as “CICD Update Set API is not available” | Reports the platform error: `The CICD API rejected the preview: Update set with id ... cannot be found`; the missing-plugin message is reserved for route-absent 404s |
| Failure detail | `status_message:""` masked `error` because of `??` fallback | First non-empty of `status_message`, `status_detail`, `error` |
| Local copy | Name-only lookup reported ambiguity even though `sys_remote_update_set.update_set` names the exact local set | Resolves the platform reference first, falls back to name only when the reference is absent |
| Commit gate | Problem listing used best-effort `list`, so a malformed 200 looked like zero problems | Uses `listStrict`; a malformed response fails closed |

## Automated evidence

- `test/update-set-apply.test.js` (21 tests, was 16): progress normalization,
  status words, empty-message/error fallback, tracker polling, timeout without
  retry, problem normalization and unresolved refusal, CICD endpoint URL/method
  assertions, operation-level 404 versus missing plugin, failed-progress error
  text, strict problem listing, capability declaration, confirmation-before-call,
  verified state transitions, read-only problem listing, commit refusals,
  local-copy reference/ambiguity, and the import modifier refusals with zero
  instance access.
- Related suites re-run: `updatesets`, `updatesets-create-scope`,
  `update-set-import`, `update-set-transfer-commands`, `capabilities`,
  `mutations` — 130 tests pass together with the new suite.
- `npx eslint src/ bin/ test/` passes.
- `updatesets-complete` and `updatesets-resolve` fail at module load in a default
  run on Node 26.8.1 (`mock.module is not a function`); the same 4 tests pass
  with `--experimental-test-module-mocks` (19 tests). Both files are untouched by
  this branch.

## Not verified

- The 403 role path. `admin` already holds `sn_cicd.sys_ci_automation`; removing
  the role would be a write and was not performed. The command still reports that
  case as “nothing was started”.
- A route-absent 404 (plugin not installed). The 404s observed were operation
  envelopes for unknown ids; the plugin is present on this instance.
- Canceled progress (`status 4`). Not produced during the run.
- Cross-instance transfer. This was a same-instance export/import/commit round
  trip; the platform still created a retrieved set and applied it, but a
  different target instance was not available.
- Resolving a preview problem in ServiceNow. The one problem observed was
  produced by a disposable local delete; it was removed with the set rather than
  accepted or skipped, because jsn never resolves problems.
