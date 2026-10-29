# ServiceNow skill / CLI parity

Tracking: #328. Remove operational guidance only when its CLI replacement is
available in the same package. This is an incremental audit, not proof that the
linked implementation issues are complete.

| Skill material | Decision | CLI home / remaining proof |
| --- | --- | --- |
| Discovery, picker mechanics | Keep pending #320 | `records list --help` now explains its picker accurately; other list implementations still need a full audit. |
| Machine output | Keep | Concise `--json` guidance remains agent behavior. |
| Full sys_id requirement | Keep pending #314 | `src/resolve-record.js` currently limits lookup to one result; ambiguity-safe central resolution is not implemented. |
| Auth preflight | Keep pending #311/#327 | `src/sdk.js` throws on HTTP failures; proactive token refresh is not equivalent to safe runtime recovery. |
| Blanket logout prohibition | Remove | `auth logout --help` explains local-only clearing and approval. `test/auth-logout.test.js` covers approval/decline, noninteractive errors, identities, no-op/failed deletion, and next actions. |
| Intended instance | Rewrite / keep | Explicit `--profile` targeting and verification of the intended instance remain agent decisions. |
| Eval safeguards | Rewrite / keep | Explicit approval and no bypass of ServiceNow protections remain agent decisions. |
| Mutation confirmation | Keep pending #310 | Ordinary creates/updates should need no confirmation; Global + Default must require context approval. `src/app.js` currently only warns, and JSON/quiet bypass that header. Do not claim the guard is implemented. |
| Command hierarchy/catalog | Keep pending #320 | Intent-based discovery from command metadata is not yet implemented. |
| Customization interpretation | Keep pending #326 | Caveats exist in `src/customizations.js` and `src/customizations-report.js`; complete output/help parity audit still required. |
| Update-set workflow | Rewrite / keep | Identify scope/set, keep related work together, report capture location, and complete only on explicit human request. Keep existing mechanics until the #310 help/output review is complete. |
| Table/raw REST examples | Remove duplicated examples | `records list --help`, `records get --help`, `rest --help`; CLI-level checks in `test/records-rest-help.test.js`. All REST methods remain blocked on read-only connections. |
| Docs tutorial | Keep pending #324 | Offline docs exist, but the agreed snapshot distribution redesign is not implemented. |
| Field troubleshooting | Keep / deferred | Human explicitly deferred review; requires a separate audit. |
| Configuration paths | Keep pending #323 | Full wizard/noninteractive capability parity and diagnostics need verification before removal. |

## Distribution proof

`skill install`, `skill show`, and `skill check` now use the packaged skill.
The install regression in `test/usability-safety-prompt-gating.test.js` proves
offline installation, byte/version equality, a current check, and replacement of
a stale installed copy. `skill fetch` remains explicit development-source access.
Older released CLI versions still download mutable `main`; this change cannot
retroactively change those installers. Upgrade the CLI before reinstalling.

## Verification

Use the repository binary, unit/CLI tests, lint, and the local docs fixture from
`.agents/skills/verify/`. No live instance mutation or credential clearing is
needed to validate this slice. Do not close #328 until the remaining parity
gates, skill packaging, and the deferred troubleshooting review are complete.
