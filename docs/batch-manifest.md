# Batch manifests

`jsn batch` plans and applies related artifact creates, updates and deletes.
The shared engine is domain-neutral; adapters declare closed field schemas,
reference types, payload preparation and domain operations. Adding a family does
not require a domain-specific engine branch. Keep the `batch` name for continuity.

## Mandatory inspect-before-apply workflow

```sh
jsn batch plan --file manifest.json --profile demo --json > plan.json
# Inspect data.order, data.steps, data.counts and data.plan_id in plan.json.
jsn batch apply --file manifest.json --plan plan.json --profile demo --json
```

The second command writes; run it only with permission on a write-enabled
profile. `--plan` accepts the full JSON envelope or its `data` object. `--file -`
reads a manifest from stdin. Normal output envelopes and `--get` work.

Plan is GET-only and works on read-only profiles. Apply requires a receipt,
re-plans before the first write and compares the exact instance, manifest
summary, order, targets, prepared payloads, references, outputs and notes. A
changed manifest, target resolution, category resolution or instance requires a
new plan. The SHA-256 `plan_id` detects accidental receipt edits, not authorization
or provenance; it is not a signature, one-time token or replay lock. Plan cannot
predict server business-rule side effects or guarantee that ACLs allow a write.

Apply uses only the predicted payload, substituting declared generated outputs;
it never allocates categories or other records not named by a step. Capture
context is checked separately before every write. Plan is not a substitute for
mutation approval. The engine API also requires the plan object.

## Version 1 schema

```json
{
  "version": 1,
  "description": "Optional note",
  "steps": [
    {"name":"item","type":"catalog_item","operation":"create","fields":{"name":"Laptop","active":false}},
    {"name":"cpu","type":"catalog_variable","operation":"create","fields":{"cat_item":{"$ref":"steps.item.sys_id"},"label":"CPU"}},
    {"name":"policy","type":"catalog_ui_policy","operation":"create","fields":{"catalog_item":{"$ref":"steps.item.sys_id"},"short_description":"CPU policy","active":false}},
    {"name":"action","type":"catalog_ui_policy_action","operation":"create","fields":{"ui_policy":{"$ref":"steps.policy.sys_id"},"catalog_variable":{"$ref":"steps.cpu.catalog_variable"},"mandatory":"true"}}
  ]
}
```

Only `version`, `description` and `steps` are accepted at the top level.
Steps accept only `name`, `type`, `operation`, `fields`, `target`.

- Names match `[A-Za-z][A-Za-z0-9_-]*`, maximum 64 characters, unique.
- Operations are `create`, `update`, `delete`.
- Unknown types and fields fail before any write; no unconstrained table fallback.
- Create requires adapter-declared fields and forbids `target`.
- Update requires an explicit target and at least one changed field. Parent
  links supplied in fields must be symbolic. An update to a child alone may omit
  an unchanged parent; include its parent step and reference when ordering them
  together. Variable `name` remains create-only.
- Delete requires an explicit target. Its fields contain only symbolic parent
  links; all adapter-declared parent links must be present. They assert existing
  relationships and are never sent as an update payload.

A reference is exactly `{"$ref":"steps.<name>.<output>"}`. No interpolation,
arbitrary objects, expressions or evaluation are allowed. Parent fields reject
hand-written IDs. Unknown producers, outputs, wrong producer types, cycles and
self-references fail validation. Most outputs are `sys_id`. Catalog variables
also expose `catalog_variable`, an adapter-produced `IO:<sys_id>` value, required
by catalog UI policy actions (confirmed on existing live rows). This is a declared
adapter output, not a string-template language.

## Targets

```json
{"sys_id":"0123456789abcdef0123456789abcdef"}
{"identifier":"Laptop","matchField":"name"}
{"identifier":"cpu","matchField":"name","scope":{"cat_item":"0123456789abcdef0123456789abcdef"}}
```

Targets resolve before any write. Matching is exact only: no partial sys_id,
display-name guessing or implicit create-on-miss. Missing and ambiguous targets
stop the batch. Identifier matching and literal scope fields are adapter
allowlisted; adapters without an identifier field require `target.sys_id`.
Generated IDs belong in fields, never in target selection.

## Families and field schemas

Mappings were queried on demo before implementation; see
[verification](batch-families-verification.md) for dictionary row IDs and limits.
All adapters use strict types (booleans are JSON booleans, order/size are integers,
other fields are strings). Exact supported fields are declared in
`cli/src/batch-adapters/catalog.js` and `families.js`, not passed through unchecked.

