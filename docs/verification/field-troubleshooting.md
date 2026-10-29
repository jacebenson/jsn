# Field troubleshooting parity proof

The CLI owns investigation mechanics; the skill remains unchanged in this PR.
There is no fixed priority order for every symptom. `columns --help` now provides
separate dictionary/override, query-rule, ACL and form-behavior paths. ACL help
explicitly includes inherited/wildcard/field coverage and warns that rows alone
do not prove effective access. The do-not-bypass safeguard remains explicit.

The factory fixed filter previously disappeared whenever `--query` was supplied.
It now remains an invariant. Constrained views accept bounded literal AND clauses
and ordering; OR/NQ/dynamic directives fail before transport. Generic records
retain advanced encoded queries. Before-query rules use `when=before` plus the
Boolean `action_query=true`, without classifying rules by their order.

Seven focused tests pass, covering constrained composition, empty queries,
ordering, case variants/OR/NQ/dynamic rejection before SDK access, preservation of
unconstrained query semantics and actual CLI help. Lint passes.
The full suite on the combined main-integration source plus this follow-up
passed 1,516 tests, with 2 skipped and 0 failures (1,518 total).
After #344 landed, this follow-up was rebased onto main. Its field runtime and
test changes are unchanged. Main additionally contains the related-count reader;
the combined field/profile/related-reader checks passed 23 tests after rebase,
and full lint passed. The PR diff now contains only this field follow-up.

[Sanitized live terminal proof](field-troubleshooting-live.json) records source
revision and each actual command. A fresh mandatory PDI doctor reported
verified/authenticated true immediately before the read-only smoke; cleanup
passed. The constrained command returned five visible rows, all with when=before
and action_query=true. An NQ attempt exited 2 with usage_error. Metadata lookup
confirmed sys_dictionary_override as Dictionary Entry Override. No live writes,
script execution, private rule payload dumps or effective-ACL behavior claims.
