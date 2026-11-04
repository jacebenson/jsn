# Batch manifests

`jsn batch` plans and applies one JSON manifest of related artifact
creates/updates. Steps have local names and can reference IDs produced by
earlier steps, so an agent or human does not have to copy `sys_id`s between
commands.

```bash
jsn batch plan  --file manifest.json    # read-only: targets, order, payloads
jsn batch apply --file manifest.json    # dependency-ordered writes
```

`--file -` reads the manifest from stdin. Output is the normal envelope
(`--json`, `--quiet`, `--get`, `--markdown`, `--csv` all work).

The engine is domain-neutral (`src/batch-engine.js`, `src/batch-manifest.js`);
artifact support comes from adapters (`src/batch-adapters/`). The first
delivered slice is **catalog items and catalog variables**.

## Manifest schema (version 1)

```json
{
  "version": 1,
  "description": "optional human note",
  "steps": [
    {
      "name": "laptop",
      "type": "catalog_item",
      "operation": "create",
      "fields": {
        "name": "Standard laptop",
        "short_description": "Managed laptop",
        "category": "Hardware"
      }
    },
    {
      "name": "cpu",
      "type": "catalog_variable",
      "operation": "create",
      "fields": {
        "cat_item": { "$ref": "steps.laptop.sys_id" },
        "label": "CPU",
        "type": "select",
        "mandatory": true
      }
    },
    {
      "name": "storage",
      "type": "catalog_variable",
      "operation": "create",
      "fields": {
        "cat_item": { "$ref": "steps.laptop.sys_id" },
        "label": "Storage",
        "order": 200
      }
    }
  ]
}
```

Top-level keys: `version` (must be `1`), `steps` (nonempty array), optional
`description`.

Step keys: `name`, `type`, `operation`, `fields`, `target`. Any other key is a
validation error — the schema is closed, not a passthrough.

- `name` — local identifier, `[A-Za-z][A-Za-z0-9_-]*`, unique in the manifest.
  References use this name, not a sys_id.
- `type` — a supported artifact type. Unknown types fail validation and list
  the supported types. There is no generic "table write" fallback.
- `operation` — `create` or `update`.
- `fields` — adapter-declared fields only. Unknown fields fail; they are not
  forwarded to the Table API.
- `target` — required for `update`, forbidden for `create`. Create never
  guesses an existing record by name.

### Update targets

```json
"target": { "sys_id": "0123456789abcdef0123456789abcdef" }
"target": { "identifier": "Standard laptop", "matchField": "name" }
"target": { "identifier": "cpu", "matchField": "name", "scope": { "cat_item": "0123...cdef" } }
```

Targets are resolved **before the first write**. Matching is exact only (no
partial sys_id, no display-name fuzz). Zero matches is `not_found`; multiple
matches is `ambiguous`, and the whole batch stops before writing. `scope`
restricts an identifier lookup to adapter-declared parent fields and accepts
literal strings only — generated IDs belong in `fields`, not in target
selection.

## Reference syntax

A reference is exactly one object with one key:

```json
{ "$ref": "steps.<step-name>.<output>" }
```

- Only outputs declared by the referenced step's adapter are addressable
  (`sys_id` today).
- References must point at another step in the same manifest. Unknown steps,
  unknown outputs, self-references and cycles are rejected **before any write**.
- References are only allowed for fields whose adapter spec allows them
  (currently `catalog_variable.cat_item`).
- There is **no** string interpolation, no `${...}`, no `{{...}}`, no script
  evaluation and no expression language. A string containing `${` or `{{` is a
  validation error rather than a silent literal.
- Dependency order comes from references. Independent steps keep manifest
  declaration order.

## Supported artifact types (first slice)

### `catalog_item` (`sc_cat_item`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | required on create |
| `short_description` | string | defaults to `""` on create |
| `active` | boolean | defaults to `true` on create |
| `category` | string | existing `sc_category.title`, exact; never created implicitly |
| `category_sys_id` | string | existing category sys_id; mutually exclusive with `category` |

Creates always set `type: "item"` and never create categories. Updates only
send the fields you provide.

### `catalog_variable` (`item_option_new`)

| Field | Type | Notes |
|---|---|---|
| `cat_item` | string ref → `catalog_item` | required on create; create-only |
| `name` | string | create-only; derived from `label` when omitted |
| `label` | string | required on create; becomes `question_text` |
| `type` | string | documented alias or numeric `item_option_new.type`; default `string`; unknown aliases fail |
| `mandatory` | boolean | defaults to `false` |
| `order` | integer | defaults to `100` |
| `active` | boolean | defaults to `true` on create |

Use `target.scope.cat_item` when updating a variable by name, because variable
names are only unique within their catalog item.

## Plan

`jsn batch plan`:

- validates the schema, types, references and dependency graph;
- resolves every update target (reads only);
- shows dependency order, create/update counts, intended scope/update set, the
  payload each step would send, and references still pending from earlier
  steps;
- **performs zero writes**, and is allowed on read-only profiles.

## Apply

`jsn batch apply`:

1. validates the manifest and resolves all update targets before the first
   write, so an invalid manifest or ambiguous target cannot leave a
   half-applied batch;
2. applies steps in dependency order through the adapter's domain operation
   (not generic unconstrained table writes);
3. reports each step as `created`, `updated`, `failed` or `skipped`, with the
   resolved `sys_id`;
4. skips only the dependents of a failed step; independent steps still run;
5. re-checks the mutation safety rules **before every step**.

A failed/skipped step makes the result `"partial": true` and the command exits
`1`; the structured result is still emitted (`ok: true` with the batch data).
Validation failures exit `2` and make no requests.

### Not atomic, no rollback, no automatic retry

A batch is not a ServiceNow transaction. Successful steps stay in place. The
result includes `recovery` guidance:

- inspect failed steps on the instance before retrying;
- use the reported `sys_id`s to reconcile successful steps;
- convert completed `create` steps into `update` steps (or remove them) before
  re-running, so a retry cannot recreate them;
- skipped steps made no change; retry them only after their dependency
  succeeds.

Manifests are **not idempotent**. Re-running the same create manifest creates
new records; that is intentional and documented rather than guessed. Safe
resume (a persisted checkpoint) is not implemented.

## Safety

- `batch apply` is a declared mutation (`mutationSubcommands: ['apply']` in
  `src/capabilities.js`): it requires an instance and is blocked on read-only
  profiles by the shared middleware.
- Capture-context approval applies at the command level (Global + Default needs
  explicit approval or `--force`).
- Before each step the engine re-checks the profile's read-only state and
  re-reads the capture context. If the context becomes blocked — completed
  update set, or Global + Default without approval — the batch **stops before
  that step**; completed steps are reported and the rest are `skipped` with
  `stopped.code`. A changed but still-writable context is recorded in
  `context_changes` and does not block.
- No new confirmation prompt is invented beyond the existing mutation and
  capture-context safeguards; a manifest does not bypass them.

## Explicitly unsupported (fails loudly)

- Any `type` other than `catalog_item` / `catalog_variable`.
- Catalog UI policies/actions, catalog client scripts, catalogs/categories as
  created artifacts, variable sets.
- Deletes, arbitrary script steps, cross-instance deployment, rollback.
- YAML manifests (JSON only in this version).
- String templates or any expression evaluation.
- Generic table writes for artifact types that have no adapter.

These are rejected at validation with a message naming what is supported; they
are not silently approximated.
