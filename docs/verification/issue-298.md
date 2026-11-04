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

## Evidence (hermetic only)

No ServiceNow instance was available for this change, so there is **no live
evidence** here. The author's PDI evidence for the retrieval/export half is in
PR #351 and is not repeated or extended by these tests.

Automated evidence:

- `test/update-set-apply.test.js` (16 tests): progress normalization and status
  words, tracker polling, timeout without retry, preview-problem normalization
  and unresolved refusal, CICD endpoint URL/method assertions through the SDK,
  missing-plugin reporting, capability declaration (preview/commit are
  mutations; problems is not), confirmation-before-call, verified state
  transitions, read-only problem listing, commit refusals (unpreviewed set,
  unresolved problems), local-copy reporting and ambiguity, and the import
  modifier refusals with no instance access.
- Related suites re-run: `updatesets`, `updatesets-create-scope`,
  `update-set-import`, `update-set-transfer-commands`, `capabilities`,
  `mutations` — all pass.
- `updatesets-complete` and `updatesets-resolve` fail in this environment on
  their `node:test` `mock.module` hook (`mock.module is not a function` on the
  installed Node 22.22.3). That failure is at module load, predates this branch,
  and is unrelated to the changed code.

## Not verified (requires a PDI)

- The exact `sys_cicd_progress` response shape beyond `status`,
  `status_label`, `percent_complete`, `status_message/status_detail`,
  `links.progress.id`, and `links.results.id`. Parsing is tolerant; an
  untracked response is reported rather than assumed complete.
- Whether `preview` always lands the retrieved set in `previewed` on every
  release. The command treats another state as an error by design.
- The `sn_cicd.sys_ci_automation` role requirement and the 404/403 behavior on
  instances without the plugin. Both are reported as "nothing was started".
- The local update set a commit creates when names are duplicated; jsn reports
  ambiguity instead of selecting one.
