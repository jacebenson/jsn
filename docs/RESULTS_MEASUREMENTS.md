# Results and bounded task measurements

The public history keeps failures, blocked work, and missing historical metadata.
Selected-task verdicts do not use static product completeness. Cleanup is a separate
reported state; missing history is unknown. Server receipt proves storage only:
there is no runner readback acknowledgement in this slice. No historical record is
rewritten and no database migration is needed.

## Reproduce the six-task fixture contract

```sh
npm --prefix cli ci
node cli/scripts/task-measurements.mjs /path/to/evidence
node --test cli/test/task-report.test.js
```

Catalog: `/benchmarks/bounded-reads-v1.json`, source-controlled under
`site/static/benchmarks/`. It defines five bounded flat reads and a documentation
section desired outcome, reusing #491's exact row/field/subtree verifiers and
instrumented GET-only loopback servers. The runner exercises the existing 33-case
baseline (99 fresh processes), then publishes only the six selected JSON tasks
(18 samples). These are offline fixture measurements, not 71 acceptance scenarios,
live ACL proof, human output measurements, or a cross-SDK ranking.

`tasks.json` contains taskset version, SHA256 of exact catalog bytes, fixture SHA,
source revision/dirty status, tested package version separate from harness source,
Node/process/cache dimensions and each sample's measured end-to-end milliseconds,
UTF-8 stdout and stderr bytes separately, rows and measured server request count.
Token counts, tokenizer provider and encoding are explicitly unavailable/null;
no characters/4 estimate. Agent-generated tokens and cost are not collected.
Live target family/build are null, not copied from fixture document release.
Machine JSON is named explicitly. The closed report omits raw responses, command
arguments, cleanup identifiers, provider URLs and credentials. Existing private
acceptance evidence remains unchanged.

## Optional acceptance projection context

Existing schema 1/2 projections remain accepted. New producers may include this
closed optional root object (the existing workflow is intentionally not edited):

```json
{"measurementContext":{"tasksetVersion":"acceptance-v1","suiteSHA256":"<64 lowercase hex>","environmentLabel":"linux-ci","environmentSHA256":"<64 lowercase hex>","cleanupState":"unknown"}}
```

Allowed tasksets: `acceptance-v1`, `bounded-reads-v1`; environment labels:
`offline-fixture`, `linux-ci`, `linux-local`; cleanup states: `unknown`, `passed`,
`failed`, `not-required`. Producers must hash the actual suite sources and assign
labels only from captured provenance, never infer them from passing checks. The
environment SHA256 must identify the actual sanitized runtime configuration and
machine class; a coarse label alone cannot establish comparable environments.
Do not hash credentials, usernames or private provider URLs into this public key.
This is metadata for comparisons, not an adapter importing bounded tasks into the
acceptance scenario allowlist. No unsupported platform task IDs are admitted.

Timing history compares only successful nonzero clean-source runs in the latest
exact cohort: suite hash, taskset version, sorted check IDs, mode, target label,
environment label and fingerprint, platform, Node, domain separation, harness source, and target
family/build/version/patch/hotfix where captured. Missing live family/build makes
runs non-comparable. Null patch/hotfix remain unknown, not asserted equivalent.
An environment label is coarse: measurements remain observational, not causal
hardware-controlled speed claims. Failed, blocked, zero-execution and unknown
historical runs are visible but excluded from timing bars; there is no leaderboard.

The tested package revision/version stays visible separately; it is not part of
the cohort so future package changes can be observed under the same harness.
No global one-score ranking, SDK adapter, real tokenizer, live provider request
hook, deployment, or CI publication acknowledgement is implemented here.
