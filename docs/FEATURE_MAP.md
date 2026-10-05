# JSN feature map

This is the product map for JSN. The verification kitchen under `.agents/skills/verify/` describes how to prove selected surfaces work. It is not a second product map.

| Surface | User entry point | Implementation | Proof |
| --- | --- | --- | --- |
| Records | `records`, `incidents`, `changes`, `requests`, `tasks`, and related table commands | `src/commands/records.js`, `src/commands/_simple.js`, `src/commands/_ticket.js` | CLI tests plus a read-only disposable-instance drive |
| Authentication and profiles | `auth status`, `auth switch`, setup and login commands | `src/commands/auth.js`, `src/config.js`, `src/app.js` | Auth status without exposing credentials; profile-selection tests |
| Raw REST | `rest` | `src/commands/rest.js`, `src/session.js` | GET-only request against a safe read-only profile |
| ServiceNow domain surfaces | CMDB, catalog, ATF, flows, decision tables, users, groups, scopes, and platform commands | `src/commands/` | Command help, focused unit tests, then safe instance-backed proof where available |
| Documentation | `docs`, including search, refresh, ingest, serve, and sync flows | `src/commands/docs/`, `docs/`, `skills/` | Local fixture search in JSON and Markdown; no instance required |
| Output and scripting | `--json`, `--markdown`, `--csv`, `--get`, and styled output | `src/output.js`, `src/cli.js` | Output-shape and CLI tests |
| Performance and diagnostics | `perf`, logs, transactions, snippets, and inspect commands | `src/commands/perf.js`, related command modules | Read-only command checks and focused tests |

For proof details, start with `.agents/skills/verify/SKILL.md` and `.agents/skills/verify/features/README.md`. Add a feature here only when the command exists in the source and its user-visible behavior is understood.
