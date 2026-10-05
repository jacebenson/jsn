# JSN current state

## Verified in this branch

- The repository is a Node.js ESM CLI with no build step.
- `bin/jsn.js` is the executable entry point and `src/cli.js` registers the command surface.
- The project-local verification kitchen lives under `.agents/skills/verify/`.
- Verification evidence belongs under `.verification/evidence/` and must not contain credentials or raw environment dumps.
- The local documentation fixture provides the safe, instance-free drive for documentation status and search.

## Known limits

- Live records and raw REST proof require a disposable read-only ServiceNow profile.
- Integration tests can mutate ServiceNow data and are not part of the default local proof.
- Runtime credentials stay outside the repository in the configured auth backend.

## Update rule

Update this file when a durable project fact changes. Do not turn it into a daily activity log. Record why a durable choice exists in `docs/DECISIONS.md`.
