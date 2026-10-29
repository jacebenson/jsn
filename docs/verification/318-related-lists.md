# Related-list counts: connected PDI proof

Executed 2026-10-29 at 04:33 UTC from the related-list implementation stacked on
metadata commit `e405d1b`. The verify doctor first reported `ok: true`,
`authenticated: true`, `verified: true`, and `probe_status: succeeded` for `pdi`.
No credential contents, private records, usernames, or hostnames are retained here.

Exact commands:

```sh
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi
node docs/verification/related-lists-live-read.mjs pdi
```

The reproducible read-only script uses the checkout's SDK and metadata/count
modules. It disables credential refresh, authentication recovery and UI-session
warming; it uses existing scoped credentials directly. The target is safe table
metadata: the single `sys_db_object` definition matching `name=incident`, with
only its ID retrieved internally for relationship queries. IDs and record bodies
are omitted from output.

The smoke explicitly limits metadata reads to 100 rows per query and related-list
count work to the first **5 descriptors**. Observed result:

| Check | Observation |
| --- | --- |
| Target metadata matches | 1 |
| Descriptors returned by metadata | 59 |
| Aggregate requests sent | 1 |
| Aggregate HTTP status | 200 |
| Observed count | 48 |
| Available list counts | 1 |
| Unavailable/capped descriptors | 58 |
| Nonempty navigation hints | 1 |
| Coverage | Partial |
| Related record body fetches | 0 |

The partial result is intentional: unsupported relationships and the smoke's
explicit descriptor cap remain unavailable rather than becoming zero. It does
not claim every related list was counted. Counts are observations under Aggregate
API permissions, not a claim of universal Table API visibility.

This checkout did not yet include optional SDK batch transport, so this smoke
proves the ordinary aggregate-read lane. Native batch transport was independently
proven against this PDI in PR #339. Unit/HTTP fixtures cover batch partial failures,
ACL denial, malformed responses, exact parent/filter queries, zero counts, caching,
connection changes, 50-descriptor default fanout and four-request concurrency.

The [sanitized JSON transcript](related-lists-live-result.json) records only
statuses and counts. No record mutation or credential renewal occurred in this
run. Specialized CLI hooks are integrated separately after the metadata/count
modules; generic `records get` remains unchanged.
