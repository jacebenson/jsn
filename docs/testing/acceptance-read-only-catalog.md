# Bounded read-only resource acceptance

`cli/test/acceptance/read-only-catalog.mjs` exports 66 concrete scenarios for 34 reviewed resource families. Each family has a separate list result and, where safely bounded, a dependent show result. The catalog reuses production record profiles for tables, factory kind, constraints and essential-child policy. A reviewed allowlist prevents new profiles from acquiring coverage without review.

This is resource read sampling, not full family lifecycle acceptance. No help execution, alias duplication, source-text counts or fake passing callbacks count as provider behavior.

## Included commands

| Family | Actual table | Actions |
| --- | --- | --- |
| includes | sys_script_include | list, show |
| rules | sys_script | list, show |
| clientscripts | sys_script_client | list, show |
| uiactions | sys_ui_action | list, show |
| sppages | sp_page | list, show |
| spwidgets | sp_widget | list, show |
| uipages | sys_ui_page | list, show |
| appmenu | sys_app_application | list, show |
| acls | sys_security_acl | list, show |
| roles | sys_user_role | list, show |
| properties | sys_properties | list, show |
| relationships | sys_relationship | list, show |
| appmodules | sys_app_module | list, show |
| listcontrols | sys_ui_list_control | list, show |
| views | sys_ui_view | list, show |
| privileges | sys_scope_privilege | list, show |
| uxscripts | sys_ux_lib_source_script | list, show |
| catalogscripts | catalog_script_client | list, show |
| scriptactions | sysevent_script_action | list, show |
| scheduledjobs | sysauto_script | list, show |
| asyncrules | sys_script | list, show |
| triggers | sysevent_register | list, show |
| assignments | sysrule_assignment | list, show |
| email | sysevent_in_email_action | list, show |
| uimacros | sys_ui_macro | list, show |
| uxlists | sys_ux_list | list, show |
| uxapplicability | sys_ux_applicability_m2m | list, show |
| cataloguipolicies | catalog_ui_policy | list, show |
| tables | sys_db_object | list only |
| incidents | incident | list, show |
| changes | change_request | list, show |
| requests | sc_req_item | list only |
| tasks | sc_task | list, show |
| uipolicies | sys_ui_policy | list, show |

## Executed behavior

Each list uses registered `--query sys_idISNOTEMPTY --columns sys_id,sys_updated_on --limit 1 --display-values raw --json`. The actual factory adds its normal ordering and any mandatory constraints. In particular, asyncrules retains `when=async`. No count is requested.

A nonempty list must have a valid exact sys_id, consistent visible count, and no more than one row. An independent `ctx.read` Table API GET projects only sys_id and sys_updated_on for the selected ID with limit 1. Both fields must be present, nonempty and equal. The same CLI list then runs in Markdown, filtered to that observed ID, and must render the identity and timestamp.

A show scenario requires its family's list scenario. It takes only the ID retained by that list, never a guessed name or hardcoded provider ID. It executes the real registered show with `--identifier-field sys_id --display-values raw --json`, independently rereads the projected metadata, and executes Markdown show. The shared resolver performs an exact query with limit 2 to detect ambiguity. Normal successful show does not perform partial matching or extra requests. UI policies explicitly use `--no-essential` to avoid the default child-record expansion. No related-list, hierarchy, count, watch or follow flags are requested.

An empty visible list can pass the empty-list contract but cannot pass show. Show returns `blocked-prerequisite` with an explicit no-visible-fixture explanation. ACL rejection, missing table, malformed results, over-limit results, missing identity/comparison fields and independent mismatches do not become successful samples. Metadata changing between the command and independent read conservatively fails comparison; no retry hides concurrent changes.

Only IDs are retained in shared state. Assertion messages contain fixed labels, not provider payloads, names or bodies. Production show commands can return complete records, including sensitive fields. The runner's raw command receipts must remain private and must not be published. The public result projection must retain only scenario identity, status and timings.

## Verification

Run from `cli/`:

