# Bounded CLI regression baseline

Run from the repository root after `npm --prefix cli ci`:

```sh
node cli/scripts/bounded-baseline.mjs --output /path/to/evidence
# Optional repetitions, minimum 3, default 5
node cli/scripts/bounded-baseline.mjs --repetitions 5 --output /path/to/evidence
node --test cli/test/bounded-baseline.test.js
```

The script exits nonzero on content, request-count or byte-ceiling regression. It writes `results.json` with every command and sample, and `REPORT.md` with per-case medians, nearest-rank p95, row counts, stdout/stderr bytes and count overhead. It never uses a live instance. CLI processes use an allowlisted isolated environment and injected fixture auth. A GET-only transport routes the stable `fixture.example.test` identity to loopback. No real credentials, production dependencies, workflow changes or instance mutations are needed.

## What is measured

Each sample is a fresh Node CLI subprocess timed with `performance.now()`. It includes process startup, fixture auth, HTTP, parsing, formatting, output capture and exit. It is not backend latency. The local HTTP service stays warm, OS caches are uncontrolled, and there is no warm-process measurement. Five repetitions are a modest diagnostic default; p95 is descriptive and at this sample size is the maximum, not a service-level claim. Timing has no pass/fail threshold.

The source fixture contains two flat string-valued rows per table. The first includes Unicode, quotes, commas, tabs, line breaks and literal escapes. JSON, CSV and TSV must decode to the exact same selected rows and fields. Raw references preserve IDs. Display/both reference modes can flatten labels into CSV/TSV and are not claimed lossless equivalents. Existing output tests cover those semantics separately.

The five tables and fields were taken from the earlier bounded five-read profile, not invented as Steve's exact workloads:

| Table | Selected fields |
|---|---|
| sys_properties | sys_id,name,sys_scope,type |
| sys_script_include | sys_id,name,sys_scope,active |
| sys_security_acl | sys_id,name,sys_scope,operation,type |
| sys_scope_privilege | sys_id,source_scope,target_scope,target_name,operation,status |
| sys_flow_context | sys_id,name,state,sys_created_on |

Scoped queries use a fixture scope. Flows use a fixed time window and are not attributed to that scope. Every read explicitly limits to 2 with offset 0 and ORDERBYsys_id. This is a representative correctness fixture, not a volume or accessibility claim for these tables on any live instance. The existing CLI may repeat sys_id in the HTTP projection; the assertion checks the exact ordered distinct selected fields, not that incidental duplication.

Each table runs three formats with and without counts. The fixture returns 2 of 7 matching records. No-count must make one Table API GET. Count must make exactly two GETs, adding the stats API, and CSV/TSV must keep pagination notices on stderr. Count overhead is the difference of unpaired JSON medians, not an isolated server cost.

Documentation uses the existing local documentation server with a pinned SQLite document, revision `bounded-fixture-v1`, release `australia`. Full body, outline titles and selected subtree with ancestor introduction are checked against fixture expectations. JSON must not contain `_formatted` duplication. Outline/section must report service selection, no full document transferred, no truncation and unknown semantic completeness. A complete subtree is not necessarily a complete answer; sibling and linked prerequisites may still matter. This tests offline service selection, not hosted-provider availability or old-service fallback, which has existing dedicated tests.

## Byte baseline policy

`cli/test/fixtures/bounded-baseline/bytes.json` records maximum observed UTF-8 stdout and stderr bytes from at least three real fresh CLI runs for the pinned fixture. They are exact fixture-specific ceilings with no padding, not universal output limits. Response-envelope growth, duplicate presentation or unexpected diagnostics require review. Sizes are unmodified captured output, not wire bytes, JavaScript character counts or estimated tokens. No existing tokenizer is installed as a project dependency, so token counts are explicitly unavailable.

To deliberately accept an explained fixture/output change:

```sh
node cli/scripts/bounded-baseline.mjs --record-baseline --output /path/to/rebaseline-evidence
node cli/scripts/bounded-baseline.mjs --output /path/to/checked-evidence
```

Recording never claims a checked pass. Review the fixture SHA and byte diff before committing. The test lowers one ceiling by one byte, verifies rejection, restores the baseline and verifies acceptance using actual measured outputs. It also checks that targeted docs output is smaller than full output.

## Pending live integration

No live command or vendor trend is delivered in this slice. Integration with PR490's environment/credential delivery remains pending. Do not add a competing workflow or pass credentials as command arguments. A future explicit manual read-only mode should accept a vendor label and existing isolated credential-provider/environment inputs for vendor1 and vendor2, refuse non-GET requests, use identical bounded projections/window/format/count modes, and publish only safe aggregate measurements and source/version identifiers. Keep ACL-denied or unavailable tables distinct from empty success and do not claim equivalent datasets across vendors. Collect repetitions and cold/warm dimensions separately for each vendor; live timing remains measurement-only. No tokens, property values, response bodies or credentials belong in published live evidence.
