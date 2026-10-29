# Related-list counts and lazy navigation

Specialized record `show` commands can opt into supplementary related-list
counts with `--related`; `--view <name>` selects metadata for a custom view.
Ordinary specialized shows and generic `records get` retain their existing
presentation and request pattern. The specialized-command integration calls
`enrichRelatedLists`; the metadata/count modules themselves do not change generic
record reads.

The hook adds `_related` to the record. It contains every considered list with
its observed count or explicit unavailable state, a `nonempty` list with actionable
`records list` commands, and coverage warnings. Nonempty hints carry the resolved
parent ID, the relationship filter, and the selected profile/instance so opening
them cannot silently switch connections. Related records are fetched only when
the user follows a suggested command. Zero-count lists have no navigation hint.

Counts use the official
[Aggregate API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AggregateAPI.html)
with `sysparm_count=true` and an exact parent reference query. Independent counts
use optional SDK batch reads when available; that transport owns unsupported-endpoint
fallback. Denied, unserviced, missing, failed, or malformed responses remain
`count: null` with `status: unavailable`, not zero. No count fallback fetches full
record lists. Returned numeric zero is an actual observed aggregate result.

Coverage is scoped to `aggregate_api_access`, not a promise that the count includes
all records or matches every Table API visibility rule. Table/record permissions
can prevent aggregate access. Metadata ACL gaps and count errors are preserved as
partial coverage; a list absent from metadata is not evidence that no relationship
exists.

Safe ordinary reference relationships, including inherited references, can be
counted. A configured filter hidden by metadata access makes that list unavailable;
an explicitly empty visible filter remains valid. Only a conservative AND-only literal subset of configured filters is
combined with the resolved parent reference. OR/NQ branches, JavaScript/dynamic
logic, unknown operators and malformed filters are unavailable rather than risk
widening the query. Custom/advanced relationships requiring platform scripts are
never executed. Ignoring an unsafe filter would give an incorrect count, so those
lists receive no aggregate request or navigation command.

`createRelatedListReader(sdk, { metadataReader, maxLists: 50 })` exposes `read` and
`clear`. Aggregate URLs are deduplicated and cached within this SDK-bound reader;
repeated views may share counts, while changed records use distinct queries.
Connection changes replace the app's reader. The default 50-descriptor limit
bounds work, and skipped descriptors stay explicit unavailable entries with safe
list-specific navigation commands. `--related-limit` explicitly raises/lowers this
limit (1–1000). Individual aggregate reads run with at most four concurrent calls;
batch chunking remains bounded by the SDK. Metadata
is cached by the metadata reader; no cache is persisted across invocations.

This module depends on dynamic metadata (#317). Specialized factory/ticket hooks
are integrated alongside command-profile work; generic get is intentionally outside
this feature. `_related` is supplementary data; essential children use their
separate `_essential` contract.
