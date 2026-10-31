---
name: verify
description: Verify the JSN CLI with OpenCode-compatible pstack workflows. Use before claiming jsn behavior works or after changing commands, profiles, auth, output, or REST handling.
---

# Verify JSN

This project-local skill is the JSN CLI driver for OpenCode. It follows the pstack-claude verification shape without copying the Cursor plugin. The OpenCode-compatible pstack skills are installed through the documented shared Agent Skills path at `~/.agents/skills/`, while this repo-owned skill lives at `.agents/skills/verify/`. Run it from the repository root.

## Launch

JSN is a short-lived Node CLI with no build step. Hosted docs verification requires the Rails site to be running.

```bash
npm --prefix cli install
node cli/bin/jsn.js --version
```

For a global-style executable without publishing anything:

```bash
npm --prefix cli link
jsn --version
```

Use `node cli/bin/jsn.js` in evidence so the checkout under test is unambiguous. Use the current Node.js LTS release; older release lines are not tested or supported.

## Doctor

Run the read-only doctor before any instance-backed drive:

```bash
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi --allow-unauthenticated
```

The doctor proves the repository binary, package version, selected profile name, configured instance hostname, auth method, and authentication state. It prints no usernames, tokens, cookies, passwords, or credential contents. `--allow-unauthenticated` is only for the hosted-docs lane, which does not use instance credentials. Without it, an unauthenticated or stale profile fails and must not be driven.

The last verified `pdi` doctor run found an authenticated, verified profile for `dev354702.service-now.com`. It is not marked read-only, so use it only for explicitly read-only commands in this kitchen. Do not refresh credentials, log in, mutate records, or use mutation-capable commands unless a disposable profile is separately established and the mutation has an explicit approval.

Runtime references only:

- Config file: `~/.config/servicenow/config.json`, or the `XDG_CONFIG_HOME` equivalent.
- Profile name: `pdi` is the known local profile. Confirm it with `jsn auth status --json`.
- Credential source: the OS keyring or the configured auth backend. Never copy it into this repository.
- Optional environment controls used by tests: `JSN_NO_VERSION_CHECK=1`, `JSN_NO_SKILL_CHECK=1`.

## Drive

The safe, end-to-end lane uses the Rails documentation REST service. It contacts no ServiceNow instance:

```bash
JSN_DOCS_URL=http://localhost:3000 node .agents/skills/verify/scripts/verify-jsn.mjs drive --query GlideRecord
```

The helper captures both machine-readable JSON and human-readable Markdown output. The underlying commands are existing JSN commands:

```bash
node cli/bin/jsn.js docs status --json
node cli/bin/jsn.js docs search "GlideRecord" --limit 3 --json
node cli/bin/jsn.js docs search "GlideRecord" --limit 3 --markdown
```

For an authenticated disposable profile only, use existing read-only commands and run the doctor again immediately before driving:

```bash
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile <disposable-read-only-profile>
node cli/bin/jsn.js --profile <disposable-read-only-profile> records list --table incident --limit 3 --columns number,short_description --json
node cli/bin/jsn.js --profile <disposable-read-only-profile> rest --method GET --table incident --query "sysparm_limit=3" --json
```

Never substitute `eval`, `create`, `update`, `delete`, `bulk --execute`, or a non-read-only REST method for this lane.

## Feature map

Read `features/README.md` first. It maps records, profile/auth status, command discovery, and raw REST to user-visible entry points and proof checks. The docs drive uses the local Rails site; it must be running with a published index.

## Evidence

Evidence goes under `.verification/evidence/` and survives cleanup. Each run writes:

- `doctor-<timestamp>.json`, containing only selected non-secret fields and command exit codes.
- `drive-<timestamp>.json`, containing the JSON and human-readable docs-search outputs.
- `manifest-<timestamp>.json`, listing the files and checks performed.

Treat these files as local run artifacts. Do not add credentials, cookies, private config, or raw environment dumps. Review evidence for secret-like fields before sharing it.

## Cleanup

The helper has no long-lived process. After every run, including failed runs, execute:

```bash
node .agents/skills/verify/scripts/verify-jsn.mjs cleanup
```

Cleanup removes only helper scratch state. It does not remove evidence. For an instance-backed experiment, delete only records created by that experiment, verify they are gone, and never clean up by process name or broad table deletion. No mutation path is enabled by this skill until a disposable ServiceNow profile is established.

## Helper

The helper is executable and owns redaction, evidence capture, exit-code checks, and cleanup:

```bash
node .agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi --allow-unauthenticated
JSN_DOCS_URL=http://localhost:3000 node .agents/skills/verify/scripts/verify-jsn.mjs drive --query GlideRecord
node .agents/skills/verify/scripts/verify-jsn.mjs cleanup
```

A successful hosted-docs proof requires the doctor result, one JSON drive result, one human-readable drive result, evidence surviving cleanup, and no secret-like keys in the evidence files.
