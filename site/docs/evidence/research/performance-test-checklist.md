# JSN performance test and logging checklist

Research basis: ServiceNow Performance Resource Page KB0829067 and its 34 linked KB articles.

This version is mapped to JSN, not the MCP server. Test in a disposable or sub-production instance unless a production change window explicitly allows it.

## Existing JSN commands

Run these from the JSN repository root (the CLI entry is `cli/bin/jsn.js`):

```bash
node cli/bin/jsn.js platform health --all-nodes --json
node cli/bin/jsn.js transactions --query 'sys_created_on>=javascript:gs.daysAgoStart(1)' --json
node cli/bin/jsn.js logs list --query 'level=error' --columns 'level,message,source,sys_created_on,sys_id' --limit 50 --json
node cli/bin/jsn.js logs follow --level error --tail 50 --interval 2000
node cli/bin/jsn.js flows executions --since '<start>' --until '<end>' --summary --json
node cli/bin/jsn.js records list --table syslog_transaction --query '<encoded query>' --columns 'sys_id,type,response_time,sys_created_on' --limit 50 --json
node cli/bin/jsn.js records aggregate --table sysevent --query '<encoded query>' --group-by queue --count --json
node cli/bin/jsn.js eval --file ./read-only-probe.js --json
```

Use the installed binary instead of `node cli/bin/jsn.js` when appropriate. The two forms exercise the same CLI.

## Test matrix

