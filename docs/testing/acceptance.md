# Acceptance suite

Linux-first executable acceptance around the real CLI, with Node's built-in tests and the existing Python PTY technique. No new framework, dependency, live CI credentials, release publication or website deployment is included. `npm test` stays offline; none of these scripts enables `JSN_INTEGRATION_TESTS`.

## Commands and working directory

From the **repository root**:

```sh
npm run test:acceptance -- --help
npm run test:acceptance:offline
npm run test:acceptance -- --mode readonly --profile demo --expected-host example.service-now.com --preflight --output-dir /private/new-run
```

From **cli/** the same script names work directly. Root scripts forward to `cli/` and preserve argument separators. Each run needs a new private output directory; an existing ownership manifest is never overwritten. `--help` is local and needs no profile. `--preflight` validates target, modules, dependencies and coverage without authentication or scenario/performance execution; its exit is 2, not a zero-check pass.

After independent safety review, an operator can omit `--preflight` for the read-only lane. PDI writes require **both** `--mode pdi` and `--allow-writes`, explicit `--profile` and `--expected-host`. Live PDI mutation acceptance is still held pending graph/capture cleanup review. Flow/catalog live mutations are specifically blocked pending the separate production `flows delete` change, its live verification and complete graph ownership. Do not enable retained-flow state as a live workaround.

## Target, environment and operation boundaries

Target mismatch, unknown profiles/arguments and ambient target/runtime/proxy redirects fail before authentication. Every subprocess receives the selected profile and exact instance origin; per-command target overrides are refused. Command flags are checked against their actual canonical registration in `coverage.json`. Read-only dispatch permits the five original local/metadata scenarios, selected-profile auth status, suite perf commands and **only** the explicit paths in `read-only-catalog.mjs`. Requests/tables show are not authorized by that catalog. Arbitrary REST, Store, unknown verbs and mutation-shaped/executable GET queries are refused. PDI REST is restricted to exact effective context-picker reads. Ordinary selected-profile OAuth/session bootstrap and refresh remain possible; those are not instance-record mutation claims.

Child environments use a minimal OS/config/session-bus allowlist, not the full ambient environment. Unrelated provider/deployment/peer secrets are not inherited. The primary actor uses its existing selected-profile on-disk/keyring authentication; the runner does not copy credentials or personal defaults. Generated actors use confined HOME/config/cache/data paths, exact target/profile configuration, empty run-owned PATH and a disabled session bus. Config-file and directory symlink escapes, unclassified config fields and arbitrary environment overrides are refused. Credentials are child-only, never argv or public fields.

`--cli-path /path/to/package/bin/jsn.js` accepts an external artifact only when its complete regular-file `src/` and `bin/` SHA-256 maps and package identity/dependency declarations match this checkout exactly. Extra/missing/changed files and source symlinks fail closed. A claimed revision string or binary wrapper hash is not sufficient. Dependencies/runtime/live behavior must still be exercised independently on the packed artifact. CLI version comes from this checkout's package, not the process working directory.

## Implemented scenarios and honest coverage

The runner loads read-only, read-only-catalog, resource, workflow and auth modules: **92 real scenario callbacks** (71 read-only-compatible and 21 PDI-only). This is not 92 complete product capabilities. The catalog contributes bounded list/show sampling for 34 reviewed resource families, not every family, lifecycle, option or error mode. See the separate catalog, workflow and auth/performance documents.

`coverage.json` stays a pinned source/registration/baseline-test inventory. New acceptance tests do not invalidate baseline test hashes. Runtime `coverage-bindings.json` joins actual scenario IDs and explicit assertion bindings to canonical paths, starting as **implemented-not-run**. Only explicit outcome requirements and option assertion IDs are credited by the implementation-gap calculator. Option strings are canonical IDs into `optionDefinitions`; exercising an option once does not satisfy its omitted-default, boolean-negation, repeatability or other untested obligations. Generic factories, matching `commandPaths`, source references, help output and a successful exit never imply full coverage.

`coverage-gaps.json` includes both selected-mode and full-product gaps. Read-only excludes PDI-only obligations without presenting those exclusions as product passes. Store's seven paths stay excluded LIVE, not erased from offline requirements. Missing requirements/options/workflows remain incomplete. No live behavioral pass is recorded by merely binding an implemented callback.

Major/minor select the full suite. Patch selection accepts repeatable `--changed-file cli/src/...` plus prerequisite/dependent closure. Empty/unknown changes, shared SDK/auth/parser/output/factory/dependency changes and unresolved inventory impact broaden to full. `--full` forces full selection. An impact-only result is not full-product acceptance. Repeatable `--scenario EXACT_ID` selects an explicit bounded subset plus its prerequisites (not dependents), rejects unknown IDs and is always labeled not-full-product. For example, `--scenario resources.properties` selects only that lifecycle and `workflows.context`; it does not select auth users, native update-set transfer, or flow/catalog creation.

## Shared scenario contract

Modules export `scenarios` with `id`, `title`, `commandPaths`, repository-relative `sources`, `modes`, `mutates`, `requires`, `run(ctx)` and optional partial-setup-safe `cleanup(ctx)`.

- `ctx.command(args, {env, timeoutMs})` launches asynchronously and returns exit/stdout/stderr/parsed JSON/monotonic timing. Default bound is 30 seconds, maximum 120 seconds, output maximum 2 MiB. No automatic mutation retry.
- `ctx.read(table, {id, query, fields, limit})` performs an independent selected-profile SDK Table API GET in a child process. Default limit 1, maximum 10; `sys_dictionary` alone permits 500 projected metadata rows. Table/ID/field tokens and executable queries are checked.
- `ctx.registerArtifact({table,id,kind,dependsOn,cleanupArgs})` checkpoints exact identity, run key, profile, target and already-owned dependencies immediately. Delete argv must name the actual owned ID/table through a supported CLI delete command, not merely contain the ID as an unrelated argument.
- `ctx.state` is a per-run Map. Missing setup blocks dependents; blocked callbacks cannot become passes.

Auth fixtures depend on the owned capture context. Optional `--auth-config /private/auth-config.json` accepts only a bounded regular nonsymlink 0600 JSON file with exact `profile`, exact origin `expectedHost`, `roles` and optional observed `domain`. Unknown fields, mismatched targets and administrative roles fail before allocation. Domain/role IDs are independently read on the target; supplied configuration is not provider evidence. No browser/session adapter is fabricated.

## Evidence, performance and cleanup

Run directories are 0700; JSON receipts/manifests/reports and owned perf SQLite files are 0600. Receipts omit argv/environment but **raw stdout/stderr/provider bodies remain sensitive**. Never publish the directory. `public-summary.json` uses closed ID/status/version/hash/timing and perf collector/environment projections; no host/profile, private path, error text, credentials, raw metrics or captures. No automatic upload exists.

`beginSuite` runs before all scenarios; `endSuite` runs in `finally` after scenario execution, including failure and handled SIGINT/SIGTERM. Actual version-1 perf capture/show/list/compare schemas are checked. Before/after private captures survive failures/interruption; public performance is sanitized and observational, never a release threshold. Per-test durations use a monotonic clock. SIGKILL/power loss cannot run finally; manifests and completed receipts remain for manual recovery. Interrupted runs stay non-green and do not dispatch the remaining scenarios.

Cleanup independently reads exact ID absence before DELETE, making already-deleted/planned-absent IDs idempotent. Existing children are deleted while the owned capture set is still selected, with capture readback before deletion. Failure/unsupported cleanup propagates transitively to ancestors; it never produces a false cleaned flag. Original application/update-set context restores last **only after resolvable child cleanup**. Unresolved children keep their ancestors and selected capture context for explicit reconciliation.

The capture set itself is **always retained and marked dirty/incomplete**: provider-generated capture members and a safe capture-set deletion route have not been established. The runner never deletes the selected capture set or deletes artifacts after restoring into Default/personal work. When children are clean it restores the exact original context and retains the dirty set without further deletion. `--keep` performs no object deletion but still restores original user context; auth-generated credential/config/header files are removed and password/session memory references cleared even with `--keep`. Remaining accounts/objects are not mislabeled cleaned. There is no broad sweep, automatic old-manifest import or automatic recovery CLI.

Exit 0 requires a nonempty fully bound selected scope, passing outcomes and resolved cleanup. Exit 1 denotes execution/assertion failure; exit 2 denotes incomplete/blocked/preflight evidence. Current full-product coverage remains incomplete, even when every offline regression passes. Browser/session acquisition/expiry, interactive live ownership, full flow/catalog graph cleanup, provider schemas/ACLs and results-site integration remain explicit work.
