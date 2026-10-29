# ServiceNow skill / CLI parity

Parent #328. The final skill keeps agent decisions and ServiceNow development
workflow. Operational mechanics belong to the matching packaged CLI. The implementation dependencies are now on main; the skill delegates
operational mechanics to their installed help and runtime safeguards.

| Skill material | Final decision | CLI home and validation |
| --- | --- | --- |
| Discovery and picker mechanics | Replace with installed-help pointer | #335 registry discovery and accurate help; real PDI help-guided read plus offline JSON/text/extraction proof on that PR. |
| Output modes | Remove duplication | `--json` for parsing, text for people; envelope/extraction tests. |
| Full sys_id blanket | Remove duplication; rely on resolver | #338 bounded exact/human/prefix/suffix resolution and ambiguity errors, integrated through #344. Exact-head PDI lookup/zero-match proof; fixture mutation ambiguity safety. |
| Mandatory auth preflight | Remove | #329/#332 request-driven recovery; real PDI 401 → 200 with one replay, explicitly distinguishing in-memory credential recovery from browser renewal; direct CLI read without a status preflight. |
| Blanket never-logout rule | Remove | #330 informed logout confirmation; real PDI noninteractive refusal retained credentials and profile; destructive clear path remains fixture-tested. |
| Target connection | Keep explicit | Verify intended instance and pin `--profile`; selected-profile live checks and scoped credential tests. |
| Eval safety | Keep explicit | Purpose-built/records preference; explain need and obtain approval; discourage bypassing ServiceNow protections. |
| Mutation confirmation | Keep authorization boundaries only | #336 ordinary create/update behavior and Global + Default approval; delete preference remains separate. Live disposable preference CRUD/history proof and high-risk-context fixture tests. |
| Hierarchy and command catalog | Remove duplication | #335 discovery derives from actual registration; #340 compact declarative registry reaches main through #344. |
| Customization implementation rules | Remove duplication; CLI supplies evidence and coverage | #331 interpretation/coverage/triage in CLI output; bounded live PDI capture and offline review proof. Findings do not imply reversion approval. |
| Update-set completion mechanics | Keep human workflow only | Choose/create scope and set, do the work, verify on the instance, offer ATFs and instance scans, then ask about further additions. Complete with notes after the human confirms the set is finished. Selection/reset mechanics stay in CLI help. |
| Table/REST examples and read-only policy | Remove duplication; CLI enforces policy | Command help tested in #330; raw REST remains blocked on read-only profiles even for GET. |
| Docs tutorial | Remove duplication; root help discovers docs | #346 implements #324 source choice, verified snapshots, offline local use and recovery. Production migration remains an explicit separate deployment gate. |
| Field troubleshooting | Remove duplication; use audited CLI guidance | Separate audit found and corrected before-query constraints, override-table guidance and ACL coverage in #347. No universal priority order; do not bypass protections. PDI schema/read evidence is recorded on that PR. |
| Raw config/credential paths | Remove | #333 scriptable setup/auth help and secure input; live PDI setup/status and offline file/stdin tests. |

## Distribution

`skill install`, `skill show` and `skill check` use the skill bundled with the
installed CLI. Existing integration tests prove offline installation, byte/version
equality, freshness checking and replacement of an outdated installed copy.
`skill fetch` is explicit development-source access. Older CLI versions that
fetch mutable main cannot be corrected retroactively; upgrade JSN first.

## Integration status

#344, #346, #347 and the #318 specialized related-list integration are on main.
The skill now keeps only the entry point and agent judgment that help/runtime
cannot supply: target intent, eval/destructive/context authorization, development
capture, instance verification, an offer of ATFs/instance scans, and human-confirmed completion.
It adds no reference catalog to replace the removed CLI duplication.

External docs service deployment remains a separate operational task; this skill
does not claim that deployment is complete. Live PDI evidence lives on the original
feature PRs. Distribution checks must pass before merging the final skill.
