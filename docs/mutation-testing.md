# Mutation testing

Run `npm run test:mutation` from the repository root after `npm ci`.
StrykerJS 10 and its Babel dependencies require Node 22.18+ on the Node 22 line or Node 24.11+. This is a development-tool requirement, not a change to jsn's runtime support.

The default mutates only `src/mutations.js`, the classifier used by the read-only-profile guard. It runs these existing offline tests with Node's test runner:

- `test/mutations.test.js`
- `test/usability-safety-group-mutations.test.js`

The second file also exercises the real CLI with disposable configuration and fake instance addresses. The command does not select live integration tests. No ServiceNow credentials are needed.

Stryker uses its built-in command runner. Each mutant reruns the selected tests, including CLI subprocesses. Coverage analysis is off because this runner cannot provide per-test coverage. Keep the selection small instead of running the full suite for every mutant.

Open `reports/mutation/mutation.html` to inspect changed expressions and survivors. Machine-readable results are in `reports/mutation/mutation.json`. Generated reports and sandbox files are ignored by Git. Reports stay local; no dashboard upload is configured.

This is opt-in, not a CI gate. The break threshold is zero until there is an agreed baseline. Review survivors for meaningful missing behavior before adding tests; equivalent mutations and initialization overwritten before use can survive without exposing a defect. Timeouts count as detected mutations in Stryker's score, so report killed, timed-out, and surviving counts separately.

To expand scope, pair one additional source module with its relevant offline tests in `stryker.config.json` and measure runtime. Overriding only `--mutate` does not expand the selected tests and can give misleading results.
