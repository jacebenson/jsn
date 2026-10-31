# Customization evidence: skill-to-CLI parity

Tracking #326 / #328. The skill retains capability discovery, a capture/review
example, and the agent decision to verify evidence before proposing changes.
The detailed interpretation lives in `src/customization-guidance.js`, shared
by command help and derived report views.

| Former skill rule | CLI home / proof |
| --- | --- |
| Bounded GET-only table reads; OAuth refresh and session bootstrap are possible | Root/capture help and JSON `interpretation.capture`; the CLI integration test permits only table GETs plus authentication POSTs. Saved operations work after the fixture server closes. |
| Declare customer scopes; non-global scope does not prove ownership | Help and `interpretation.evidence.ownership`; existing provider/classification tests and per-artifact triage distinguish declaration from verification. |
| Upgrade skips are historical, not a verified current deviation | Help, text, JSON `interpretation.evidence.upgrade_skips`, HTML interpretation and triage. |
| Raw 4/104 and reviewed_reverted exclusion | Existing provider-fixture tests cover raw values, display labels and reverted rows; help and JSON name the rules explicitly. |
| file_name resolves by sys_update_name in chunks | Existing direct-lookup tests cover artifacts beyond the broad sample; help and JSON `interpretation.evidence.resolution` explain the join. |
| Unresolved names, failed chunks, unknown scope names | Coverage in JSON and default/expanded text; HTML coverage renders unmatched names/counts and failed chunks. Existing ACL/lookup tests now verify the text views too. |
| Broad metadata read is a sample, not an inventory | Shared interpretation and capture coverage. A new regression proves reverted-history lookups can also contribute unclassified artifacts outside the sample; customer/unclassified categories are not complete inventories. |
| ACLs, pagination, unmatched evidence, empty findings | Coverage retains source status/count/reason and limitations; interpretation explicitly says no findings is not proof of no customizations, including an empty capture. |
| Comparisons use metadata/evidence, not source payloads | Comparison help, JSON `interpretation.comparison`, human output and existing field comparison tests. |
| Removed means not observed, not deleted | Existing `availability` fields and comparison tests; common interpretation repeats the limitation in each review surface. |
| Reversion impact/dependencies unknown; no automatic reversion | Shared limitations/next steps, per-artifact triage and `automated_remediation: false`; short agent safeguard remains in the skill. |

## Compatibility and validation

`interpretation` is an additive derived output field on capture/show/compare/html
results and HTML's embedded view. Stored capture schema, IDs, evidence, existing
JSON fields and triage remain intact. Older captures acquire current guidance
when viewed; no migration or rewrite of stored reports is required. Tests prove
viewing and comparing a capture does not mutate its saved data.

Run the customization unit/provider/HTML/CLI tests, full suite, lint and the local
docs fixture. The CLI test checks help offline, JSON interpretation equality
across surfaces, HTML's embedded view, coverage visibility and `--get` behavior.
All capture traffic is against a local fixture server, never a live instance.