| Manifest type | Table | Parent field → type | Required create fields besides parent |
|---|---|---|---|
| `catalog_item` | `sc_cat_item` | none | `name` |
| `catalog_variable` | `item_option_new` | `cat_item` → `catalog_item` | `label` |
| `catalog_ui_policy` | `catalog_ui_policy` | `catalog_item` → `catalog_item` | `short_description` |
| `catalog_ui_policy_action` | `catalog_ui_policy_action` | `ui_policy` → `catalog_ui_policy`; `catalog_variable` → `catalog_variable` output | none |
| `catalog_client_script` | `catalog_script_client` | `cat_item` → `catalog_item` | `name`, `type`, `script` |
| `acl` | `sys_security_acl` | none | `name`, `operation`, `type` |
| `acl_role` | `sys_security_acl_role` | `sys_security_acl` → `acl` | existing `sys_user_role` |
| `ui_policy` | `sys_ui_policy` | none | `short_description` |
| `ui_policy_action` | `sys_ui_policy_action` | `ui_policy` → `ui_policy` | `field` |
| `data_policy` | `sys_data_policy2` | none | `model_table` |
| `data_policy_rule` | `sys_data_policy_rule` | `sys_data_policy` → `data_policy` | `table`, `field` |
| `sp_page` | `sp_page` | none | `id` |
| `sp_container` | `sp_container` | `sp_page` → `sp_page` | none |
| `sp_row` | `sp_row` | `sp_container` → `sp_container` | none |
| `sp_column` | `sp_column` | `sp_row` → `sp_row` | none |
| `sp_instance` | `sp_instance` | `sp_column` → `sp_column` | existing `sp_widget` |

ACL operation/type keys are `read`/`record` on the verified instance, respectively;
they are references whose keys are not 32-character sys_ids. Role rows and widget
instances reference pre-existing external roles/widgets; this engine does not
create those implicitly. Only the verified SP layout chain is implemented, not
arbitrary SP subclasses or nested column/row layouts.

Catalog item create defaults: `short_description: ""`, `active: true`, `type:
"item"`. `category` resolves an existing exact `sc_category.title`; mutually
exclusive `category_sys_id` accepts its ID. It never creates categories.
Catalog variable create derives `name` from `label` when omitted, maps `label` to
`question_text`, resolves documented `type` aliases (default 6/string), and defaults
`mandatory: false`, `order: 100`, `active: true`. Unknown aliases fail. Other
adapters send only declared fields supplied by the manifest; server defaults and
business rules remain server-owned. Set `active: false` explicitly for inert
policy/script trials. Policy action `mandatory`, `visible`, `disabled` use the
instance's string states (`true`, `false`, `ignore`), not JSON booleans.

## Ordering and deletes

Create and update dependencies run parents before children, even if the child
is declared first. Independent ready steps retain declaration order. Delete
reverses dependency edges, not the entire unrelated step list. For example:

```json
{"version":1,"steps":[
  {"name":"policy","type":"ui_policy","operation":"delete","target":{"sys_id":"0123456789abcdef0123456789abcdef"}},
  {"name":"action","type":"ui_policy_action","operation":"delete","target":{"sys_id":"fedcba9876543210fedcba9876543210"},"fields":{"ui_policy":{"$ref":"steps.policy.sys_id"}}}
]}
```

The plan order is `action -> policy`. Plan verifies the existing child's parent
column matches the referenced parent's resolved target. A mismatch makes zero
writes. Delete references name preflight-resolved targets, not outputs from an
already executed parent deletion. Mixing destructive and non-destructive steps
on one reference edge is rejected; use separate manifests.

After each DELETE, an explicit GET query for the exact sys_id must return an
error-free empty result array. Null, missing/malformed results, errors or a
remaining row do not prove absence. A failed/unverified child deletion blocks
its ancestors. Only named records are operated on; discovery/recursive deletion
of unlisted children is not implemented. Include all intended child records;
server cascades/business rules are not simulated.

## Status, failure and safety

Each step reports `created`, `updated`, `deleted`, `failed` or `skipped`, its
resolved ID/target and relevant payload/error. Failed parents skip dependent
children on create/update. Failed child deletes skip ancestors. Independent
steps continue after operational failures; safety stops are sticky and skip
all remaining steps. Read-only and capture-context protections remain active
before every step, including deletes. Delete-containing batches also use the
existing delete confirmation helper: noninteractive runs need `--force` unless
the selected profile explicitly has `skip_confirmations: true`. Confirmation
happens only after the receipt matches the fresh plan and before any write.
Global + Default needs existing explicit
approval/`--force`; completed update sets block writes.

A partial batch exits 1 with a structured result (`ok: true`, `partial: true`).
Validation errors exit 2; the CLI validates the manifest before planning reads.
Batches are not atomic, idempotent or rolled back. A write whose response or
readback is uncertain may have taken effect even when its step reports failure;
inspect the exact target before retrying. `writes_performed` counts verified
successful steps, not proof that a failed transport caused no remote effects.
Remove/reconcile successful steps, convert creates to explicit updates as
appropriate, and generate a new plan before resuming. Receipts can be replayed;
they do not provide a durable checkpoint or automatic retry protection.

## Explicitly unsupported

Dictionary entry → override is skipped: the live override table has composite
`base_table`/`name`/`element` selectors and no parent dictionary-reference column.
No fictitious `sys_dictionary` reference was added. Also unsupported: creating
catalogs/categories/variable sets, arbitrary SP children, generic table-write or
script steps, YAML, expression templates, rollback and cross-instance deployment.
Unsupported types fail validation rather than approximating a mapping.
