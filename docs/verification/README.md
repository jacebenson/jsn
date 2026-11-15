# Verification

Run `npm ci --prefix cli`, `npm test`, and `npm run lint` from the repository root. Tests need no live instance. Integration tests are separate opt-in tests that can mutate records.

## Local checks

The generic helper remains executable without agent skill discovery:

```sh
node cli/scripts/verify-jsn.mjs doctor --profile <read-only-profile>
JSN_DOCS_URL=http://localhost:3000 node cli/scripts/verify-jsn.mjs drive --query GlideRecord
node cli/scripts/verify-jsn.mjs cleanup
```

For documentation-only checks, doctor accepts `--allow-unauthenticated`. Start the Rails documentation service with a published index before the docs drive. Local evidence under `.verification/evidence/` survives cleanup. Review it before sharing: the local doctor includes selected profile and hostname metadata. Never upload private profiles or credentials. See [feature checks](features/README.md).

## GitHub read-only verification

The **Verify selected instance** workflow is manual only. It reads one `sys_db_object` metadata row for `name=incident`, requests only `name`, and disables counts. It does not run the mutation integration suite, publish acceptance results, deploy, or upload artifacts. Output is a closed summary containing target, status, and on success check and record counts. Raw command output, error messages, hosts, users, tokens and records are not printed.

In GitHub, open **Settings → Environments → New environment**. Create any of these exact names as needed:

- `pdi`
- `vendor-1`
- `vendor-2`

Each uses the same schema. Under **Environment secrets**, add:

| Secret | Value entered in GitHub only |
| --- | --- |
| `JSN_INSTANCE_URL` | HTTPS instance origin, for example `https://example.service-now.com`, with no path, query, fragment or embedded credentials |
| `JSN_OAUTH_TOKEN` | Valid OAuth access token for that instance, with permission to read the incident table's `sys_db_object` metadata |

Under **Environment variables**, add `JSN_VERIFY_ENABLED` with value `true`. Leave it unset or set it to `false` to disable the target. Use environment-scoped secrets, not repository-wide duplicates. Restrict deployment branches to the repository default branch and configure required reviewers where available. Only trusted maintainers should be able to approve runs or change default-branch code. No secrets belong in chat, commits, `.env` files, workflow inputs, or PR comments.

The credential method is the existing `SERVICENOW_OAUTH_TOKEN` path in `cli/src/auth.js`, paired with `SERVICENOW_INSTANCE_URL` in `cli/src/config.js`. The runner maps the two secrets to these supported variables for a noninteractive CLI subprocess. It does not invent profile JSON, save auth, refresh tokens or use a personal keyring. Expired tokens must be replaced in GitHub. Basic auth and browser cookies are not part of this workflow.

After this workflow reaches the default branch, open **Actions → Verify selected instance → Run workflow**, choose the default branch and exactly one `target`. Feature-branch dispatches cannot enter the secret-bearing job. The checkout is the dispatch's immutable default-branch SHA, with checkout credential persistence disabled. Dependencies install before secrets enter the verification step, without lifecycle scripts or caches. The CLI runs in a temporary isolated working directory with allowlisted environment variables; the directory is removed even on failure.

Only the selected environment needs configuration. A missing, disabled or offline PDI does not block a vendor run or pull-request CI. A disabled or unconfigured selected target exits nonzero, as do unreachable instances, invalid responses, denied credentials and missing metadata. These are not passing verification. Authentication/provider errors print only fixed status labels, never provider-supplied details. Network errors are `unavailable`; other provider failures may use `provider_failed` or `invalid_response`. The subprocess has a 45-second bound and the job a five-minute bound. No automatic retry or silent skip is treated as success.

For an ephemeral PDI replacement, edit **Settings → Environments → pdi** and replace both secrets together with the new origin and matching access token. Enable it only when ready. To retire it, set `JSN_VERIFY_ENABLED=false` and remove its secrets in GitHub. Rotate vendor tokens in their own environments the same way. No remote environments or secrets are created by repository scripts.

This lane is separate from the existing acceptance/publication workflow and its opt-in write authorization. Adding these three environments does not configure or trigger that workflow.

## Historical evidence and identifiers

Recorded outcomes and exit codes are historical, not new live validation. Observed instance hostnames and personal demo/profile labels have been replaced with `example` placeholders. Opaque progress identifiers in copied live URLs are redacted. Generic `sys_id` API contracts, fixture IDs, public documentation domains and synthetic test hosts remain intentionally. Redaction does not establish that a former instance is available or authenticated now.
