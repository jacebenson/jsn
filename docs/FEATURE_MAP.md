# JSN feature map

This is the product map for JSN. The verification kitchen under `.agents/skills/verify/` describes how to prove selected surfaces work. It is not a second product map.

| Surface | User entry point | Implementation | Proof |
| --- | --- | --- | --- |
| Records | `records`, `incidents`, `changes`, `requests`, `tasks`, and related table commands | `src/commands/records.js`, `src/commands/_simple.js`, `src/commands/_ticket.js` | CLI tests plus a read-only disposable-instance drive |
| Cross-profile diff | `diff record` | `src/commands/diff.js`, `src/session.js`, `src/resolve-record.js` | Focused fixture tests; live verification requires two authenticated profiles |
| Authentication and profiles | `auth status`, `auth switch`, setup and login commands | `src/commands/auth.js`, `src/config.js`, `src/app.js` | Auth status without exposing credentials; profile-selection tests |
| Raw REST | `rest` | `src/commands/rest.js`, `src/session.js` | GET-only request against a safe read-only profile |
| ServiceNow domain surfaces | CMDB, catalog, ATF, flows, decision tables, users, groups, scopes, and platform commands | `src/commands/` | Command help, focused unit tests, then safe instance-backed proof where available |
| Platform stats | Fixed, bounded, read-only `/xmlstats.do` summary with allowlisted metrics and honest partial/error statuses | `src/commands/platform.js` | `test/platform.test.js`, local JSON smoke, safe authenticated PDI proof |
| Documentation | `docs`, including search, refresh, ingest, serve, and sync flows | `src/commands/docs/`, `docs/`, `skills/` | Local fixture search in JSON and Markdown; no instance required |
| Output and scripting | `--json`, `--markdown`, `--csv`, `--get`, and styled output | `src/output.js`, `src/cli.js` | Output-shape and CLI tests |
| Performance and diagnostics | `perf`, logs, transactions, snippets, and inspect commands | `src/commands/perf.js`, related command modules | Read-only command checks and focused tests |
| GraphQL | `graphql` with positional, `--query`, `--query-file`, or `--stdin` documents | `src/commands/graphql.js`, `src/sdk.js` | Bounded authenticated query plus command/transport tests |

For proof details, start with `.agents/skills/verify/SKILL.md` and `.agents/skills/verify/features/README.md`. Add a feature here only when the command exists in the source and its user-visible behavior is understood.
