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

`jsn plugins compare <id> --source pdi --target vendor` compares only that
plugin and every plugin it requires, read from the source with the same tree
walk as `jsn plugins show`. The full inventories are still read and checked as
below, and then narrowed, so coverage and recommendations are unchanged. Ids the
source's `v_plugin` does not list are named and not compared. The target's own
requirements are not read; a target plugin that needs more is not shown.

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

The compare commands only read instance data. They never install, activate, upgrade,
execute scripts or modify instance records. Normal authentication may refresh
local OAuth credentials or bootstrap a session.

Plugins use `v_plugin.id`, not instance-local `sys_id`. Store applications use
`sys_store_app.scope`. They remain separate inventories. A Store application
can supply plugins, so counts are unique within each inventory, not a
deduplicated product count. Custom `sys_app` applications are excluded.

`jsn plugins show <id>` reads one plugin and every plugin it requires, nested,
from `v_plugin` by `id`, one level per query, up to 50 levels and 2000 plugins;
a tree cut short is marked incomplete. A required id `v_plugin` does not list is
named with its state unknown, never reported as missing, and a cycle is named
and not followed. `inactive` lists the required plugins that are not active.

`jsn plugins install <id>` previews activating a plugin: the inactive plugins it
would pull in, required plugins first, and any refusal (already active, install
blocked or unreadable, an incomplete tree). With `--yes` and one id it activates that plugin
through the CI/CD API, waits on the tracker, and reads every plugin it listed
back from `v_plugin`. Activation cannot be undone from jsn.

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
reports exit 1 but preserve JSON and extraction output. Unverified absences
require investigation, never installation or removal. Validated observed Store
pairs can still yield matching installed versions or actionable version differences.
The other inventory can still be complete and useful. Complete coverage exits 0
even when differences exist.

Completeness describes the inventory visible to the account, not records hidden
by row-level ACLs. Counts cannot detect every concurrent edit. Unsupported state
values make the source unknown. Empty plugin versions remain unknown.

Live comparisons were verified between all three pairs of approved profiles in
human and JSON modes, plus extraction and a reverse-direction check. Store
Table/Stats reads require the supported UI session on the tested instances:
Bearer-only requests returned 403, while the same reads with Cookie and
X-UserToken returned 200. This command opts only its Store Table/Stats reads
into the existing session-aware transport. Plugin and unrelated SDK defaults
remain unchanged. It does not require changing profile authentication or setting
a process-wide environment override.

Count-verified Store inventories were read and paginated successfully on all
three profiles. Coverage completeness does not make every installation state
known: missing local version/install-date evidence still requires investigation.
The earlier 403 was transport-dependent, not proof of a universal account ACL
denial. If a session-backed Store source still refuses access, the comparison
reuses the production App Client `installed` tab as a read-only fallback.
Membership in that tab plus a reported local version is positive installed
evidence; activation is unreported and stays unknown.

Actual App Client responses exposed only `result.apps`, with limit/offset
pagination and no provider total or explicit has-more/exhaustiveness contract.
The reader continues short pages until an empty page is observed or the page
budget is reached. Even an observed empty page is not advertised as a complete
inventory. The locally calculated `page_full` flag is not provider evidence.

Validated apps observed on both sides have `evidence=observed_pair` and can
produce useful version alignment/review recommendations despite incomplete
inventory coverage. Their installed and available versions stay separate.
Unmatched apps remain unknown and require investigation of visibility, never
installation or removal based on unproved absence. A malformed/duplicate source
invalidates positive comparison evidence. Combined reports still exit 1 when
coverage is incomplete, while retaining useful positive matches/differences.
Required Table fields, counts and pagination are now verified live. A nonempty
local version and install date are still described as local installation evidence,
not an explicit provider installation-state boolean. Empty evidence remains unknown.
