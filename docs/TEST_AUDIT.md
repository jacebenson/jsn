# Behavior-first test audit

Issue [#365](https://github.com/jacebenson/jsn/issues/365), reviewed against
`73fb796` on 2026-10-29. This is a bounded pilot and safety/auth review, not a
claim that every suite has been audited. Keep `node:test`. The proposed 50-test
goal is abandoned: there is no count ceiling, deletion percentage, or coverage
quota. Count changes below describe the result, not a target.

## Upstream examples examined before updating AGENTS.md

| Source | Concrete pattern to adopt | What not to import |
| --- | --- | --- |
| [yargs helper tests](https://github.com/yargs/yargs/blob/main/test/helpers.mjs) | The `applyExtends` tests assert merged configuration and reject prototype pollution; check useful results and negative side effects at the helper boundary. | Do not copy Mocha/Chai or assume every internal helper needs an export/type assertion. |
| [oclif parser error tests](https://github.com/oclif/core/blob/main/test/parser/error-codes.test.ts) | A shared `runCommand` helper exercises real command parsing, verifies error exit codes, and fails explicitly if a command unexpectedly succeeds. Distinguish default and configured behavior. | Its Cache prototype stub is framework-specific; avoid making JSN's incidental private structure a contract. |
| [npm ping tests](https://github.com/npm/cli/blob/latest/test/lib/commands/ping.js) | Shared mock-NPM and registry fixtures exercise command output, JSON shape, malformed responses, and unreachable-registry errors without a real registry. | Do not adopt tap or a universal coverage threshold merely to match npm. |
| [Prettier fixture runner](https://github.com/prettier/prettier/blob/main/tests/config/format-test/run-format-test.js) | Normalize fixture context once and run every fixture through a shared runner, preserving parser/options distinctions and explicit error fixtures. | Do not import a formatter-sized runner or snapshot everything; JSN's small tables can share setup while retaining explicit expectations. |

These lessons inform the contract/layer/fixture/failure/verification recipe in
`AGENTS.md`. No framework migration or new test dependency is needed.

## Implemented changes and retained coverage

| File | Cases before → after | Decision and remaining coverage |
| --- | --- | --- |
| `test/unit.test.js` | 8 → 5 | Remove export-only and duplicate trailing-slash checks; SDK construction and slash normalization remain in `sdk-client.test.js`. Remove the prototype-name blacklist: no matching documented invariant was found, and SDK has real domain operations already. Keep public method availability in SDK tests. Replace keyring-dependent boolean-type auth check with injected stored credentials and exact available/missing outcomes. Keep URL normalization, constructor defaults, HTML script output, and no-instance authentication. |
| `test/helpers.test.js` | 25 → 24 | Share JSON-file setup for simple typed data and exact multiline script text, with labeled deep equality for both and guaranteed cleanup. All seven write-back cases are unchanged. |
| `test/auth-manager-basics.test.js` | 5 → 4 | Remove the misleading PKCE test that only checks `httpClient` exists. Real URL/token-exchange coverage is strengthened below. Exact authentication true/false checks remain. |
| `test/auth-oauth.test.js` | 4 → 3 | Merge duplicate default-URL/type-length assertions into parsed URL expectations. The same case now captures a mocked token exchange and independently hashes the exchanged verifier to verify the emitted S256 challenge. Profile-concurrency and hostname-normalization cases remain. |
| `test/sdk-client.test.js` | 19 → 17 | Remove export-only and prototype-name blacklist checks. Actual SDK construction, requests, auth, script outputs/failures, uploads, export transport and public method availability remain. |
| `test/auth-command.test.js` | 11 → 10 | Remove export-only check; the next tests construct the command and verify registration, and auth handler/workflow suites exercise it. |
| `test/updatesets.test.js` | 25 → 24 | Remove export-only check; command registration, resolver behavior, detail formatting and actual export handlers remain. Completion/readback and fallback suites are untouched. |

The pilot's 33 cases become 29, with 370 → 316 lines of test code. Across all
seven changed files, 97 cases become 87 and 1,525 → 1,437 lines. Loops inside
one test still exercise multiple scenarios; reducing declarations is not evidence
of reducing behavior coverage. No production code changed.

Safety review also included `mutations`, `capabilities`, `auth-credentials`,
`auth-shared-workflow`, `auth-creds`, `confirm-delete`, `updatesets-resolve`,
`updatesets-complete`, `usability-safety-group-mutations`, and `security` test
files. The 17 owned files contain 249 registered cases before and 239 after,
including 19 generated/ordinary group-mutation cases. This source-derived
inventory is distinct from an executed whole-suite result.

Retain distinct scenarios for credential identities, method precedence,
redaction, read-only and alias middleware, force/profile confirmation policy,
unsafe query identifiers, update-set scope fallbacks, denied/cancelled writes,
unreadable descriptions, platform-dropped fields and failed readback. Helper
coverage alone cannot replace command-level proof that denied operations do not
write. No auth, confirmation, update-set or write-back safety cases were removed.

## Verification

The pilot passed 33/33 before and 29/29 after using Node 24.19.0:

```bash
node --experimental-test-module-mocks --test --test-isolation=none \
  --test-reporter=tap test/unit.test.js test/helpers.test.js
```

One local sample was 165 ms before and 108 ms after; this is noisy diagnostic
data, not a performance claim. Seven changed files also passed together with
normal process isolation. This environment's sandboxed process-isolated reporter
summarized files instead of individual cases, so that result is seven passing
files, not seven total cases. Independent no-isolation runs can expose case
counts; do not run all module-mocked suites together without isolation.

The parent ran the full non-live suite outside the sandbox with isolated
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME`: 1,628 tests, 1,626 passed, two skipped,
zero failures, 162.6 seconds. Cached ESLint passed for `src/ bin/ test/`.
The parent also ran clean-main baseline with isolated configuration: 1,638 tests,
1,636 passed, two skipped, zero failures, 154.7 seconds. Before/after whole-suite
runs overlapped other work; neither those times nor the pilot sample establish
a speed improvement. A sandboxed run encountered local-server/process
restrictions and is excluded from the comparable baseline.
Tests that create real ServiceNow records were not run.

## Prioritized follow-up review

1. **Safety proof before shortening tests.** Strengthen the group read-only CLI
   cases with a controlled transport/request spy: currently they assert a
   read-only error and absence of lookup errors, which is weaker than directly
   proving no request. Preserve primary and alias command paths.
2. **Document or replace architecture checks.** `auth-credentials.test.js` scans
   command source for credential-method spellings. Decide whether this is a
   deliberate boundary invariant and document why, or replace it with a setup
   workflow proving identity-preserving persistence through injected AuthManager.
   Existing injected-store and shared-workflow tests are useful context, not an
   automatic justification for deletion.
3. **Consolidate mutation examples cautiously.** `mutations.test.js` repeats
   catalog create/list assertions across default and explicitly derived paths.
   Preserve generation and classifier boundaries, old invalid command spellings,
   list/show negatives and trailing positional arguments when sharing cases.
4. **Reduce fixture duplication separately.** Auth tests repeat temporary config,
   environment and credential-store fixtures. Extract only narrow stable seams;
   retain cleanup and same-instance/profile identity distinctions. SDK constructor
   and script examples still overlap between unit and SDK suites; decide their
   owner in a later focused pass rather than expand this pilot further.
5. **Reconcile the remaining suite inventories.** Apply each area audit's concrete
   evidence in separate changes, report actual executed counts, skips and runtime,
   and review output changes deliberately. Do not extrapolate this pilot's ratio.

The separate flow-editing/update-set capture issue #295 remains out of scope.