| ID | Test | JSN command or method | Evidence |
|---|---|---|---|
| P-01 | Baseline platform health | `jsn platform health --all-nodes --json` | Node status/type, queue length/age, active sessions, semaphore usage, memory pressure, daily transaction stats, timestamp. |
| P-02 | Transaction summary | `jsn transactions --query '<bounded query>' --json` | Counts and average/min/max response time by transaction type. JSN groups `syslog_transaction` by type. |
| P-03 | Error and warning baseline | `jsn logs list --query 'level=error^ORlevel=warning' --limit 100 --json` | Complete output, query, timestamp, level, source, message, sys_id. |
| P-04 | Live error monitoring | `jsn logs follow --level error --tail 50 --interval 2000` | Errors generated during the test. Stop with Ctrl-C. Use `--source` or `--query` to narrow it. |
| P-05 | Slow transaction detail | `jsn records list --table syslog_transaction --query '<time and response filters>' --columns '<timing fields>' --limit 50 --json` | Response time, processing start, SQL/ACL/script timing if ACLs expose those fields, user, URL, node, transaction number. Keep the time range bounded. |
| P-06 | Transaction-log coverage | Compare `jsn transactions` and `jsn records list` results with node logs and cancelled-transaction data. | Evidence that an empty `syslog_transaction` result does not mean no transaction occurred. Include node, session, transaction number, and txid where available. |
| P-07 | Node diagnostics | `jsn platform health --all-nodes --json` | JSN already parses cluster node stats XML, including queue, queue age, active sessions, memory pressure, semaphores, and daily transaction metrics. It does not retrieve `threads.do`. |
| P-08 | ATF repeatability | `jsn atf run-suite '<suite>' --wait --timeout 300 --force` followed by `jsn atf results <id>` when scheduled without waiting. | Suite identity, route used, status, counts, progress/result IDs, start/end or runtime. Repeat with fixed data and environment. |
| P-09 | ATF performance profiling | Check the target instance's ATF performance profile/report separately. | JSN can run and poll ATF, but current `jsn atf run` and `run-suite` do not expose the MCP's `is_performance_run` option or raw ATF performance samples. Add support only if the official API/report shape is verified. |
| P-10 | Concurrent load | Use an approved external load generator. Use JSN commands for health/log snapshots before, during, and after. | User count, ramp, steady-state duration, throughput, p50/p95/p99, HTTP errors, timeouts, retries, payload sizes, and JSN health/transaction snapshots. JSN does not generate load. |
| P-11 | Server-side query bounds | Write a read-only script and run `jsn eval --file ./probe.js --json`. Compare `setLimit(1)` with unbounded existence checks and `GlideAggregate COUNT` with `getRowCount()`. | Exact script, elapsed milliseconds, result count, output size, transaction record, and log evidence. Keep the script read-only and bounded. |
| P-12 | Invalid query safety | Use `jsn records list` against a tiny disposable table or a carefully limited `jsn eval` probe. Check `glide.invalid_query.returns_no_rows`. | Effective property, result count, elapsed time, and warnings. Never provoke an unbounded invalid query on a large table or production. |
| P-13 | CMDB OR versus INSTANCEOF | `jsn records list --table cmdb_ci` or `jsn records aggregate --table cmdb_ci`, comparing equivalent encoded queries. | Matching counts and sampled sys_ids, request timing, query text, and slow-query evidence. JSN cannot expose the database execution plan. |
| P-14 | Index Suggestion Engine | Use the ServiceNow UI/ISE workflow. Use JSN to preserve query records and before/after evidence where permitted. | Slow query, suggested columns, statistics state, before/after timings, evaluation status. JSN has no ISE or index-management command. |
| P-15 | Database execution plan | Self-hosted MySQL only, through the approved database/support workflow. | `EXPLAIN`, selected index, examined rows, result equivalence, repeated timings. Do not use `jsn eval` to bypass database restrictions. |
| P-16 | Row count and payload | Read `sys_user_preference` and relevant properties with `jsn records list`. In sub-production, compare approved page sizes such as 20 and 50. | Effective preference/property, browser request/paint time, payload size, transaction timing. JSN measures configuration, not browser paint. |
| P-17 | Homepage/dashboard rendering | Use a browser harness. Use JSN to inspect widget/configuration records and properties. | First-content/interactive time, widget requests, below-fold behavior, inactive-tab behavior, per-widget server timing. |
| P-18 | Related-list loading | Read `glide.ui.defer_related_lists` with `jsn records list --table sys_properties`. Change only through an approved non-production test. | Form timing, related-list request timing, default/deferred/on-demand behavior, before/after property values. |
| P-19 | Service Portal widget timing | Use the documented browser-console method and inspect `_server_time`. | Widget identity, server time, browser/network timing, console capture. JSN has no browser instrumentation. |
| P-20 | Event queue backlog | `jsn records aggregate --table sysevent --query '<bounded query>' --group-by queue --count --json`; use `jsn eval` only when aggregation fields need custom logic. | Queue depth, oldest event age, created/processed rate, event name/table, `text_index` activity, representative `parm1` and instance. JSN has no dedicated event-queue command yet. |
| P-21 | Dedicated event processor | Inspect registry and scheduled-job records with `jsn records list`. Do not create or alter processor jobs automatically. | Queue routing, job context, queue depth/rate before and after, processed events, capacity impact. |
| P-22 | MID/ECC integration timing | Query permitted `ecc_queue` records with `jsn records list` or `jsn records aggregate`; correlate with external integration logs. | Request/correlation ID, enqueue/pickup/completion/return times, MID/agent, topic, state, timeout, retry, error boundary. No dedicated JSN integration-latency command exists. |
| P-23 | Network baseline | Run DNS, HTTPS/443 connectivity, traceroute, and repeated latency checks from the relevant client, MID host, or integration boundary. | Public source IP, resolver results, repeated samples/average, proxy/VPN/DNSSEC state, route output, exact test times. Outside JSN. |
| P-24 | Cache-flush correlation | Query `diagnostic_event`, `sys_cache_flush`, and `syslog` with `jsn records list` and `jsn logs list`. | Flush event/time/node, cache-build time, SQL time, response spike, configuration/update/plugin trigger. Do not flush cache as a casual test. |
| P-25 | Scheduled-job and cleanup interference | `jsn platform health --all-nodes --json`; inspect `sys_trigger`, `sysauto_script`, and cleanup records with `jsn records list`. | Job state, claimed node, DMScheduler/Table Cleaner activity, table/age/condition, start/end, overlap with test window. |
| P-26 | Evidence drain period | Repeat platform, transaction, logs, event, and integration checks after the load stops. | Time until queues drain, remaining errors/backlog, final health snapshot, configuration changes, restarts, and test contamination. |
| P-27 | Browser validity | Record browser/version/OS outside JSN. Do not compare Internet Explorer 11 results with modern browser baselines. | Browser, version, OS, client identity, network path. |
| P-28 | Evidence retention | Export JSON with `--json`; preserve command arguments, raw output, timestamps, scripts, screenshots, and hashes. | A timestamped evidence bundle. Export promptly because documented retention is about 8 weeks for `syslog` and 1 week for `sysevent`. |

## Capture provenance

Every run records:

