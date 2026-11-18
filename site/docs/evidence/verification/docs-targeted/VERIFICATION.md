# Verification

- `npm test`: exit 0, 2,230 tests, 2,228 passed, 2 skipped, 0 failed.
- `npm run lint`: exit 0 after fixing unused destructuring names in the new helper.
- `npm --prefix docs run build`: exit 0, rerun after the capture docs were added.
- Rails `test/documentation_test.rb` under pinned Ruby 3.4.10: 4 runs,
  68 assertions, 0 failures/errors/skips. This executes the real Rails API through
  the JSON-lines Node index worker, including targeting and revision rejection.
  Initial invocation exposed mixed Ruby PATH resolution, then an uninitialized
  site test database; explicit pinned Ruby and an isolated migrated DATABASE_URL
  resolved both without changing application code or configuration.
- Focused executable CLI/shared HTTP/fallback/parser tests: 4 passed, 0 failed.
- `npm audit --omit=dev` in cli: 0 runtime vulnerabilities. Installation reported
  2 moderate CLI dev findings; docs dependency installation reported 3 high
  findings. No unrelated dependency upgrades or automatic audit fixes applied.
- Browser screenshot review confirmed legibility, panel fit and no credentials.
- No service deployment, release, instance operations, config/auth writes, skill
  expansion or edits to output.js/auth/flows/codesearch.

Parser fixtures cover duplicate headings, overloads, nested subtree boundaries,
backtick/tilde fences, mismatched fence lengths, setext, escaped punctuation,
inline code, CRLF, indented code, blockquote/list headings and intact HTML tables.
Executable tests cover native shared HTTP and a service that ignores selection
parameters, full JSON versus selected body, human output without line truncation,
--get, empty/ambiguous/missing/stale section IDs, conflicting flags and revision
and release rejection. Existing shared-service suite also runs in npm test.

Standards self-review: domain rendering remains in docs command, no generic
output change; common parser shared by service and fallback; established parser
with source slicing avoids fence heuristics and reserialization. Spec review:
page preamble/ancestor context is included; omitted sections are explicitly listed,
not declared irrelevant. Semantic completeness stays unknown. Native targeting is
not deployed remotely. Independent parent review is still required before merge.
