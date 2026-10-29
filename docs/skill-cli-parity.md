# ServiceNow skill / CLI parity

Parent #328. The final skill keeps agent decisions and ServiceNow development
workflow. Operational mechanics belong to the matching packaged CLI. This branch
must remain draft until the implementation gates below reach main; a smaller
skill must not run ahead of its safeguards.

| Skill material | Final decision | CLI home and validation |
| --- | --- | --- |
| Discovery and picker mechanics | Replace with installed-help pointer | #335 registry discovery and accurate help; real PDI help-guided read plus offline JSON/text/extraction proof on that PR. |
| Output modes | Keep concise | `--json` for parsing, text for people; envelope/extraction tests. |
| Full sys_id blanket | Replace with safe identifier behavior | #338 bounded exact/human/prefix/suffix resolution and ambiguity errors, integrated through #344. Exact-head PDI lookup/zero-match proof; fixture mutation ambiguity safety. |
| Mandatory auth preflight | Remove | #329/#332 request-driven recovery; real PDI 401 → 200 with one replay, explicitly distinguishing in-memory credential recovery from browser renewal; direct CLI read without a status preflight. |
| Blanket never-logout rule | Remove | #330 informed logout confirmation; real PDI noninteractive refusal retained credentials and profile; destructive clear path remains fixture-tested. |
| Target connection | Keep explicit | Verify intended instance and pin `--profile`; selected-profile live checks and scoped credential tests. |
| Eval safety | Keep explicit | Purpose-built/records preference; explain need and obtain approval; never bypass ACLs, business rules or other protections. |
| Mutation confirmation | Rewrite to actual policy | #336 ordinary create/update behavior and Global + Default approval; delete preference remains separate. Live disposable preference CRUD/history proof and high-risk-context fixture tests. |
| Hierarchy and command catalog | Remove duplication | #335 discovery derives from actual registration; #340 compact declarative registry reaches main through #344. |
| Customization implementation rules | Short capability/coverage pointer | #331 interpretation/coverage/triage in CLI output; bounded live PDI capture and offline review proof. Never infer automatic reversion approval. |
| Update-set completion mechanics | Keep human workflow only | Identify scope/set, group related changes, report capture location. Human must explicitly request completion even for agent-created sets. Current completion returns selection to Default; some changes are untracked. |
| Table/REST examples | Remove duplication | Command help tested in #330; raw REST remains blocked on read-only profiles even for GET. |
| Docs tutorial | One local-search sentence | #346 implements #324 source choice, verified snapshots, offline local use and recovery. Production migration remains an explicit separate deployment gate. |
| Field troubleshooting | Keep audited symptom-based workflow | Separate audit found and corrected before-query constraints, override-table guidance and ACL coverage in #347. No universal priority order; do not bypass protections. PDI schema/read evidence is recorded on that PR. |
| Raw config/credential paths | Remove | #333 scriptable setup/auth help and secure input; live PDI setup/status and offline file/stdin tests. |

## Distribution

`skill install`, `skill show` and `skill check` use the skill bundled with the
installed CLI. Existing integration tests prove offline installation, byte/version
equality, freshness checking and replacement of an outdated installed copy.
`skill fetch` is explicit development-source access. Older CLI versions that
fetch mutable main cannot be corrected retroactively; upgrade JSN first.

## Remaining integration gates

- #344 brings the reviewed resolver, compact profiles and essential relationships
  onto main after the earlier stacked PRs were merged into feature branches.
- The #318 functional integration must add specialized related-count hooks and
  the metadata producer/consumer safety fix together. Generic records views keep
  their current presentation.
- #346 completes local docs/website implementation. External service deployment,
  publisher configuration and production manifest availability must be verified
  before claiming #324 complete.
- #347 supplies audited troubleshooting mechanics before the old examples are
  removed. The short field-investigation workflow is retained deliberately.

Do not close #328 until the final skill, its distribution checks and the matching
CLI changes are integrated. Live PDI evidence lives on the original feature PRs;
there is no separate evidence-only PR to merge.
