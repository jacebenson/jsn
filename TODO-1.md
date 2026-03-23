# jsn CLI — Improvement Ideas

Collected from real usage by an AI agent (Claude) working on ServiceNow dev across multiple sessions.

---

## 1. `jsn records get` doesn't exist — should it?

**What happened:** I repeatedly tried `jsn records get <table> <sys_id>` before remembering it's `jsn records show`. `get` is the most natural verb for "fetch one record by ID." Every REST mental model says GET.

**Suggestion:** Add `get` as an alias for `show`, or at minimum list it in the help as a recognized alias that says "did you mean `show`?"

---

## 2. `jsn records query` doesn't exist — awkward workaround

**What happened:** I tried `jsn records query u_ai_inference --query "u_type=pulsebox^ORDERBYDESCsys_created_on"` multiple times. The `--query` flag doesn't exist on `records list` either. To do filtered queries I had to fall back to raw REST:

```bash
jsn rest get "/api/now/table/u_ai_inference?sysparm_query=u_type=pulsebox^ORDERBYDESCsys_created_on&sysparm_limit=3&sysparm_fields=sys_id,u_state" --json --agent
```

That's verbose and error-prone (URL encoding issues with spaces, special chars).

**Suggestion:** Add encoded query support to `records list`:
```bash
jsn records list u_ai_inference --query "u_type=pulsebox^ORDERBYDESCsys_created_on" --fields sys_id,u_state --limit 3
```

Or add a dedicated `jsn records query` subcommand.

---

## 3. `jsn records list` output is too sparse for scripting

**What happened:** `jsn records list u_ai_file --query "u_status=pending"` returns only sys_id, name, number, and link. I almost always need specific fields, so I end up using `jsn rest get` with `sysparm_fields` instead. The `--agent` flag helps get JSON, but the default field selection is rarely useful.

**Suggestion:** Add `--fields` flag to `records list`:
```bash
jsn records list u_ai_file --fields sys_id,u_status,u_changes,u_agent --limit 10 --agent
```

---

## 4. No `jsn tables create` command

**What happened:** I needed to create tables (`u_ai_agent`, `u_ai_file`). There's `jsn tables list`, `jsn tables show`, `jsn tables columns`, etc. — but no `create`. I had to use `jsn records create sys_db_object` which worked, but isn't discoverable.

**Suggestion:** Add `jsn tables create`:
```bash
jsn tables create u_ai_agent --label "AI Agent"
```

And maybe `jsn tables add-column`:
```bash
jsn tables add-column u_ai_agent u_name --type string --max-length 100 --label "Name"
```

This is a less common operation, so low priority — but it would be nice.

---

## 5. `jsn records update` field flag is finicky with complex values

**What happened:** Updating fields with JSON content, long strings, or special characters via `-f field=value` is unreliable. I consistently had to fall back to building JSON with python3 and using `jsn rest patch` for anything beyond simple string values.

For example, updating a script include with a multi-line script:
```bash
# This doesn't work well:
jsn records update sys_script_include <id> -f script='multi\nline\nscript'

# I always ended up doing this instead:
python3 -c "
import json, subprocess
body = json.dumps({'script': big_string_var})
subprocess.run(['jsn', 'rest', 'patch', '/api/now/table/sys_script_include/<id>', '--data', body, '--json', '--agent'])
"
```

**Suggestion:** Support `--json` input for updates (like `records create` already does):
```bash
jsn records update sys_script_include <id> --json '{"script":"..."}'
```

Or support reading field values from files:
```bash
jsn records update sys_script_include <id> -f script=@/tmp/my_script.js
```

The `@file` pattern (like curl) would be very useful for script fields.

---

## 6. No way to run background scripts

**What happened:** I needed to call a server-side Script Include function (`applyReview`) that's only exposed as a GlideAjax processor — not a REST endpoint. There's no `jsn` command to execute arbitrary server-side JavaScript.

`jsn jobs run` exists but only triggers existing scheduled jobs. I couldn't call arbitrary Script Include methods.

**Suggestion:** Add `jsn script run` or `jsn eval`:
```bash
jsn eval "var pb = new PulseBoxAIAB(); gs.print(JSON.stringify(pb.runHeartbeat()));"
```

This would be the equivalent of the "Scripts - Background" page in ServiceNow. It's extremely useful for testing and automation. (Might need a fix script or scheduled job under the hood to execute.)

---

## 7. `jsn rest` URL encoding issues with spaces

**What happened:** Queries with spaces in the value caused 400 errors:
```bash
# This fails:
jsn rest get "/api/now/table/sys_update_xml?sysparm_query=target_nameLIKEProcess PulseBox" 

# Must manually encode:
jsn rest get "/api/now/table/sys_update_xml?sysparm_query=target_nameLIKEProcess%20PulseBox"
```

**Suggestion:** Auto-encode query parameter values, or at least provide a clear error message suggesting URL encoding when a 400 is returned.

---

## 8. `jsn rest delete` returns empty body — no confirmation

**What happened:** Delete operations return `{"body": null, "method": "DELETE", "status": 204}`. This is technically correct (204 No Content), but when scripting it's nice to have confirmation of what was deleted.

**Suggestion:** Minor — maybe print a "Deleted <table>/<sys_id>" message in non-agent mode. Low priority.

---

## 9. `jsn jobs run` doesn't reliably execute jobs

**What happened:** Early in the project we tried `jsn jobs run` to trigger a scheduled job and it didn't work. We had to create a REST endpoint and use `jsn rest post` instead. I don't have the exact error anymore, but it was unreliable enough that we stopped trying.

**Suggestion:** Worth investigating — if `jsn jobs run` is meant to trigger scheduled jobs, it should work reliably or clearly state its limitations.

---

## 10. Missing `jsn records count` with query support

**What happened:** To count records matching a filter I had to do a full `jsn rest get` with `sysparm_limit=1` and check the `X-Total-Count` header, or list all records and count them in python.

**Suggestion:** If `records count` exists (I saw it in help), make sure it supports encoded queries:
```bash
jsn records count u_ai_file --query "u_status=pending"
```

---

## Priority Summary

| # | Issue | Impact | Frequency |
|---|-------|--------|-----------|
| 2 | No encoded query support on `records list` | High | Every session |
| 5 | Complex field values hard to pass | High | Every session |
| 6 | No background script execution | High | Multiple times |
| 1 | `get` alias for `show` | Medium | Multiple times |
| 3 | `records list` needs `--fields` | Medium | Every session |
| 7 | URL encoding in `jsn rest` | Medium | Several times |
| 4 | No `tables create` | Low | Once per project |
| 9 | `jobs run` unreliable | Low | Tried once, gave up |
| 8 | Delete confirmation | Low | Minor annoyance |
| 10 | Count with query | Low | Occasional |