- JSN version, identifying the CLI that produced the run
- Capture schema version, identifying how stored data should be read
- Profile and instance identity
- Capture command and options
- Start and finish timestamps

Do not record or require a Git commit. Captures must work the same way from a checkout, a package, or any other installation source.

## Comparison policy

Comparisons must not treat missing metrics as zero. A missing value means the collector did not produce a usable result, not that the measured value was zero.

If a metric is missing from one side, show the metric as unavailable and identify the side:

```text
Unavailable: missing from baseline
Unavailable: missing from new result
```

The comparison should still include metrics available in both runs, but mark the overall result as `incomplete`. It should also preserve the collector status and reason, such as unsupported endpoint, permission denied, timeout, query failure, or empty source data.

Do not calculate a delta, percentage change, pass/fail result, or ranking for a metric that is missing from either run. Do not let an incomplete comparison look like a clean benchmark.

In v1, `perf compare` accepts exactly two explicit run IDs:

```bash
jsn perf compare RUN_A RUN_B
```

Time-range comparisons and aggregate trend analysis are out of scope for v1. They can be added later as a separate feature with explicit rules for uneven intervals, missing runs, outliers, and baseline selection.

## Run identity

Each capture gets an automatic timestamp-based run ID. Users may add an optional label for human context, such as `before-index-change`.

There is no campaign, collection, or grouping concept. Runs remain independent records and can be compared by passing two run IDs to `perf compare`.

## Log storage policy

Treat each log source as a separate collector. At minimum, distinguish:

- ServiceNow `syslog`
- Application logs
- Per-node logs

The normal performance capture should collect log summaries, not dump entire log tables into the local database. For each source, preserve the bounded query and time window, total count, counts grouped by source, level or severity when available, and the collector status.

The performance capture never downloads or stores log content. This is a deliberate security and regulatory boundary. It stores summaries only, including counts grouped by source and severity.

Do not retrieve or persist multi-gigabyte per-node logs. Whether ServiceNow exposes usable node-log summaries still needs verification. Until that is verified, the node-log collector should report unsupported or unavailable and continue without downloading node-log content.

## Report output

Human-readable styled terminal output is the default. Machine-readable output uses `--json` and a stable schema. JSON must contain run metadata, collector status, metric values, missing-data reasons, and truncation or availability flags without colors, spinners, or prose.

Do not add CSV output in v1. CSV flattens nested evidence and cannot represent collector status and missing-data reasons cleanly.

## JSN strengths

JSN already covers the most useful first diagnostic layer:

- `platform health` parses node statistics instead of returning raw XML.
- `transactions` provides count and response-time summaries by transaction type.
- `logs list` supports bounded queries, selected columns, and JSON output.
- `logs follow` provides real-time syslog tailing with level, source, query, tail, and polling controls.
- `records list` provides the generic escape hatch for `syslog_transaction`, `sysevent`, `ecc_queue`, properties, preferences, and diagnostic tables.
- `records aggregate` provides count/grouping measurements without returning every record.
- `flows executions --summary` reports server totals and sampled duration metrics.
- `eval` can run controlled server-side probes, but it is the last resort and must remain read-only for performance measurement.

## JSN gaps worth building

1. Add a first-class `transactions detail` mode for timing decomposition, node, session, transaction number, and txid.
2. Add `events` or `event-queue` commands for queue depth, oldest age, created/processed rate, and bounded samples.
3. Add `ecc` or `integrations` commands for MID/ECC correlation and latency.
4. Add a `platform threads` command for authorized `threads.do` snapshots.
5. Add ATF performance-profile support that preserves raw samples, warm-up behavior, and percentiles instead of only normal run results.
6. Add a repeat/percentile helper for externally supplied timing samples.
7. Add an evidence-bundle command that stores raw JSON, command arguments, timestamps, and redacted outputs.

Do not add automatic load generation, cache flushing, index creation, property changes, transaction killing, or heap-dump collection to JSN without separate operational controls. Those are broad-impact actions, not ordinary diagnostic reads.

## Sources

- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0829067
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0584420
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0750152
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0721202
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0676909
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0547347
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0724183
- https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0780216
- https://www.servicenow.com/community/developer-articles/performance-best-practices-for-server-side-coding-in-servicenow/ta-p/2324426
- https://www.servicenow.com/docs/r/application-development/automated-test-framework-atf/atf-perf-prof.html
