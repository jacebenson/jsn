---
title: Compare plugins and Store applications
---

# Compare plugins and Store applications

Use one command to report how to align the target instance to the source baseline:

```sh
jsn compare --source pdi --target vendor
jsn compare --source pdi --target vendor --json
jsn compare --source pdi --target vendor --get data.inventories.plugins.counts
jsn compare --source vendor --target pdi --verbose
```

Both options take configured profile aliases. Reversing them reverses the
recommendations. Focused `jsn plugins compare` and `jsn store compare` commands
accept the same options. `--destination` is an alias for `--target`.

The human report names the target to change and shows observed source/target
versions and states alongside recommendations. It recommends activating inactive
plugins when the source is active, reviewing target-only items rather than
removing them, and verifying supported upgrades to a newer source version.
Newer target versions need review, not a downgrade. Only dotted numeric versions
are ordered; unfamiliar provider labels require review. An available Store
version is separate from the local installed version and is never substituted
for the desired source version.

Store installation recommendations require positive source evidence, a nonempty
local version and install date, plus complete target coverage showing absence.
An empty version or install date does not prove that an application is not
installed. Missing installation evidence requires investigation, not an install
or uninstall recommendation. Recommendations are guidance, not executable
remediation or a guarantee of entitlement, compatibility or upgrade availability.

These commands only read instance data. They never install, activate, upgrade,
execute scripts or modify instance records. Normal authentication may refresh
local OAuth credentials or bootstrap a session.

Plugins use `v_plugin.id`, not instance-local `sys_id`. Store applications use
`sys_store_app.scope`. They remain separate inventories. A Store application
can supply plugins, so counts are unique within each inventory, not a
deduplicated product count. Custom `sys_app` applications are excluded.

Human output lists up to 50 differing/unknown rows per inventory by default,
with omitted counts. `--verbose` expands all differences. Matching entries need
no action and are summarized. JSON includes all entries, their `before`, `after`,
`changes`, `recommendations` and `status`. `--get data.counts` extracts totals;
`--get data.inventories.store.coverage` inspects Store coverage.

Every inventory requires a readable provider count, required fields, unique
stable identities, complete pagination and an unchanged final count. Reads are
sequential, at most 200 rows per page, with a default budget of 30 pages per
side per inventory. `--max-pages 100` raises the bounded budget. Short pages do
not establish exhaustion. A changed count, page limit, missing field, duplicate
identity, unreadable response or ACL refusal leaves coverage unknown. Incomplete
reports exit 1 but preserve JSON and extraction output. Their recommendation is
to investigate access/coverage, never install or remove based on unproven absence.
The other inventory can still be complete and useful. Complete coverage exits 0
even when differences exist.

Completeness describes the inventory visible to the account, not records hidden
by row-level ACLs. Counts cannot detect every concurrent edit. Unsupported state
values make the source unknown. Empty plugin versions remain unknown.

Live plugin comparisons were verified between two configured instances in
human, JSON and extraction modes. Both accounts denied `sys_store_app` reads
with HTTP 403. Store refusal and unknown coverage were verified live; successful
Store comparison is covered by offline provider fixtures and still requires an
account that can read this table and its Stats API. The App Client installed-tab
API was readable, but exposed no reliable total count; it is not silently used
as a complete substitute for the denied Store inventory.
