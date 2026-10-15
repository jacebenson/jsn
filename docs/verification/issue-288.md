# Update-set selection verification

Issue #288. Base revision 5536d703f3385c6b08919484425a06daa8dd6105.

## Reproduced before the fix

Using the repository SDK and a disposable Global update set on the reported PDI:

1. Warm an authenticated OAuth session while Default is current.
2. Call the original `setCurrentUpdateSet` helper.
3. Read the stored preference and the session's picker selection separately.

The preference reported the disposable set, while
`GET /api/now/ui/concoursepicker/updateset` still returned Default.
The original scope and update set were restored and the probe set removed.
This establishes a session synchronization defect. It does not identify every
actor involved in the historical preference reversion in #280/#288.

The live platform shell bundle independently establishes the picker contract:

- Application: PUT `/api/now/ui/concoursepicker/application`, JSON `app_id`.
- Update set: PUT `/api/now/ui/concoursepicker/updateset`, JSON `sysId`.
- Application GET returns `result.current` as the scope ID.
- Update-set GET returns `result.current.sysId` as the selected set ID.

## Verified after the fix

The same warmed-session probe returned the disposable set from both the stored
preference and the effective picker selection.

A separate end-to-end run exercised the repository CLI with the configured
OAuth profile, using only owned disposable records:

1. `updatesets set` selected the disposable Global set successfully.
2. `records create --table sc_cat_item` captured INSERT_OR_UPDATE there.
3. `records update --table sc_cat_item` kept that capture in the same set.
4. `flows create --data-file` created a complete draft with a record trigger
   and Log action, with an explicit Global transaction scope.
5. Independent Table API readback confirmed `sys_scope=global` on the flow.
6. The flow's INSERT_OR_UPDATE capture was in the selected disposable set.
7. Deleting the owned catalog item and flow captured DELETE in that same set.
8. A fresh authenticated SDK session still selected the disposable set and
   agreed with the stored preference.
9. Exact owned records and customer updates were removed, removal was checked,
   the disposable set was removed, and the original Global/Default selection
   was restored and checked.

Customer-update rows replace their INSERT_OR_UPDATE action with DELETE when
the same artifact is deleted in the same set. The absence of a separate INSERT
row after cleanup is not by itself evidence of update-set drift.

## Automated checks and limits

`test/context-selection.test.js` models the observed separation between stored
preferences and effective session state. It tests session-aware selection,
application-before-set ordering, capture targeting, ineffective/denied picker
writes, scope failure, and explicit partial-success reporting after create.
The capture regression fails on the base revision with Default instead of the
named set. It passes with the fix.

Live flow proof covers draft creation in Global, not publishing, running a
flow, non-Global flow creation, Basic/GCK authentication, or concurrent browser
sessions. This fix does not lock other sessions or migrate previously misplaced
customer updates. No credentials or raw provider payloads are included here.
