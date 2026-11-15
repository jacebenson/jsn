# Profiles and auth status

## Sub-features

`auth status` reports configured profiles, selected/default state, auth method, probe state, and read-only settings. `auth switch` changes the active local profile and is a local configuration mutation, so the kitchen does not run it automatically.

## How to get to it (user POV)

Run `node bin/jsn.js --profile pdi auth status --json`, or use the helper:

```bash
node cli/.agents/skills/verify/scripts/verify-jsn.mjs doctor --profile pdi --allow-unauthenticated
```

## Driving it with the JSN CLI

The doctor checks the installed package version against the running binary, selects the requested profile, reduces the instance to a hostname, and records auth state and method. It never prints credential values.

## Gotchas

`authenticated: false` is a real result, not a pass to refresh or log in. The current `pdi` OAuth state is stale. Keep profile names and environment variable names as references only. Secrets stay in the OS keyring or the user's config outside the repository.
