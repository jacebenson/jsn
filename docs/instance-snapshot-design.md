# Instance snapshot and flow search

Status: parked design, not part of `jsn perf` v1.

## Problem

ServiceNow code search does not make Flow Designer definitions easy to search. Flow definitions can contain useful logic in encoded or Base64 payloads, while the normal code-search experience does not expose the readable flow steps, conditions, variables, and action inputs.

A user should be able to search the local JSN knowledge base for flow logic without repeatedly querying every flow on the instance.

## Proposed user experience

Keep this behind the existing code-search workflow rather than creating a separate top-level search product.

```bash
jsn codesearch "approval"
```

If the local instance snapshot does not contain flow content, JSN should say:

```text
No flow snapshot exists for this instance.

Would you like to capture the flows now?
This may make one request per flow and can take time.
```

The capture must be explicitly confirmed. It should never happen as a hidden side effect of a normal code search.

Possible explicit command:

```bash
jsn codesearch snapshot-flows
```

The exact command name is unresolved. The important behavior is that flow capture is an opt-in operation, similar to `jsn docs sync`.

## What to store

Store the readable JSN flow presentation, not the raw ServiceNow payload by default.

The stored document should contain:

- Instance URL and instance key
- Flow sys_id
- Flow name and scope
- Active state and version
- Snapshot timestamp
- Ordered trigger, action, logic, subflow, input, output, and variable sections
- Conditions and field mappings in the same readable form JSN displays to a user
- Source record identifiers needed to refresh the flow

Do not store credentials, full raw API responses, or unnecessary payload data.

The readable flow document should be searchable for:

- Action names
- Table names
- Field names
- Conditions
- Script references
- Flow variables
- Subflows
- Trigger types
- Text in comments and annotations

## Storage

Keep flow snapshots as a separate database from the docs and performance databases, but place all three under one shared, durable JSN data root.

The shared root should not be a cache directory. These databases and captured artifacts remain until the user deletes them.

Use a JSN-owned hidden directory as the shared data root. On Linux and macOS, that is `~/.jsn/`. Windows should use the equivalent user-local JSN directory.

Keep credentials and configuration in their existing configuration locations. The shared `.jsn` root is for databases and captured artifacts, not access tokens, cookies, or passwords.

Planned layout:

```text
~/.jsn/
  docs/docs.db
  perf/perf.db
  instance/instance.db
```

Move the existing docs database from the cache location into this shared durable root automatically. Do not require a separate migration command and do not re-run `docs sync` just to move a local database.

Migration behavior:

1. Resolve the new `.jsn` path.
2. If the new docs database exists, use it.
3. If it does not exist and the old cache database exists, move it locally.
4. Verify the destination before removing the old cache copy.
5. If migration fails, preserve the old copy and report the error.

A future instance-content database could contain:

```text
instance_snapshots
  id
  instance_key
  instance_url
  captured_at
  kind
  status
  metadata_json

flow_documents
  id
  snapshot_id
  flow_sys_id
  name
  scope
  version
  active
  content
  metadata_json

flow_search
  flow_document_id
  content_fts
```

The raw or rendered document should also be retained as an artifact so search-index changes do not require another instance capture.

## Refresh behavior

A snapshot is tied to an instance key and capture time.

```bash
jsn codesearch snapshot-flows --profile dev227772
jsn codesearch snapshot-flows --profile dev227772 --refresh
```

The capture should:

1. Resolve the instance and record the canonical URL.
2. List flows with bounded pagination.
3. Fetch each flow definition through the same source used by JSN's flow inspection.
4. Decode and hydrate the payload.
5. Render the readable flow presentation.
6. Store one document per flow.
7. Build or update the local search index.
8. Record successes, failures, skipped flows, and duration.

A failed flow must not invalidate the complete snapshot. The result should report partial status and identify failed flow IDs.

## Relationship to `jsn perf`

Do not add flow-document capture to `jsn perf capture`.

```text
jsn perf capture
  How the instance behaves over time

flow snapshot/search
  What the instance contains
```

They may eventually share low-level instance identity and artifact helpers, but they should have separate databases, commands, and retention rules. Their files can still live under the same JSN data root.

## Cost and safety

Flow capture is read-only but can be expensive because it may require one or more requests per flow and payload decoding on the client.

The capture should support:

- Progress output
- Bounded concurrency
- A request timeout
- A total time budget
- Resume after interruption
- Retry of failed flows
- `--limit` for a small test capture
- `--scope` or query filtering
- JSON and styled output

Example test capture:

```bash
jsn codesearch snapshot-flows --profile dev227772 --limit 10 --json
```

Do not automatically refresh snapshots during ordinary searches. Search must remain local and predictable once a snapshot exists.

## Open decisions

- What exact equivalent of `~/.jsn/` should JSN use on Windows?
- Whether to extend `jsn codesearch` or introduce `jsn instance snapshot` while keeping search as `jsn codesearch`.
- Whether the flow documents should share the existing docs FTS implementation without sharing the docs database.
- Whether non-flow ServiceNow content should eventually join the same instance snapshot.
- Whether the rendered flow format should be versioned so future display changes do not invalidate comparisons.
- How much flow metadata to retain when a flow is deleted or renamed on the instance.