```sh
node --test test/acceptance-read-only-catalog.test.js
eslint test/acceptance/read-only-catalog.mjs test/acceptance-read-only-catalog.test.js
```

The offline test executes the real checkout CLI asynchronously against a loopback HTTP fixture using isolated HOME/config/data/cache directories and synthetic OAuth. It separately calls the Table API for independent readback. Every reviewed family executes JSON and Markdown list, and every included show executes both formats. Tests assert exact table paths, projections, query constraints, resolver bounds, raw display representation, no unexpected endpoints and zero instance-record mutations.

OAuth session initialization legitimately uses POST `/angular.do?sysparm_type=get_user` plus a bounded sys_scope bootstrap read. Only that exact authentication POST is allowed by the fixture. All data requests must be GET. A blanket ban on all POSTs would incorrectly reject the production OAuth path; accepting arbitrary POSTs would conceal real mutation. Bootstrap is kept separate from resource request assertions.

Failure regressions use real subprocesses for empty lists, ACL denial, missing tables, malformed result shape, oversized responses, missing fields/identity, independent mismatch and incorrect show identity. An additional no-fixture test proves show never dispatches a request without a selected target. Canonical command paths, requirement IDs, option-definition IDs and source files are checked against `coverage.json` and the checkout. Aliases are not separately credited.

Bindings credit only scripted success and human/JSON output for these actions. They bind the exercised canonical query, projection, limit, raw representation, identifier-field and format option IDs. UI-policy show also binds the tested essential-child negation. They do not establish every value/default/negation of those options, interactive paths, failure behavior on every family, all common global options, child workflows or lifecycle completeness. Offline failure tests do not masquerade as live per-family failure coverage.

## Integration boundary

The parent runner must load `read-only-catalog.mjs` and include its explicit `commandPaths` in its read-only allowlist. The reviewed argument policy must admit `--display-values`, `--identifier-field` and `--no-essential` for the corresponding paths, in addition to existing list/format flags. Do not authorize every verb on a catalog family, all generic profiles, arbitrary REST calls or Store. Preserve explicit profile/expected-host preflight and target binding. The module uses only the agreed `ctx.command`, `ctx.read` and `ctx.state` interfaces and runs in readonly or pdi mode.

The inventory's effective options are canonical string IDs such as `includes list --limit`, not plain option names. Any coverage join must preserve that schema. Other requirements and options remain unbound rather than inheriting a blanket family pass.

## Explicit remaining scope

- `tables show` invokes an aggregate dictionary count and ancestor traversal. It is intentionally absent from this no-count sampler.
- `requests show` overrides the ticket factory and fetches attachments and catalog variables without sampler-controlled bounds. A real request-path regression exposed this difference; it is intentionally absent rather than accepted as generic show.
- `actions`, `aliases`, `b4rules`, `columns`, `import`, `restmessage`, `soapmessages` use custom factories, hooks or registrations. Their bounded read contracts require separate implementation.
- `approvals`, `atf`, `attachments`, `cases`, `catalogitems`, `cmdb`, `decisiontables`, `domains`, `flows`, `forms`, `groupmembers`, `grouproles`, `groups`, `knowledge`, `lists`, `midservers`, `scopes`, `scrapi`, `skipped-updates`, `tickets`, `updatesets`, `users`, `workflows` require bespoke resource, hierarchy, endpoint, prerequisite or workflow assertions. This module does not infer them from the profile-backed families.
- `auth`, `codesearch`, `completion`, `customizations`, `diff`, `discover`, `docs`, `eval`, `graphql`, `history`, `logs`, `perf`, `platform`, `records`, `rest`, `scan`, `setup`, `skill`, `snippets`, `transactions`, `upgrade`, `version` are outside this resource catalog. Other suite modules may cover some of them; this module claims none of that coverage. In particular, it performs no implicit all-profile authentication, eval or unrestricted log reads.
- Store remains excluded from live acceptance by user instruction. Existing offline Store tests are not replaced.

No live instance was contacted during worker verification. Full runner integration, independent safety review and explicitly targeted live OAuth execution belong to the parent. The remaining inventory gaps must keep full acceptance incomplete.
