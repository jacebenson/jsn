# Cross-instance update-set diff

```sh
jsn updatesets diff --source pdi --target vendor
jsn updatesets diff --source pdi --target vendor --from 2w --json
jsn updatesets diff --source pdi --target vendor --from 2026-10-01
jsn updatesets diff --source pdi --target vendor --get data.sets
```

`--source` and `--target` are independent configured profiles; the active profile is not changed. `--from` is a UTC date window, not a profile: default `2w`, relative positive days/weeks (`14d`), or an exact calendar date. Selection is **currently complete** local source sets with `sys_updated_on >= cutoff`. It does not reconstruct completion transitions. Targets are searched across all dates.

Identity follows the existing export/import model: `sys_remote_update_set.remote_sys_id` identifies the original local `sys_update_set.sys_id`. Never match on name. Multiple retrieved candidates for one origin are Unknown, even when names agree. A committed retrieved candidate is Matching only when count-verified `sys_update_xml` captures joined by source `update_set` and target `remote_update_set` have the same unique artifact `name`, `action`, and exact `payload`. Envelope capture IDs, set references, timestamps and updater metadata are not compared. Payload XML is not normalized: representation differences conservatively report Different. This is captured-content evidence, not current-record comparison, preview, dependency analysis or deployment readiness.

Machine statuses remain Matching, Missing (only with complete inventories), Retrieved not committed, Different and Unknown. Default human output labels these **Committed, matching**, **Missing in target**, **Loaded, not committed**, **Content differs** and **Unable to verify**. Each named batch shows its base first, with children indented beneath parents; standalone sets have their own heading. Names are preserved exactly. Older and incomplete members show `Context only (source state)` and do not contribute to the status-count footer. Different sets list only changed artifact names and reasons; Unknown sets show one reason and a next step. The short shared note describes the selection window and captured-content boundary once.

`--verbose` retains full per-set evidence, IDs, source states, capture counts and coverage errors. JSON and `--get` retain the same statuses, identities and evidence regardless of verbosity. Base is derived from the oldest observable `parent` ancestor, not a guessed base field. Cycles and unreadable ancestry remain visible without unbounded traversal. “No selected sets” appears only after a complete source selection; unreadable selection explicitly leaves absence unestablished. The command requires no default profile and suppresses the unrelated active-profile context header.

Operational bounds: each table query uses at most 20 pages of 200 rows, a provider Stats count before and after, stable sys_id ordering, unique identities, strict response arrays and required fields. Short pages continue until the count is met. ACL errors, omitted fields, changing counts and budgets retain error/partial coverage rather than implying absence. These reads are not an atomic snapshot: same-count concurrent changes remain possible. Source hierarchy and the all-dates target inventory can exceed the budget; inspect coverage before using the report. No instance-record writes or eval occur; ordinary SDK authentication refresh/bootstrap remains permitted.

The fixture test uses the real CLI with two distinct profile identities and a local HTTP server; no live ServiceNow verification or live fixture creation is claimed.
