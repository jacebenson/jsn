# Verification

Run `npm ci --prefix cli`, `npm test`, and `npm run lint` from the repository root. Tests need no live instance. Integration tests are separate opt-in tests that can mutate records.

## Local checks

The generic helper remains executable without agent skill discovery:

```sh
node cli/scripts/verify-jsn.mjs doctor --profile <read-only-profile>
JSN_DOCS_URL=http://localhost:3000 node cli/scripts/verify-jsn.mjs drive --query GlideRecord
node cli/scripts/verify-jsn.mjs cleanup
```

For documentation-only checks, doctor accepts `--allow-unauthenticated`. Start the Rails documentation service with a published index before the docs drive. Local evidence under `.verification/evidence/` survives cleanup. Review it before sharing: the local doctor includes selected profile and hostname metadata. Never upload private profiles or credentials. Use the [feature map](../FEATURE_MAP.md) to choose a surface, then read its installed command help and the [CLI guide](../cli-guide.md).

## Historical captures

The reports and capture files below this directory record their original revisions,
commands and outcomes. They do not establish current authentication, supported
commands or fresh test results. Some scripts predate the `cli/` layout; inspect
paths and safeguards before reusing them. Legacy website redirects still target
specific reports. Keep those reports and their referenced JSON, logs, HTML and
screenshots together when removing unrelated receipts.

## GitHub read-only verification

The **Verify selected instance** workflow invokes `.github/scripts/verify-instance.mjs`, sharing `.github/scripts/oauth-environment.mjs` with acceptance. These GitHub-only helpers are not shipped in npm; the reusable local `cli/scripts/verify-jsn.mjs` helper stays separate. The workflow is manual only. It reads one `sys_db_object` metadata row for `name=incident`, requests only `name`, and disables counts. It does not run the mutation integration suite, publish acceptance results, deploy, or upload artifacts. Output is a closed summary containing target, status, and on success check and record counts. Raw command output, error messages, hosts, users, tokens and records are not printed.

In GitHub, open **Settings → Environments → New environment**. Create any of these exact names as needed:

- `pdi`
- `vendor-1`
- `vendor-2`

Each uses the same schema. Under **Environment secrets**, add:

| Secret | Value entered in GitHub only |
| --- | --- |
| `JSN_OAUTH_REFRESH_TOKEN` | Refresh token from the instance's authorized JSN public-client OAuth login |
| `JSN_OAUTH_TOKEN` | Optional legacy access token, used only if refresh token is absent; must still authenticate |

Under **Environment variables**, add `JSN_INSTANCE_URL`: the HTTPS instance origin, for example `https://example.service-now.com`, with no path, query, fragment or embedded credentials. Variables are visible in GitHub settings and are not masked in workflow logs. Keep both OAuth tokens as secrets. Optionally set `JSN_OAUTH_CLIENT_ID` to the client used for login; otherwise the helper reuses the current JSN source default from `getOAuthClientID()`. No client secret is required by this public PKCE flow.

Also add the environment variable `JSN_VERIFY_ENABLED` with value `true`. Leave it unset or set it to `false` to disable the target. Use environment-scoped secrets, not repository-wide duplicates. Restrict deployment branches to the repository default branch and configure required reviewers where available. Only trusted maintainers should be able to approve runs or change default-branch code. No secrets belong in chat, commits, `.env` files, workflow inputs, or PR comments.

The shared helper first refreshes in memory with a bounded 15-second form POST to the validated HTTPS origin `/oauth_token.do` (no redirects), then passes the access token to the existing `SERVICENOW_OAUTH_TOKEN` CLI path. The form uses `grant_type=refresh_token`, `client_id`, and `refresh_token`; no client secret or PKCE verifier. A configured refresh failure fails closed without falling back to the old access token. With no refresh secret, a legacy access token can still pass a real authenticated check. Success identifies the credential source. No personal keyring, stored profile, credential output or cross-step token transfer is used. Basic auth and browser cookies are not part of this workflow.

A different refresh token in the response triggers a fixed warning: its replacement is not persisted. The current run uses the new access token, but the next run may require secure replacement of the environment secret. Rotation behavior is not live-verified. Refresh tokens also expire or can be revoked; local refresh may invalidate a copied GitHub secret. This does not promise indefinitely unattended renewal or request a settings-write PAT. See [refresh semantics](../acceptance-ci.md#configuration).

After this workflow reaches the default branch, open **Actions → Verify selected instance → Run workflow**, choose the default branch and exactly one `target`. Feature-branch dispatches cannot enter the secret-bearing job. The checkout is the dispatch's immutable default-branch SHA, with checkout credential persistence disabled. Dependencies install before secrets enter the verification step, without lifecycle scripts or caches. The CLI runs in a temporary isolated working directory with allowlisted environment variables; the directory is removed even on failure.

Only the selected environment needs configuration. A missing, disabled or offline PDI does not block a vendor run or pull-request CI. A disabled or unconfigured selected target exits nonzero, as do unreachable instances, invalid responses, denied credentials and missing metadata. These are not passing verification. Authentication/provider errors print only fixed status labels, never provider-supplied details. Network errors are `unavailable`; other provider failures may use `provider_failed` or `invalid_response`. The subprocess has a 45-second bound and the job a five-minute bound. No automatic retry or silent skip is treated as success.

For an ephemeral PDI replacement, edit **Settings → Environments → pdi** and replace the `JSN_INSTANCE_URL` variable and matching `JSN_OAUTH_REFRESH_TOKEN` secret (and legacy `JSN_OAUTH_TOKEN`, if retained) together. Enable it only when ready. To retire it, set `JSN_VERIFY_ENABLED=false` and remove its secrets in GitHub. Rotate vendor tokens in their own environments the same way. No remote environments or secrets are created by repository scripts.

This one-record smoke test remains manual and separate from the [live acceptance suite](../acceptance-ci.md). Acceptance reuses the selected environment's URL, enabled flag and OAuth secret, plus repository-scoped publication settings. Main pushes and releases independently attempt both vendors; manual acceptance offers both or any single target. The retired `JSN_ACCEPTANCE_TARGET` variable is ignored. Acceptance defaults to readonly. An instance alone does not configure publication. Mutation acceptance is PDI-only and additionally requires explicit approval and verified environment reviewers.

## Historical evidence and identifiers

Recorded outcomes and exit codes are historical, not new live validation. Observed instance hostnames and personal demo/profile labels have been replaced with `example` placeholders. Opaque progress identifiers in copied live URLs are redacted. Generic `sys_id` API contracts, fixture IDs, public documentation domains and synthetic test hosts remain intentionally. Redaction does not establish that a former instance is available or authenticated now.
