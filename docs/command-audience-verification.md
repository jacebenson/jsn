# Command audience verification — issue 356

Executed 2026-10-29 with this checkout's `node bin/jsn.js` (4.3.13).

## Live PDI boundary

Immediately preceding doctor: profile `pdi`, OAuth/keyring,
`authenticated=true`, `verified=true`, current-user probe succeeded, exit 0.
Read-only SDK current-user and `sys_user_has_role` reads then produced:

```json
{
  "timestamp": "2026-10-29T06:43:26.992Z",
  "admin": {
    "verified": true,
    "audience": "admin"
  },
  "nonadmin": {
    "current_user_error": "auth_error",
    "current_user_status": 401,
    "audience": "basic",
    "role_check": "unavailable"
  }
}
```

The admin result is live proof of role detection. The disposable MID-only
account could not use the current-user endpoint (401), so this run does **not**
claim a successful non-admin login. Its unavailable role check correctly chose
the compact fallback. No profile, credential, default connection or instance
record was changed by these checks. Disposable account cleanup belongs to the
MID workflow that created it.

## CLI presentation proof (isolated local profile fixture)

These commands used a temporary profile with a verified `basic` audience, with
no credentials and no instance requests. They prove presentation and explicit
command availability separately from the live role query above.

```text
$ node bin/jsn.js --json
{"exit":0,"count":19,"names":["setup","auth","incidents","changes","requests","tasks","groups","groupmembers","grouproles","users","records","tickets","approvals","history","skill","docs","version","discover","completion"]}
$ node bin/jsn.js --all-commands --json
{"exit":0,"count":80,"names":["setup","auth","updatesets","scopes","domains","incidents","changes","requests","tasks","catalogitems","flows","actions","scriptactions","scheduledjobs","asyncrules","triggers","rules","decisiontables","assignments","scrapi","email","restmessage","soapmessages","acls","b4rules","roles","privileges","aliases","groups","groupmembers","grouproles","users","forms","lists","clientscripts","uipolicies","uiactions","views","catalogscripts","cataloguipolicies","uipages","uimacros","listcontrols","sppages","spwidgets","uxscripts","uxlists","uxapplicability","appmenu","appmodules","tables","columns","relationships","includes","import","logs","properties","cmdb","records","transactions","platform","snippets","tickets","codesearch","atf","approvals","skipped-updates","perf","history","customizations","midservers","diff","graphql","eval","rest","skill","docs","version","discover","completion"]}
$ node bin/jsn.js discover eval --json
{"exit":0,"count":0,"names":[]}
$ node bin/jsn.js discover eval --all-commands --json
{"exit":0,"count":1,"names":["eval"]}
$ node bin/jsn.js eval --help
exit=0; Usage: jsn eval |  | Execute background scripts on the instance

```

Automated regression checks also cover selected profiles, grouped root help,
`help`, root JSON, `discover`, shell completion, admin/legacy/unknown identities,
account mismatch, role-table denial, login persistence, and setup/auth recovery
parity. The profile origin is part of the cached audience identity.

The verify skill's local docs-search drive returned three JSON results and
human-readable output; cleanup retained sanitized evidence. Lint and the full
unit suite are recorded in the pull request.
